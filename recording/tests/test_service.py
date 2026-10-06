from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from workflow_use_recording.provider import BrowserProvider, BrowserSession, PlaywrightRecordingSession
from workflow_use_recording.service import RecordingOwner, RecordingService


class DeferredSession:
    live_view_url: str | None = None

    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class ContextSession(DeferredSession):
    context_id = "private-context"

    def __init__(self) -> None:
        super().__init__()
        self.deleted = False
        self.delete_failures = 0
        self.delete_attempts = 0

    async def google_signed_in(self) -> bool:
        return True

    async def delete_context(self) -> None:
        assert self.closed
        self.delete_attempts += 1
        if self.delete_failures:
            self.delete_failures -= 1
            raise RuntimeError("temporary provider failure")
        self.deleted = True


class ContextProvider:
    def __init__(self) -> None:
        self.sessions: list[ContextSession] = []

    async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
        session = ContextSession()
        self.sessions.append(session)
        return session


class DeferredProvider(BrowserProvider):
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.session = DeferredSession()

    async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
        self.started.set()
        await self.release.wait()
        return self.session


class CloseFailingSession(DeferredSession):
    async def close(self) -> None:
        raise RuntimeError("provider-close-failure")


class RetryCloseSession(DeferredSession):
    def __init__(self) -> None:
        super().__init__()
        self.close_attempts = 0

    async def close(self) -> None:
        self.close_attempts += 1
        if self.close_attempts == 1:
            raise RuntimeError("transient-provider-close-failure")
        self.closed = True


class SequentialProvider(BrowserProvider):
    def __init__(self) -> None:
        self.created: list[DeferredSession] = [CloseFailingSession(), DeferredSession()]
        self.sessions = list(self.created)

    async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
        return self.sessions.pop(0)


class RetryProvider(BrowserProvider):
    def __init__(self) -> None:
        self.session = RetryCloseSession()

    async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
        return self.session


class RetryBrowser:
    def __init__(self) -> None:
        self.close_attempts = 0

    async def close(self) -> None:
        self.close_attempts += 1
        if self.close_attempts == 1:
            raise RuntimeError("transient-browser-close-failure")


class Runtime:
    def __init__(self) -> None:
        self.stop_attempts = 0

    async def stop(self) -> None:
        self.stop_attempts += 1


@pytest.mark.asyncio
async def test_browser_returned_after_shutdown_is_closed() -> None:
    provider = DeferredProvider()
    service = RecordingService(provider)
    task = asyncio.create_task(service.create(RecordingOwner("iter7", "owner@iter7.example"), "https://example.com"))
    await provider.started.wait()

    await service.close()
    provider.release.set()

    with pytest.raises(RuntimeError, match="stopped before the browser became available"):
        await task
    assert provider.session.closed


@pytest.mark.asyncio
async def test_browser_returned_after_expiry_is_closed() -> None:
    provider = DeferredProvider()
    service = RecordingService(provider, timeout_seconds=1)
    task = asyncio.create_task(service.create(RecordingOwner("iter7", "owner@iter7.example"), "https://example.com"))
    await provider.started.wait()

    await asyncio.sleep(1.05)
    await service.cleanup()
    provider.release.set()

    with pytest.raises(RuntimeError, match="stopped before the browser became available"):
        await task
    assert provider.session.closed


@pytest.mark.asyncio
async def test_cleanup_continues_when_a_browser_close_fails() -> None:
    provider = SequentialProvider()
    service = RecordingService(provider, timeout_seconds=1)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    await service.create(owner, "https://example.com")
    await service.create(owner, "https://example.org")

    await asyncio.sleep(1.05)
    await service.cleanup()

    assert provider.created[1].closed


@pytest.mark.asyncio
async def test_transient_close_failure_is_retried_without_claiming_a_stopped_recording() -> None:
    provider = RetryProvider()
    service = RecordingService(provider)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    recording = await service.create(owner, "https://example.com")

    with pytest.raises(RuntimeError, match="transient-provider-close-failure"):
        await service.stop(recording.id, owner)

    retry = await service.get(recording.id, owner)

    assert retry is not None
    assert retry.status == "stopped"
    assert provider.session.closed
    assert provider.session.close_attempts == 2


@pytest.mark.asyncio
async def test_playwright_session_retries_after_a_transient_browser_close_failure() -> None:
    browser = RetryBrowser()
    runtime = Runtime()
    released = False

    async def release() -> None:
        nonlocal released
        released = True

    session = PlaywrightRecordingSession(browser=browser, runtime=runtime, live_view_url=None, release=release)

    with pytest.raises(RuntimeError, match="transient-browser-close-failure"):
        await session.close()
    await session.close()

    assert browser.close_attempts == 2
    assert runtime.stop_attempts == 1
    assert released


