from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

from .models import RecordingResponse, SetupStep
from .provider import BrowserProvider, BrowserSession
from .security import safe_public_url, url_origin

MAX_STEPS = 200
MAX_FIELD_LENGTH = 2000
BLOCKED_REASON = "Credentials and one-time codes cannot be taught yet."
CAPTURE_LIMIT_REASON = "The demonstration reached the 200-step capture limit. Start a shorter demonstration."
logger = logging.getLogger(__name__)


ACTIVE = {"awaiting_login", "verifying_login", "recording"}


class RecordingConflict(ValueError):
    pass


class InvalidRecordingUrl(ValueError):
    """Raised only for a recording URL rejected before a provider is contacted."""


@dataclass(frozen=True)
class RecordingOwner:
    organization: str
    email: str


@dataclass
class Recording:
    id: str
    owner: RecordingOwner
    expires_at: datetime
    status: Literal["awaiting_login", "verifying_login", "recording", "stopped", "expired"] = "recording"
    browser: BrowserSession | None = None
    login_browser: BrowserSession | None = None
    private_login: bool = False
    start_url: str = ""
    prepared_url: str | None = None
    idempotency_key: str | None = None
    operation_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    steps: list[SetupStep] = field(default_factory=list)
    blocked_reason: str | None = None
    last_input_key: str | None = None
    close_requested: Literal["stopped", "expired"] | None = None
    closing: bool = False
    creating: bool = True
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class RecordingService:
    def __init__(self, provider: BrowserProvider, *, timeout_seconds: int = 900, max_sessions: int = 100) -> None:
        self.provider = provider
        self.timeout_seconds = min(max(timeout_seconds, 1), 900)
        self.max_sessions = max(max_sessions, 1)
        self._recordings: OrderedDict[str, Recording] = OrderedDict()
        self._closed = False
        self._pending_close: list[BrowserSession] = []

    async def create(
        self, owner: RecordingOwner, start_url: str, *, private_login: bool = False, idempotency_key: str | None = None
    ) -> Recording:
        if self._closed:
            raise RuntimeError("Recording service is shutting down.")
        safe_url = safe_public_url(start_url)
        if safe_url is None:
            raise InvalidRecordingUrl("The recording URL must be a public HTTP(S) URL.")
        await self.cleanup()
        if idempotency_key:
            for previous in self._recordings.values():
                if previous.owner == owner and previous.idempotency_key == idempotency_key:
                    if previous.start_url != safe_url or previous.private_login != private_login:
                        raise RecordingConflict("Idempotency key was used for another request.")
                    if previous.creating:
                        raise RecordingConflict("Recording creation is in progress.")
                    return previous
        self._evict_completed()
        if len(self._recordings) >= self.max_sessions:
            raise RuntimeError("Recording capacity is full. Stop an existing recording first.")

        recording = Recording(
            id=str(uuid4()),
            private_login=private_login,
            start_url=safe_url,
            status="awaiting_login" if private_login else "recording",
            idempotency_key=idempotency_key,
            owner=owner,
            expires_at=datetime.now(UTC) + timedelta(seconds=self.timeout_seconds),
        )
        self._recordings[recording.id] = recording

        async def on_event(event: dict[str, Any]) -> None:
            await self.record_event(recording.id, event)

        try:
            browser = (
                await self.provider.create_private(safe_url)
                if private_login
                else await self.provider.create(safe_url, on_event)
            )
            if await self._attach_browser(recording, browser):
                raise RuntimeError("Recording stopped before the browser became available.")
            if not private_login:
                await self.record_event(recording.id, {"type": "navigation", "url": safe_url})
            return recording
        except BaseException:
            recording.creating = False
            if recording.browser is None and recording.close_requested:
                recording.status = recording.close_requested
                recording.close_requested = None
            if recording.browser is None and recording.close_requested is None:
                self._recordings.pop(recording.id, None)
            raise

    async def private_view(self, recording_id: str, owner: RecordingOwner) -> str | None:
        recording = await self.get(recording_id, owner)
        if recording is None:
            raise KeyError(recording_id)
        if recording.status not in {"awaiting_login", "verifying_login"} or recording.close_requested:
            raise RecordingConflict("Private view is unavailable in this state.")
        return recording.browser.live_view_url if recording.browser else None

    async def prepare(self, recording_id: str, owner: RecordingOwner, url: str) -> Recording:
        recording = await self.get(recording_id, owner)
        if recording is None:
            raise KeyError(recording_id)
        if safe_public_url(url) != url or url_origin(url) != url_origin(recording.start_url):
            raise InvalidRecordingUrl("Use an exact public URL on the approved origin without query or fragment.")
        async with recording.operation_lock:
            if recording.prepared_url == url and recording.status in {"verifying_login", "recording"}:
                return recording
            if recording.status != "awaiting_login" or recording.close_requested or not recording.browser:
                raise RecordingConflict("Recording is not awaiting login.")
            login = recording.browser
            try:
                fresh = await self.provider.prepare(login, url)
                async with recording.lock:
                    recording.login_browser = login
                if await self._attach_browser(recording, fresh):
                    raise RecordingConflict("Recording ended while preparing.")
                async with recording.lock:
                    if recording.status != "awaiting_login" or recording.close_requested:
                        raise RecordingConflict("Recording ended while preparing.")
                    recording.prepared_url = url
                    recording.status = "verifying_login"
                return recording
            except BaseException:
                await self._stop(recording, expired=datetime.now(UTC) >= recording.expires_at)
                raise

    async def activate(self, recording_id: str, owner: RecordingOwner) -> Recording:
        recording = await self.get(recording_id, owner)
        if recording is None:
            raise KeyError(recording_id)
        async with recording.operation_lock:
            if recording.private_login and recording.status == "recording" and not recording.close_requested:
                return recording
            if recording.status != "verifying_login" or recording.close_requested or not recording.browser:
                raise RecordingConflict("Verify the fresh private session before activating.")

            async def on_event(event: dict[str, Any]) -> None:
                await self.record_event(recording.id, event)

            try:
                if recording.login_browser is not None:
                    await recording.login_browser.close()
                    recording.login_browser = None
                await recording.browser.activate(on_event)
                async with recording.lock:
                    if (
                        recording.status != "verifying_login"
                        or recording.close_requested
                        or datetime.now(UTC) >= recording.expires_at
                    ):
                        raise RecordingConflict("Recording ended while activating.")
                    recording.steps.clear()
                    recording.last_input_key = None
                    recording.status = "recording"
                await self.record_event(recording.id, {"type": "navigation", "url": recording.prepared_url})
                return recording
            except BaseException:
                await self._stop(recording, expired=datetime.now(UTC) >= recording.expires_at)
                raise

    async def get(self, recording_id: str, owner: RecordingOwner) -> Recording | None:
        await self.cleanup()
        recording = self._recordings.get(recording_id)
        if recording is None or recording.owner != owner:
            return None
        return recording

    async def stop(self, recording_id: str, owner: RecordingOwner) -> Recording | None:
        recording = await self.get(recording_id, owner)
        if recording is None:
            return None
        await self._stop(recording, expired=False)
        return recording

    async def delete(self, recording_id: str, owner: RecordingOwner) -> bool:
        recording = await self.get(recording_id, owner)
        if recording is None:
            return False
        await self._stop(recording, expired=False)
        self._recordings.pop(recording_id, None)
        return True

    async def record_event(self, recording_id: str, event: dict[str, Any]) -> None:
        recording = self._recordings.get(recording_id)
        if recording is None:
            return
        async with recording.lock:
            if (
                recording.status != "recording"
                or recording.closing
                or recording.blocked_reason is not None
                or datetime.now(UTC) >= recording.expires_at
            ):
                return
            if (
                recording.private_login
                and event.get("type") == "navigation"
                and url_origin(event.get("url", "")) != url_origin(recording.start_url)
            ):
                return
            if event.get("secret") is True:
                recording.blocked_reason = BLOCKED_REASON
                return
            step = _to_step(event)
            if step is None:
                return
            input_key = _text(event.get("targetKey"), maximum=512) or step.target
            if step.type == "input" and recording.steps:
                previous = recording.steps[-1]
                if previous.type == "input" and recording.last_input_key == input_key:
                    recording.steps[-1] = step.model_copy(update={"id": previous.id})
                    return
            if step.type == "navigation" and recording.steps and recording.steps[-1].url == step.url:
                return
            if len(recording.steps) >= MAX_STEPS:
                recording.blocked_reason = CAPTURE_LIMIT_REASON
                return
            recording.steps.append(step)
            recording.last_input_key = input_key if step.type == "input" else None

    async def cleanup(self) -> None:
        for browser in list(self._pending_close):
            try:
                await browser.close()
                self._pending_close.remove(browser)
            except Exception:
                logger.warning("recording_detached_close_failed")
        now = datetime.now(UTC)
        for recording in list(self._recordings.values()):
            if recording.status not in ACTIVE:
                continue
            requested = recording.close_requested
            if requested is None and now < recording.expires_at:
                continue
            try:
                await self._stop(recording, expired=requested == "expired" if requested else True)
            except Exception:
                logger.warning("recording_cleanup_close_failed")

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self.cleanup()
        for recording in list(self._recordings.values()):
            try:
                await self._stop(recording, expired=recording.status in ACTIVE)
            except Exception:
                logger.warning("recording_shutdown_close_failed")

    def _evict_completed(self) -> None:
        while len(self._recordings) >= self.max_sessions:
            recording_id, oldest = next(iter(self._recordings.items()))
            if oldest.status in ACTIVE:
                return
            self._recordings.pop(recording_id)

    async def _stop(self, recording: Recording, *, expired: bool) -> None:
        async with recording.lock:
            if recording.status not in ACTIVE:
                return
            if recording.closing:
                raise RuntimeError("Recording close is already in progress.")
            if recording.close_requested is None:
                recording.close_requested = "expired" if expired else "stopped"
            browser = recording.browser
            if browser is None:
                if recording.creating:
                    raise RuntimeError("Recording browser is still starting.")
                recording.status = recording.close_requested
                recording.close_requested = None
                return
            recording.closing = True
        try:
            browsers = [browser]
            if recording.login_browser is not None and recording.login_browser is not browser:
                browsers.append(recording.login_browser)
            results = await asyncio.gather(*(item.close() for item in browsers), return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException):
                    raise result
        except BaseException:
            async with recording.lock:
                recording.closing = False
            raise
        async with recording.lock:
            recording.browser = None
            recording.login_browser = None
            recording.status = recording.close_requested or ("expired" if expired else "stopped")
            recording.close_requested = None
            recording.closing = False

    async def _attach_browser(self, recording: Recording, browser: BrowserSession) -> bool:
        """Attach a newly created browser only while its recording remains live."""
        close_detached_browser = False
        stop_after_attach = False
        async with recording.lock:
            recording.creating = False
            if self._closed or self._recordings.get(recording.id) is not recording:
                close_detached_browser = True
            elif recording.status not in ACTIVE:
                close_detached_browser = True
            else:
                recording.browser = browser
                if recording.close_requested is None and datetime.now(UTC) >= recording.expires_at:
                    recording.close_requested = "expired"
                stop_after_attach = recording.close_requested is not None
        if close_detached_browser:
            try:
                await browser.close()
            except BaseException:
                self._pending_close.append(browser)
                raise
            return True
        if not stop_after_attach:
            return False
        await self._stop(recording, expired=recording.close_requested == "expired")
        return True

    @staticmethod
    def response(recording: Recording) -> RecordingResponse:
        live_view_url = None
        if recording.status == "recording" and recording.browser and not recording.close_requested:
            live_view_url = recording.browser.live_view_url
        return RecordingResponse(
            id=recording.id,
            status=recording.status,
            live_view_url=live_view_url,
            steps=recording.steps,
            expires_at=recording.expires_at,
            blocked_reason=recording.blocked_reason,
        )


