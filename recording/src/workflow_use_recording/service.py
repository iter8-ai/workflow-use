from __future__ import annotations

import asyncio
import logging
import re
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import uuid4

from .models import RecordingResponse, SetupStep
from .provider import BrowserProvider, BrowserSession
from .security import safe_public_url

MAX_STEPS = 200
MAX_FIELD_LENGTH = 2000
CREDENTIAL_KINDS = frozenset({"username", "password", "otp"})
# Backstop for the page script: typing into a field labelled like a secret never keeps the text.
_SECRET_TARGETS = (
    (re.compile(r"one.?time|\botp\b|passcode|verification.?code|2fa|mfa|authenticator", re.I), "otp"),
    (re.compile(r"user.?name", re.I), "username"),
    (
        re.compile(
            r"pass.?word|pass.?phrase|api.?key|\bauth\b|credential|jwt|secret|token|\bpin\b|security.?answer|cvv|cvc|card.?number",
            re.I,
        ),
        "password",
    ),
)
STEP_TYPES = frozenset({"navigation", "click", "input", "credential", "select_change", "key_press", "scroll", "agent"})
CAPTURE_LIMIT_REASON = "The demonstration reached the 200-step capture limit. Start a shorter demonstration."
logger = logging.getLogger(__name__)


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
    status: Literal["recording", "stopped", "expired"] = "recording"
    browser: BrowserSession | None = None
    steps: list[SetupStep] = field(default_factory=list)
    blocked_reason: str | None = None
    last_input_key: str | None = None
    # Sign-in values typed during the demonstration, by kind. Never part of steps, responses or logs;
    # handed to the host once on stop, then forgotten.
    credentials: dict[str, str] = field(default_factory=dict, repr=False)
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

    async def create(self, owner: RecordingOwner, start_url: str) -> Recording:
        if self._closed:
            raise RuntimeError("Recording service is shutting down.")
        safe_url = safe_public_url(start_url)
        if safe_url is None:
            raise InvalidRecordingUrl("The recording URL must be a public HTTP(S) URL.")
        await self.cleanup()
        self._evict_completed()
        if len(self._recordings) >= self.max_sessions:
            raise RuntimeError("Recording capacity is full. Stop an existing recording first.")

        recording = Recording(
            id=str(uuid4()),
            owner=owner,
            expires_at=datetime.now(UTC) + timedelta(seconds=self.timeout_seconds),
        )
        self._recordings[recording.id] = recording

        async def on_event(event: dict[str, Any]) -> None:
            await self.record_event(recording.id, event)

        try:
            browser = await self.provider.create(safe_url, on_event)
            if await self._attach_browser(recording, browser):
                raise RuntimeError("Recording stopped before the browser became available.")
            await self.record_event(recording.id, {"type": "navigation", "url": safe_url})
            return recording
        except BaseException:
            if recording.browser is None and recording.close_requested is None:
                self._recordings.pop(recording.id, None)
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

    @staticmethod
    def take_credentials(recording: Recording) -> dict[str, str]:
        """Return the captured sign-in values once; later calls get nothing."""
        credentials, recording.credentials = recording.credentials, {}
        return credentials

    async def delete(self, recording_id: str, owner: RecordingOwner) -> bool:
        recording = await self.get(recording_id, owner)
        if recording is None:
            return False
        await self._stop(recording, expired=False)
        recording.credentials = {}
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
            if event.get("type") == "sign_in_value":
                # Only the provider's isolated sign-in world produces these; page events are stripped of them.
                kind, secret = event.get("value"), event.get("secret")
                if kind in {"username", "password"} and isinstance(secret, str):
                    # The latest input wins: a cleared or oversized field leaves nothing to hand over,
                    # so the host asks for the value instead of saving a stale one.
                    if 0 < len(secret) <= MAX_FIELD_LENGTH:
                        recording.credentials[kind] = secret
                    else:
                        recording.credentials.pop(kind, None)
                return
            step = _to_step(event)
            if step is None:
                return
            input_key = _text(event.get("targetKey"), maximum=512) or step.target
            if step.type in {"input", "credential"} and recording.steps:
                previous = recording.steps[-1]
                if previous.type == step.type and recording.last_input_key == input_key:
                    recording.steps[-1] = step.model_copy(update={"id": previous.id})
                    return
            if step.type == "navigation" and recording.steps and recording.steps[-1].url == step.url:
                return
            if len(recording.steps) >= MAX_STEPS:
                recording.blocked_reason = CAPTURE_LIMIT_REASON
                return
            recording.steps.append(step)
            recording.last_input_key = input_key if step.type in {"input", "credential"} else None

    async def cleanup(self) -> None:
        now = datetime.now(UTC)
        for recording in list(self._recordings.values()):
            if now >= recording.expires_at:
                # Values nobody collected do not outlive the recording.
                recording.credentials = {}
            if recording.status != "recording":
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
        for recording in list(self._recordings.values()):
            try:
                await self._stop(recording, expired=recording.status == "recording")
            except Exception:
                logger.warning("recording_shutdown_close_failed")

    def _evict_completed(self) -> None:
        while len(self._recordings) >= self.max_sessions:
            recording_id, oldest = next(iter(self._recordings.items()))
            if oldest.status == "recording":
                return
            self._recordings.pop(recording_id)

    async def _stop(self, recording: Recording, *, expired: bool) -> None:
        async with recording.lock:
            if recording.status != "recording":
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
            await browser.close()
        except BaseException:
            async with recording.lock:
                recording.closing = False
            raise
        async with recording.lock:
            recording.browser = None
            recording.status = recording.close_requested or ("expired" if expired else "stopped")
            recording.close_requested = None
            recording.closing = False
            if recording.status == "expired":
                recording.credentials = {}

    async def _attach_browser(self, recording: Recording, browser: BrowserSession) -> bool:
        """Attach a newly created browser only while its recording remains live."""
        close_detached_browser = False
        stop_after_attach = False
        async with recording.lock:
            recording.creating = False
            if self._closed or self._recordings.get(recording.id) is not recording:
                close_detached_browser = True
            elif recording.status != "recording":
                close_detached_browser = True
            else:
                recording.browser = browser
                if recording.close_requested is None and datetime.now(UTC) >= recording.expires_at:
                    recording.close_requested = "expired"
                stop_after_attach = recording.close_requested is not None
        if close_detached_browser:
            await browser.close()
            return True
        if not stop_after_attach:
            return False
        await self._stop(recording, expired=recording.close_requested == "expired")
        return True

    @staticmethod
    def response(recording: Recording) -> RecordingResponse:
        live_view_url = None
        if recording.status == "recording" and recording.browser:
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
    if event_type not in STEP_TYPES:
        return None
    target = _text(event.get("target"), maximum=240)
    value = _text(event.get("value"), maximum=500)
    if event_type == "input":
        # Typed text is replayed exactly: keep it verbatim, including "" (clear the field).
        raw = event.get("value")
        value = raw if isinstance(raw, str) and len(raw) <= MAX_FIELD_LENGTH else None
    if event_type == "input" and target:
        kind = next((kind for pattern, kind in _SECRET_TARGETS if pattern.search(target)), None)
        if kind is not None:
            event_type, value = "credential", kind
    # A credential step carries only its kind; anything else is dropped.
    if event_type == "credential" and value not in CREDENTIAL_KINDS:
        return None
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
    if event_type == "credential":
        return f"Enter the saved {value} in {target or 'the sign-in field'}"
    if event_type == "select_change":
        return f"Choose {value or 'option'} in {target or 'menu'}"
    if event_type == "key_press":
        return f"Press {value or 'key'}"
    if event_type == "scroll":
        return f"Scroll {value or 'page'}"
    return "Agent action"
