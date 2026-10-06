from __future__ import annotations

import asyncio
import os
import secrets
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from typing import Annotated, Any, AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Response, status
from fastapi.responses import JSONResponse

from .models import CreateRecordingRequest, RecordingResponse, StoppedRecordingResponse
from .organize import OpenAIStepOrganizer, StepOrganizer
from .provider import BrowserbaseProvider, BrowserProvider
from .service import InvalidRecordingUrl, RecordingOwner, RecordingService

SERVICE_UNAVAILABLE = "Recording service is temporarily unavailable."


@dataclass(frozen=True)
class RecordingConfig:
    service_key: str
    timeout_seconds: int = 900
    max_sessions: int = 100

    def __post_init__(self) -> None:
        if not self.service_key:
            raise ValueError("WORKFLOW_USE_SERVICE_KEY is required.")
        if not 1 <= self.timeout_seconds <= 900:
            raise ValueError("timeout_seconds must be between 1 and 900.")


def create_app(provider: BrowserProvider, config: RecordingConfig, organizer: StepOrganizer | None = None) -> FastAPI:
    service = RecordingService(
        provider, timeout_seconds=config.timeout_seconds, max_sessions=config.max_sessions, organizer=organizer
    )
    cleanup_task: asyncio.Task[None] | None = None

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        nonlocal cleanup_task

        async def sweep() -> None:
            while True:
                await asyncio.sleep(5)
                await service.cleanup()

        cleanup_task = asyncio.create_task(sweep())
        try:
            yield
        finally:
            if cleanup_task is not None:
                cleanup_task.cancel()
                with suppress(asyncio.CancelledError):
                    await cleanup_task
            await service.close()

    app = FastAPI(title="Workflow Use recording", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    async def owner(
        workflow_key: Annotated[str | None, Header(alias="X-Workflow-Key")] = None,
        organization: Annotated[str | None, Header(alias="x-organization")] = None,
        email: Annotated[str | None, Header(alias="x-user-email")] = None,
    ) -> RecordingOwner:
        if workflow_key is None or not secrets.compare_digest(workflow_key, config.service_key):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized.")
        if not organization or not email:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Tenant and user are required.")
        return RecordingOwner(organization=organization, email=email)

    @app.post("/recordings", response_model=RecordingResponse, status_code=201)
    async def create_recording(
        request: CreateRecordingRequest, recording_owner: RecordingOwner = Depends(owner)
    ) -> JSONResponse:
        try:
            recording = await service.create(recording_owner, request.url)
        except InvalidRecordingUrl as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        return _response(service.response(recording), status_code=status.HTTP_201_CREATED)

    @app.get("/recordings/{recording_id}", response_model=RecordingResponse)
    async def get_recording(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> JSONResponse:
        try:
            recording = await service.get(recording_id, recording_owner)
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        if recording is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Recording is unavailable. It may have expired or the service restarted.",
            )
        return _response(service.response(recording))

    @app.post("/recordings/{recording_id}/stop", response_model=StoppedRecordingResponse)
    async def stop_recording(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> JSONResponse:
        try:
            recording = await service.stop(recording_id, recording_owner)
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        if recording is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")
        # Only the stop response carries captured sign-in values, once; the host stores them encrypted.
        credentials = service.take_credentials(recording)
        response = _response(service.response(recording), credentials=credentials or None)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.delete("/recordings/{recording_id}", status_code=204)
    async def delete_recording(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> Response:
        try:
            deleted = await service.delete(recording_id, recording_owner)
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        if not deleted:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.post("/recordings/{recording_id}/google-context")
    async def claim_google_context(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> JSONResponse:
        try:
            context_id = await service.claim_google_context(recording_id, recording_owner)
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        if context_id is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")
        if not context_id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="google_context_unavailable")
        return JSONResponse(content={"contextId": context_id}, headers={"Cache-Control": "no-store"})

    @app.post("/recordings/{recording_id}/google-context/adopted", status_code=204)
    async def adopt_google_context(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> Response:
        try:
            adopted = await service.adopt_google_context(recording_id, recording_owner)
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        if adopted is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")
        if not adopted:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="google_context_unavailable")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.post("/recordings/{recording_id}/google-context/returned", status_code=204)
    async def return_google_context(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> Response:
        try:
            returned = await service.return_google_context(recording_id, recording_owner)
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        if returned is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")
        if not returned:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="google_context_unavailable")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return app


def _response(
    recording: RecordingResponse,
    *,
    status_code: int = status.HTTP_200_OK,
    credentials: dict[str, str] | None = None,
) -> JSONResponse:
    body = recording.model_dump(mode="json", by_alias=True)
    body["steps"] = [_step_body(step) for step in recording.steps]
    if credentials:
        body["credentials"] = credentials
    return JSONResponse(status_code=status_code, content=body)


def _step_body(step: Any) -> dict[str, Any]:
    body = step.model_dump(mode="json", by_alias=True, exclude_none=True)
    if step.date is not None:
        body["date"] = step.date.model_dump(mode="json", exclude_none=False)
    return body


def create_default_app() -> FastAPI:
    key = os.environ.get("WORKFLOW_USE_SERVICE_KEY")
    if not key:
        raise RuntimeError("WORKFLOW_USE_SERVICE_KEY is required.")
    return create_app(
        BrowserbaseProvider(region=os.environ.get("BROWSERBASE_REGION", "eu-central-1")),
        RecordingConfig(service_key=key),
        # Without a key the steps stay as recorded: one per action, with no stages.
        OpenAIStepOrganizer() if os.environ.get("OPENAI_API_KEY") else None,
    )


app = create_default_app() if os.environ.get("WORKFLOW_USE_SERVICE_KEY") else FastAPI()
