from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from typing import Any, Protocol
from uuid import uuid4

from .capture import CAPTURE_SCRIPT, install_sign_in_capture, page_event
from .security import (
    has_google_session,
    is_google_sign_in,
    is_public_http_url,
    resolves_to_public_host,
    safe_public_url,
)

EventSink = Callable[[dict[str, Any]], Awaitable[None]]
logger = logging.getLogger(__name__)
LIVE_VIEW_SWITCH_TIMEOUT_SECONDS = 15


class BrowserSession(Protocol):
    live_view_url: str | None

    async def close(self) -> None: ...

    async def google_signed_in(self) -> bool: ...

    async def delete_context(self) -> None: ...


class BrowserProvider(Protocol):
    async def create(self, start_url: str, on_event: EventSink) -> BrowserSession: ...


class _PendingContextCleanup(Exception):
    """Startup failed and the service must retry deleting the created context."""

    def __init__(self, context_id: str, delete_context: Callable[[], Awaitable[None]]) -> None:
        super().__init__("Browserbase context cleanup pending")
        self.context_id = context_id
        self.delete_context = delete_context


class PlaywrightRecordingSession:
    """Owns an attached Playwright browser and avoids exposing its CDP URL."""

    def __init__(
        self,
        *,
        browser: Any,
        runtime: Any,
        live_view_url: str | None,
        release: Callable[[], Awaitable[None]] | None = None,
        context_id: str | None = None,
        delete_context: Callable[[str], Awaitable[None]] | None = None,
    ) -> None:
        self.browser = browser
        self.runtime = runtime
        self.live_view_url = live_view_url
        self._first_live_view_url = live_view_url
        # Tabs opened during the demonstration (e.g. a "Continue with Google" window), oldest first, each with
        # its own live view. The person demonstrating sees the newest one still open.
        self._opened_tabs: list[tuple[Any, str]] = []
        self._pending_tabs: dict[Any, asyncio.TimerHandle] = {}
        self._release = release
        self.context_id = context_id
        self._delete_context = delete_context
        self._tasks: set[asyncio.Task[None]] = set()
        # Waits on downloads still in progress; nothing to report once the browser is gone.
        self._watchers: set[asyncio.Task[None]] = set()
        self._browser_closed = False
        self._runtime_stopped = False
        self._released = False

    @property
    def live_view_switching(self) -> bool:
        return bool(self._pending_tabs)

    def open_tab(self, page: Any) -> None:
        self._pending_tabs[page] = asyncio.get_running_loop().call_later(
            LIVE_VIEW_SWITCH_TIMEOUT_SECONDS, self.finish_tab, page
        )

    def finish_tab(self, page: Any) -> None:
        timer = self._pending_tabs.pop(page, None)
        if timer is not None:
            timer.cancel()

    def show_tab(self, page: Any, live_view_url: str) -> None:
        self.finish_tab(page)
        self._opened_tabs = [(tab, url) for tab, url in self._opened_tabs if tab is not page]
        self._opened_tabs.append((page, live_view_url))
        self.live_view_url = live_view_url

    def forget_tab(self, page: Any) -> None:
        self.finish_tab(page)
        self._opened_tabs = [(tab, url) for tab, url in self._opened_tabs if tab is not page]
        self.live_view_url = self._opened_tabs[-1][1] if self._opened_tabs else self._first_live_view_url

    def track(self, coroutine: Awaitable[None]) -> None:
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def watch(self, coroutine: Awaitable[None]) -> None:
        task = asyncio.create_task(coroutine)
        self._watchers.add(task)
        task.add_done_callback(self._watchers.discard)

    async def google_signed_in(self) -> bool:
        return has_google_session(await self.browser.contexts[0].cookies())

    async def delete_context(self) -> None:
        if self.context_id is not None and self._delete_context is not None:
            await self._delete_context(self.context_id)

    async def close(self) -> None:
        for page in list(self._pending_tabs):
            self.finish_tab(page)
        if self._browser_closed and self._runtime_stopped and (self._release is None or self._released):
            return
        if not self._browser_closed:
            await self.browser.close()
            self._browser_closed = True
        for watcher in list(self._watchers):
            watcher.cancel()
        if self._tasks or self._watchers:
            await asyncio.gather(*self._tasks, *self._watchers, return_exceptions=True)
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

    async def record(source: dict[str, Any], event: object) -> None:
        # Signing in to Google is not a step an agent repeats: it uses the agent's connected Google account.
        frame = source.get("frame")
        if frame is not None and is_google_sign_in(frame.url):
            return
        await on_event(page_event(event))

    await context.route("**/*", guarded_route)
    # Page scripts can call this binding too, so nothing arriving through it may carry a sign-in value.
    await context.expose_binding("workflowUseRecord", record)
    await context.add_init_script(CAPTURE_SCRIPT)