@pytest.mark.asyncio
async def test_startup_does_not_append_the_configured_url_after_browser_events() -> None:
    class StartupProvider:
        async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
            await on_event({"type": "navigation", "url": start_url})
            await on_event({"type": "navigation", "url": "https://example.com/login"})
            await on_event({"type": "click", "target": "Continue"})
            return DeferredSession()

    service = RecordingService(StartupProvider())
    owner = RecordingOwner("iter7", "owner@iter7.example")
    recording = await service.create(owner, "https://example.com/")
    assert [(step.type, step.url, step.target) for step in recording.steps] == [
        ("navigation", "https://example.com/", None),
        ("navigation", "https://example.com/login", None),
        ("click", None, "Continue"),
    ]
    # Returning to the starting page later is a genuine demonstrated navigation.
    await service.record_event(recording.id, {"type": "navigation", "url": "https://example.com/"})
    assert recording.steps[-1].url == "https://example.com/"
    assert len(recording.steps) == 4
    await service.close()


@pytest.mark.asyncio
async def test_sweep_deletes_unclaimed_google_context_after_one_hour() -> None:
    provider = ContextProvider()
    service = RecordingService(provider)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    recording = await service.create(owner, "https://example.com")
    await service.stop(recording.id, owner)
    assert not provider.sessions[0].deleted
    recording.stopped_at = datetime.now(UTC) - timedelta(minutes=61)
    await service.cleanup()
    assert provider.sessions[0].deleted


@pytest.mark.asyncio
async def test_shutdown_deletes_unclaimed_but_not_claimed_contexts() -> None:
    provider = ContextProvider()
    service = RecordingService(provider)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    unclaimed = await service.create(owner, "https://example.com")
    claimed = await service.create(owner, "https://example.org")
    await service.stop(unclaimed.id, owner)
    await service.stop(claimed.id, owner)
    assert await service.claim_google_context(claimed.id, owner) == "private-context"
    await service.close()
    assert provider.sessions[0].deleted
    assert not provider.sessions[1].deleted


@pytest.mark.asyncio
async def test_failed_context_deletion_keeps_ownership_for_sweep_retry() -> None:
    provider = ContextProvider()
    service = RecordingService(provider)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    recording = await service.create(owner, "https://example.com")
    provider.sessions[0].delete_failures = 2
    await service.stop(recording.id, owner)
    recording.stopped_at = datetime.now(UTC) - timedelta(minutes=61)

    await service.cleanup()
    assert not provider.sessions[0].deleted
    assert recording.context_id == "private-context"
    assert await service.claim_google_context(recording.id, owner) == ""
    await service.cleanup()
    assert provider.sessions[0].deleted
    assert recording.context_id is None


@pytest.mark.asyncio
async def test_unsigned_stop_retries_failed_delete_on_next_sweep() -> None:
    class UnsignedSession(ContextSession):
        async def google_signed_in(self) -> bool:
            return False

    session = UnsignedSession()

    class Provider:
        async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
            return session

    service = RecordingService(Provider())
    owner = RecordingOwner("iter7", "owner@iter7.example")
    recording = await service.create(owner, "https://example.com")
    session.delete_failures = 1
    await service.stop(recording.id, owner)
    assert recording.context_id == "private-context"
    await service.cleanup()
    assert session.deleted


@pytest.mark.asyncio
async def test_failed_delete_hides_recording_but_keeps_context_for_retry() -> None:
    provider = ContextProvider()
    service = RecordingService(provider)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    recording = await service.create(owner, "https://example.com")
    provider.sessions[0].delete_failures = 1
    await service.stop(recording.id, owner)

    assert await service.delete(recording.id, owner)
    assert recording.context_id == "private-context"
    assert recording.deleted
    assert await service.get(recording.id, owner) is None
    await service.cleanup()
    assert provider.sessions[0].deleted


@pytest.mark.asyncio
async def test_failed_eviction_keeps_context_until_retry() -> None:
    provider = ContextProvider()
    service = RecordingService(provider, max_sessions=1)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    recording = await service.create(owner, "https://example.com")
    provider.sessions[0].delete_failures = 1
    await service.stop(recording.id, owner)

    with pytest.raises(RuntimeError, match="capacity is full"):
        await service.create(owner, "https://example.org")
    assert recording.context_id == "private-context"
    await service.cleanup()
    assert provider.sessions[0].deleted
    await service.create(owner, "https://example.org")


