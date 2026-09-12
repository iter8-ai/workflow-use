from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from workflow_use_recording.provider import BrowserProvider, BrowserSession, PlaywrightRecordingSession
from workflow_use_recording.service import RecordingOwner, RecordingService


class DeferredSession:
    live_view_url = None

    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class DeferredProvider(BrowserProvider):
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.session = DeferredSession()

    async def create(
        self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> BrowserSession:
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

    async def create(
        self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> BrowserSession:
        return self.sessions.pop(0)


class RetryProvider(BrowserProvider):
    def __init__(self) -> None:
        self.session = RetryCloseSession()

    async def create(
        self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> BrowserSession:
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
    task = asyncio.create_task(
        service.create(RecordingOwner("iter7", "owner@iter7.example"), "https://example.com")
    )
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
    task = asyncio.create_task(
        service.create(RecordingOwner("iter7", "owner@iter7.example"), "https://example.com")
    )
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

    session = PlaywrightRecordingSession(
        browser=browser, runtime=runtime, live_view_url=None, release=release
    )

    with pytest.raises(RuntimeError, match="transient-browser-close-failure"):
        await session.close()
    await session.close()

    assert browser.close_attempts == 2
    assert runtime.stop_attempts == 1
    assert released