def _text(value: Any, *, maximum: int = MAX_FIELD_LENGTH) -> str | None:
    if not isinstance(value, str):
        return None
    clipped = value[:maximum]
    return clipped or None


def _to_step(event: dict[str, Any]) -> SetupStep | None:
    event_type = event.get("type")
    if event_type not in {"navigation", "click", "input", "select_change", "key_press", "scroll", "agent"}:
        return None
    target = _text(event.get("target"), maximum=240)
    value = None if event_type in {"input", "select_change"} else _text(event.get("value"))
    url = safe_public_url(event.get("url", "")) if event_type == "navigation" else None
    if event_type == "navigation" and url is None:
        return None
    description = _description(
        event_type,
        target=target,
        value=value,
        url=url,
        supplied=_text(event.get("description"), maximum=300),
    )
    return SetupStep(
        id=str(uuid4()),
        type=event_type,
        description=description,
        target=target,
        value=value,
        url=url,
        expected_outcome=_text(event.get("expectedOutcome"), maximum=300),
    )


def _description(
    event_type: str, *, target: str | None, value: str | None, url: str | None, supplied: str | None
) -> str:
    if supplied:
        return supplied
    if event_type == "navigation":
        host = url.split("/", 3)[2] if url else "page"
        return f"Open {host}"
    if event_type == "click":
        return f"Click {target or 'element'}"
    if event_type == "input":
        return f"Enter {target or 'text'}"
    if event_type == "select_change":
        return f"Choose {value or 'option'} in {target or 'menu'}"
    if event_type == "key_press":
        return f"Press {value or 'key'}"
    if event_type == "scroll":
        return f"Scroll {value or 'page'}"
    return "Agent action"
