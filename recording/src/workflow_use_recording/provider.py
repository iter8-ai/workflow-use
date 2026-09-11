from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from .capture import CAPTURE_SCRIPT
from .security import is_public_http_url, resolves_to_public_host, safe_public_url

EventSink = Callable[[dict[str, Any]], Awaitable[None]]


class BrowserSession(Protocol):
    live_view_url: str | None

    async def close(self) -> None: ...


class BrowserProvider(Protocol):
    async def create(self, start_url: str, on_event: EventSink) -> BrowserSession: ...


class PlaywrightRecordingSession:
    """Owns an attached Playwright browser and avoids exposing its CDP URL."""

    def __init__(
        self,
        *,
        browser: Any,
        runtime: Any,
        live_view_url: str | None,
        release: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self.browser = browser
        self.runtime = runtime
        self.live_view_url = live_view_url
        self._release = release
        self._tasks: set[asyncio.Task[None]] = set()
        self._browser_closed = False
        self._runtime_stopped = False
        self._released = False

    def track(self, coroutine: Awaitable[None]) -> None:
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def close(self) -> None:
        if self._browser_closed and self._runtime_stopped and (self._release is None or self._released):
            return
        if not self._browser_closed:
            await self.browser.close()
            self._browser_closed = True
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        if not self._runtime_stopped:
            await self.runtime.stop()
            self._runtime_stopped = True
        if self._release is not None and not self._released:
            await self._release()
            self._released = True


async def _configure_context(context: Any, on_event: EventSink) -> None:
    async def guarded_route(route: Any) -> None:
        if not await resolves_to_public_host(route.request.url):
            await route.abort()
            return
        await route.continue_()

    await context.route("**/*", guarded_route)
    await context.expose_binding("workflowUseRecord", lambda _source, event: on_event(event))
    await context.add_init_script(CAPTURE_SCRIPT)


def _install_page_events(session: PlaywrightRecordingSession, page: Any, on_event: EventSink) -> None:
    def on_navigation(frame: Any) -> None:
        if not is_public_http_url(frame.url):
            return
        event: dict[str, Any] = {"type": "navigation", "url": frame.url}
        if frame != page.main_frame:
            event["target"] = "embedded frame"
        session.track(on_event(event))

    page.on("framenavigated", on_navigation)


class BrowserbaseProvider:
    """Creates Browserbase sessions in EU and retains links only in memory."""

    def __init__(
        self,
        *,
        project_id: str | None = None,
        region: str = "eu-central-1",
        timeout_seconds: int = 900,
    ) -> None:
        self.project_id = project_id or os.environ.get("BROWSERBASE_PROJECT_ID")
        self.region = region
        self.timeout_seconds = min(max(timeout_seconds, 1), 900)

    async def create(self, start_url: str, on_event: EventSink) -> BrowserSession:
        if safe_public_url(start_url) is None:
            raise ValueError("The recording URL must be a public HTTP(S) URL.")
        if not self.project_id:
            raise RuntimeError("BROWSERBASE_PROJECT_ID is required.")

        from browserbase import AsyncBrowserbase
        from playwright.async_api import async_playwright

        client = AsyncBrowserbase()
        created = await client.sessions.create(
            project_id=self.project_id,
            keep_alive=True,
            region=self.region,
            api_timeout=max(self.timeout_seconds, 60),
            browser_settings={"viewport": {"width": 1280, "height": 720}},
        )
        runtime: Any | None = None
        try:
            debug = await client.sessions.debug(created.id)
            runtime = await async_playwright().start()
            browser = await runtime.chromium.connect_over_cdp(created.connect_url)
            contexts = browser.contexts
            if not contexts:
                raise RuntimeError("Browserbase returned no browser context.")

            async def release() -> None:
                await client.sessions.update(created.id, project_id=self.project_id, status="REQUEST_RELEASE")
                await client.__aexit__(None, None, None)

            session = PlaywrightRecordingSession(
                browser=browser,
                runtime=runtime,
                live_view_url=getattr(debug, "debugger_fullscreen_url", None),
                release=release,
            )
            context = contexts[0]
            await _configure_context(context, on_event)
            for existing_page in context.pages:
                _install_page_events(session, existing_page, on_event)

            def on_new_page(page: Any) -> None:
                _install_page_events(session, page, on_event)

            context.on("page", on_new_page)
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(start_url, wait_until="domcontentloaded", timeout=self.timeout_seconds * 1000)
            return session
        except BaseException:
            if runtime is not None:
                await runtime.stop()
            await client.sessions.update(created.id, project_id=self.project_id, status="REQUEST_RELEASE")
            await client.__aexit__(None, None, None)
            raise


class LocalPlaywrightProvider:
    """Local provider used only by tests and development capture checks."""

    def __init__(self) -> None:
        self.last_session: PlaywrightRecordingSession | None = None

    async def create(self, start_url: str, on_event: EventSink) -> BrowserSession:
        if safe_public_url(start_url) is None:
            raise ValueError("The recording URL must be a public HTTP(S) URL.")
        from playwright.async_api import async_playwright

        runtime = await async_playwright().start()
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        session = PlaywrightRecordingSession(browser=browser, runtime=runtime, live_view_url=None)
        await _configure_context(context, on_event)
        page = await context.new_page()
        _install_page_events(session, page, on_event)
        context.on("page", lambda new_page: _install_page_events(session, new_page, on_event))
        await page.goto(start_url, wait_until="domcontentloaded")
        self.last_session = session
        return session
