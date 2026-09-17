from __future__ import annotations

import asyncio
import os
import secrets
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from typing import Annotated, AsyncIterator

from fastapi import Depends, FastAPI, Header, HTTPException, Response, status
from fastapi.responses import JSONResponse

from .models import CreateRecordingRequest, PrepareRecordingRequest, PrivateViewResponse, RecordingResponse
from .provider import BrowserbaseProvider, BrowserProvider
from .service import InvalidRecordingUrl, RecordingConflict, RecordingOwner, RecordingService

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


def create_app(provider: BrowserProvider, config: RecordingConfig) -> FastAPI:
    service = RecordingService(provider, timeout_seconds=config.timeout_seconds, max_sessions=config.max_sessions)
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
        request: CreateRecordingRequest,
        recording_owner: RecordingOwner = Depends(owner),
        idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)] = None,
    ) -> JSONResponse:
        try:
            recording = await service.create(
                recording_owner, request.url, private_login=request.private_login, idempotency_key=idempotency_key
            )
        except RecordingConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except InvalidRecordingUrl as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        return _response(service.response(recording), status_code=status.HTTP_201_CREATED)

    async def private_action(action):
        try:
            return await action
        except KeyError:
            raise HTTPException(status_code=404, detail="Recording not found.") from None
        except RecordingConflict as error:
            raise HTTPException(status_code=409, detail=str(error)) from error
        except InvalidRecordingUrl as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        except Exception:
            raise HTTPException(status_code=503, detail=SERVICE_UNAVAILABLE) from None

    @app.get("/recordings/{recording_id}/private-view", response_model=PrivateViewResponse)
    async def private_view(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> JSONResponse:
        url = await private_action(service.private_view(recording_id, recording_owner))
        return JSONResponse(content={"liveViewUrl": url}, headers={"Cache-Control": "no-store"})

    @app.post("/recordings/{recording_id}/prepare", response_model=RecordingResponse)
    async def prepare(
        recording_id: str, request: PrepareRecordingRequest, recording_owner: RecordingOwner = Depends(owner)
    ) -> JSONResponse:
        recording = await private_action(service.prepare(recording_id, recording_owner, request.url))
        return _response(service.response(recording))

    @app.post("/recordings/{recording_id}/activate", response_model=RecordingResponse)
    async def activate(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> JSONResponse:
        recording = await private_action(service.activate(recording_id, recording_owner))
        return _response(service.response(recording))

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

    @app.post("/recordings/{recording_id}/stop", response_model=RecordingResponse)
    async def stop_recording(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> JSONResponse:
        try:
            recording = await service.stop(recording_id, recording_owner)
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        if recording is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")
        return _response(service.response(recording))

    @app.delete("/recordings/{recording_id}", status_code=204)
    async def delete_recording(recording_id: str, recording_owner: RecordingOwner = Depends(owner)) -> Response:
        try:
            deleted = await service.delete(recording_id, recording_owner)
        except Exception:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=SERVICE_UNAVAILABLE) from None
        if not deleted:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Recording not found.")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return app


def _response(recording: RecordingResponse, *, status_code: int = status.HTTP_200_OK) -> JSONResponse:
    body = recording.model_dump(mode="json", by_alias=True)
    body["steps"] = [step.model_dump(mode="json", by_alias=True, exclude_none=True) for step in recording.steps]
    return JSONResponse(status_code=status_code, content=body, headers={"Cache-Control": "no-store"})


def create_default_app() -> FastAPI:
    key = os.environ.get("WORKFLOW_USE_SERVICE_KEY")
    if not key:
        raise RuntimeError("WORKFLOW_USE_SERVICE_KEY is required.")
    return create_app(
        BrowserbaseProvider(region=os.environ.get("BROWSERBASE_REGION", "eu-central-1")),
        RecordingConfig(service_key=key),
    )


app = create_default_app() if os.environ.get("WORKFLOW_USE_SERVICE_KEY") else FastAPI()
