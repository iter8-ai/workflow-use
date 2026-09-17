from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from .capture import CAPTURE_SCRIPT
from .security import is_public_http_url, resolves_to_public_host, safe_public_url, url_origin

EventSink = Callable[[dict[str, Any]], Awaitable[None]]


class BrowserSession(Protocol):
    live_view_url: str | None

    async def close(self) -> None: ...

    async def activate(self, on_event: EventSink) -> None: ...


class BrowserProvider(Protocol):
    async def create(self, start_url: str, on_event: EventSink) -> BrowserSession: ...

    async def create_private(self, start_url: str) -> BrowserSession: ...

    async def prepare(self, login: BrowserSession, start_url: str) -> BrowserSession: ...


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
        self.approved_url: str | None = None
        self._capture_active = False

    async def activate(self, on_event: EventSink) -> None:
        if self._capture_active:
            return
        context = self.browser.contexts[0]
        if not self.approved_url or not context.pages:
            raise ValueError("Private browser is unavailable.")
        for page in context.pages:
            if url_origin(page.url) != url_origin(self.approved_url):
                raise ValueError("Private browser left the approved origin.")
        await _install_capture(context, on_event)
        for page in context.pages:
            _install_page_events(self, page, on_event)
            for frame in page.frames:
                await frame.evaluate(CAPTURE_SCRIPT)
        context.on("page", lambda page: _install_page_events(self, page, on_event))
        self._capture_active = True

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


async def _configure_context(context: Any, on_event: EventSink | None, approved_url: str | None = None) -> None:
    async def guarded_route(route: Any) -> None:
        request = route.request
        if approved_url and request.is_navigation_request():
            # Includes popups and frames. Navigation never broadens the login origin.
            if url_origin(request.url) != url_origin(approved_url):
                await route.abort()
                return
        if not await resolves_to_public_host(request.url):
            await route.abort()
            return
        await route.continue_()

    await context.route("**/*", guarded_route)
    if on_event is not None:
        await _install_capture(context, on_event)


async def _install_capture(context: Any, on_event: EventSink) -> None:
    await context.expose_binding("workflowUseRecord", lambda _source, event: on_event(event))
    await context.add_init_script(CAPTURE_SCRIPT)


def _guard_private_pages(session: PlaywrightRecordingSession, context: Any) -> None:
    def guard(page: Any) -> None:
        def navigation(frame: Any) -> None:
            if frame == page.main_frame and url_origin(frame.url) != url_origin(session.approved_url or ""):
                session.track(page.close())

        page.on("framenavigated", navigation)

    for page in context.pages:
        guard(page)
    context.on("page", guard)


async def _prepare(provider: Any, login: Any, start_url: str) -> BrowserSession:
    if (
        not login.approved_url
        or safe_public_url(start_url) != start_url
        or url_origin(start_url) != url_origin(login.approved_url)
    ):
        raise ValueError("Preparation requires an exact URL on the approved origin.")
    # Ask Playwright for cookies applicable to this origin, then narrow parent-domain
    # cookies to the exact host so credentials cannot expand the approved boundary.
    from urllib.parse import urlsplit

    host = urlsplit(start_url).hostname
    cookies = await login.browser.contexts[0].cookies()
    approved = []
    for cookie in cookies:
        domain = cookie.get("domain", "").lstrip(".").lower()
        if not domain or cookie.get("partitionKey") or (host != domain and not host.endswith("." + domain)):
            continue
        copied = {
            key: value
            for key, value in cookie.items()
            if key in {"name", "value", "path", "expires", "httpOnly", "secure", "sameSite"}
        }
        copied["domain"] = host
        approved.append(copied)
    return await provider._create(start_url, None, cookies=approved)


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
        return await self._create(start_url, on_event)

    async def create_private(self, start_url: str) -> BrowserSession:
        return await self._create(start_url, None)

    async def prepare(self, login: BrowserSession, start_url: str) -> BrowserSession:
        return await _prepare(self, login, start_url)

    async def _create(
        self, start_url: str, on_event: EventSink | None, *, cookies: list[dict[str, Any]] | None = None
    ) -> BrowserSession:
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
            browser_settings={
                "viewport": {"width": 1280, "height": 720},
                "record_session": False,
                "log_session": False,
            },
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
            session.approved_url = start_url if on_event is None else None
            await _configure_context(context, on_event, session.approved_url)
            if session.approved_url:
                _guard_private_pages(session, context)
            if cookies:
                await context.add_cookies(cookies)
            for existing_page in context.pages if on_event is not None else []:
                _install_page_events(session, existing_page, on_event)

            def on_new_page(page: Any) -> None:
                _install_page_events(session, page, on_event)

            if on_event is not None:
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
        return await self._create(start_url, on_event)

    async def create_private(self, start_url: str) -> BrowserSession:
        return await self._create(start_url, None)

    async def prepare(self, login: BrowserSession, start_url: str) -> BrowserSession:
        return await _prepare(self, login, start_url)

    async def _create(
        self, start_url: str, on_event: EventSink | None, *, cookies: list[dict[str, Any]] | None = None
    ) -> BrowserSession:
        if safe_public_url(start_url) is None:
            raise ValueError("The recording URL must be a public HTTP(S) URL.")
        from playwright.async_api import async_playwright

        runtime = await async_playwright().start()
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        session = PlaywrightRecordingSession(browser=browser, runtime=runtime, live_view_url=None)
        try:
            session.approved_url = start_url if on_event is None else None
            await _configure_context(context, on_event, session.approved_url)
            if session.approved_url:
                _guard_private_pages(session, context)
            if cookies:
                await context.add_cookies(cookies)
            page = await context.new_page()
            if on_event is not None:
                _install_page_events(session, page, on_event)
                context.on("page", lambda new_page: _install_page_events(session, new_page, on_event))
            await page.goto(start_url, wait_until="domcontentloaded")
            self.last_session = session
            return session
        except BaseException:
            await session.close()
            raise