@pytest.mark.asyncio
async def test_shutdown_retries_failed_context_deletion() -> None:
    provider = ContextProvider()
    service = RecordingService(provider)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    recording = await service.create(owner, "https://example.com")
    provider.sessions[0].delete_failures = 1
    await service.stop(recording.id, owner)
    await service.close()
    assert recording.context_id == "private-context"
    await service.close()
    assert provider.sessions[0].deleted


@pytest.mark.asyncio
async def test_signed_in_cookie_result_survives_close_retry() -> None:
    class CookieThenReleaseSession(ContextSession):
        def __init__(self) -> None:
            super().__init__()
            self.close_attempts = 0
            self.cookie_reads = 0

        async def google_signed_in(self) -> bool:
            self.cookie_reads += 1
            if self.cookie_reads > 1:
                raise RuntimeError("browser already closed")
            return True

        async def close(self) -> None:
            self.close_attempts += 1
            if self.close_attempts == 1:
                raise RuntimeError("release failed")
            await super().close()

    session = CookieThenReleaseSession()

    class Provider:
        async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
            return session

    provider = Provider()
    service = RecordingService(provider)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    recording = await service.create(owner, "https://example.com")
    with pytest.raises(RuntimeError, match="release failed"):
        await service.stop(recording.id, owner)
    await service.stop(recording.id, owner)
    assert recording.google_signed_in
    assert session.cookie_reads == 1
    assert not session.deleted


@pytest.mark.asyncio
async def test_concurrent_creates_do_not_overrun_capacity_during_eviction() -> None:
    class WaitingContextSession(ContextSession):
        started = asyncio.Event()
        release = asyncio.Event()

        async def delete_context(self) -> None:
            self.started.set()
            await self.release.wait()
            await super().delete_context()

    class Provider(ContextProvider):
        async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
            if not self.sessions:
                session = WaitingContextSession()
                self.sessions.append(session)
                return session
            return await super().create(start_url, on_event)

    provider = Provider()
    service = RecordingService(provider, max_sessions=1)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    first = await service.create(owner, "https://example.com")
    session = provider.sessions[0]
    await service.stop(first.id, owner)

    one = asyncio.create_task(service.create(owner, "https://example.org"))
    await session.started.wait()
    two = asyncio.create_task(service.create(owner, "https://example.net"))
    await asyncio.sleep(0)
    session.release.set()
    results = await asyncio.gather(one, two, return_exceptions=True)
    assert sum(not isinstance(result, BaseException) for result in results) == 1
    assert any(isinstance(result, RuntimeError) and "capacity is full" in str(result) for result in results)
    assert len(service._recordings) == 1


@pytest.mark.asyncio
async def test_late_startup_expiry_keeps_signed_in_context_for_sweep() -> None:
    class DelayedContextProvider(ContextProvider):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
            self.started.set()
            await self.release.wait()
            return await super().create(start_url, on_event)

    provider = DelayedContextProvider()
    service = RecordingService(provider, timeout_seconds=1)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    task = asyncio.create_task(service.create(owner, "https://example.com"))
    await provider.started.wait()
    await asyncio.sleep(1.05)
    provider.release.set()
    with pytest.raises(RuntimeError, match="stopped before the browser became available"):
        await task
    assert len(service._recordings) == 1
    recording = next(iter(service._recordings.values()))
    assert recording.context_id == "private-context"
    recording.stopped_at = datetime.now(UTC) - timedelta(minutes=61)
    await service.cleanup()
    assert provider.sessions[0].deleted


@pytest.mark.asyncio
async def test_context_returned_after_shutdown_keeps_failed_cleanup_for_retry() -> None:
    class DelayedProvider(ContextProvider):
        def __init__(self) -> None:
            super().__init__()
            self.started = asyncio.Event()
            self.release = asyncio.Event()

        async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
            self.started.set()
            await self.release.wait()
            session = await super().create(start_url, on_event)
            session.delete_failures = 1
            return session

    provider = DelayedProvider()
    service = RecordingService(provider)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    task = asyncio.create_task(service.create(owner, "https://example.com"))
    await provider.started.wait()
    await service.close()
    provider.release.set()
    with pytest.raises(RuntimeError, match="stopped before the browser became available"):
        await task
    assert len(service._recordings) == 1
    assert next(iter(service._recordings.values())).context_id == "private-context"
    await service.close()
    assert provider.sessions[0].deleted