async def _install_page_events(session: PlaywrightRecordingSession, page: Any, on_event: EventSink) -> None:
    if page.is_closed():
        return

    def on_navigation(frame: Any) -> None:
        # Embedded documents load on their own; they are not instructions to navigate the browser.
        # Their demonstrated interactions still arrive through the context's capture binding.
        if frame != page.main_frame or not is_public_http_url(frame.url) or is_google_sign_in(frame.url):
            return
        session.track(on_event({"type": "navigation", "url": frame.url}))

    def on_download(download: Any) -> None:
        if is_google_sign_in(page.url):
            return
        session.watch(_report_download(download, on_event))

    page.on("framenavigated", on_navigation)
    # The live view shows no download bar, so the recorder reports each download to the person demonstrating.
    page.on("download", on_download)
    try:
        await install_sign_in_capture(page.context, page, lambda event: session.track(on_event(event)))
    except Exception:
        if not page.is_closed():
            raise


async def _report_download(download: Any, on_event: EventSink) -> None:
    download_id = str(uuid4())
    name = download.suggested_filename
    await on_event({"type": "download", "downloadId": download_id, "state": "started", "value": name})
    failure = await download.failure()
    await on_event({"type": "download", "downloadId": download_id, "state": "failed" if failure else "completed"})


async def _show_opened_tab(session: PlaywrightRecordingSession, client: Any, session_id: str, page: Any) -> None:
    """Point the live view at a tab the website opened, and back once it closes.

    Browserbase's live view shows one tab. Without this, a sign-in window opened by "Continue with Google"
    stays invisible and the page looks like it ignored the click.
    """
    page.on("close", lambda _page: session.forget_tab(page))
    try:
        cdp = await page.context.new_cdp_session(page)
        try:
            target_id = (await cdp.send("Target.getTargetInfo"))["targetInfo"]["targetId"]
        finally:
            await cdp.detach()
        for _ in range(10):
            debug = await client.sessions.debug(session_id)
            listed = next((tab for tab in debug.pages or [] if tab.id == target_id), None)
            if listed is not None:
                if not page.is_closed():
                    session.show_tab(page, listed.debugger_fullscreen_url)
                return
            await asyncio.sleep(0.3)
        logger.warning("Opened tab has no live view")
    except Exception:
        # The demonstration continues in the tab already shown.
        if not page.is_closed():
            logger.warning("Could not show the opened tab", exc_info=True)
    finally:
        session.finish_tab(page)


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
        context_id: str | None = None
        created: Any | None = None
        runtime: Any | None = None

        async def delete_context(context_id: str) -> None:
            deletion_client = AsyncBrowserbase()
            try:
                await deletion_client.delete(f"/v1/contexts/{context_id}", cast_to=object, body={})
            except Exception as error:
                if getattr(error, "status_code", None) != 404:
                    raise
            finally:
                await deletion_client.__aexit__(None, None, None)

        try:
            context_id = (await client.contexts.create(project_id=self.project_id)).id
            created = await client.sessions.create(
                project_id=self.project_id,
                keep_alive=True,
                region=self.region,
                api_timeout=max(self.timeout_seconds, 60),
                browser_settings={
                    "viewport": {"width": 1280, "height": 720},
                    "record_session": False,
                    "log_session": False,
                    "context": {"id": context_id, "persist": True},
                },
            )
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
                context_id=context_id,
                delete_context=delete_context,
            )
            context = contexts[0]
            await _configure_context(context, on_event)
            page = context.pages[0] if context.pages else await context.new_page()
            for existing_page in context.pages:
                await _install_page_events(session, existing_page, on_event)

            def on_new_page(new_page: Any) -> None:
                session.open_tab(new_page)
                session.track(_install_page_events(session, new_page, on_event))
                session.watch(_show_opened_tab(session, client, created.id, new_page))

            context.on("page", on_new_page)
            await page.goto(start_url, wait_until="domcontentloaded", timeout=self.timeout_seconds * 1000)
            return session
        except BaseException:
            cleanup_pending = False
            if runtime is not None:
                try:
                    await runtime.stop()
                except Exception as error:
                    logger.warning("recording_runtime_cleanup_failed", extra={"error_type": type(error).__name__})
            if created is not None:
                try:
                    await client.sessions.update(created.id, project_id=self.project_id, status="REQUEST_RELEASE")
                except Exception as error:
                    logger.warning("recording_session_cleanup_failed", extra={"error_type": type(error).__name__})
            if context_id is not None:
                try:
                    await client.delete(f"/v1/contexts/{context_id}", cast_to=object, body={})
                except Exception as error:
                    if getattr(error, "status_code", None) != 404:
                        cleanup_pending = True
                        logger.warning("recording_context_cleanup_failed", extra={"error_type": type(error).__name__})
            try:
                await client.__aexit__(None, None, None)
            except Exception as error:
                logger.warning("recording_client_cleanup_failed", extra={"error_type": type(error).__name__})
            if cleanup_pending and context_id is not None:
                raise _PendingContextCleanup(context_id, lambda: delete_context(context_id)) from None
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
        await _install_page_events(session, page, on_event)
        context.on("page", lambda new_page: session.track(_install_page_events(session, new_page, on_event)))
        await page.goto(start_url, wait_until="domcontentloaded")
        self.last_session = session
        return session
