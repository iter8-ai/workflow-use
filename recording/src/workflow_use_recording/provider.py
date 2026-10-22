from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any, Protocol
from uuid import uuid4

from .capture import CAPTURE_SCRIPT, console_event, install_sign_in_capture, install_sign_in_fill
from .security import (
    has_google_session,
    is_google_sign_in,
    is_public_http_url,
    resolves_to_public_host,
)

if TYPE_CHECKING:
    from .models import RecordingLogin

EventSink = Callable[[dict[str, Any]], Awaitable[None]]
logger = logging.getLogger(__name__)
LIVE_VIEW_SWITCH_TIMEOUT_SECONDS = 15
NAVIGATE_TIMEOUT_MS = 30_000
NAVIGATE_ATTEMPTS = 3
START_PAGE_TIMEOUT_SECONDS = 45
CLEANUP_TIMEOUT_SECONDS = 2


def _same_page(current: str, target: str) -> bool:
    return current.rstrip("/") == target.rstrip("/")


class BrowserSession(Protocol):
    live_view_url: str | None
    # True while the start page failed to load and no page has been opened since.
    start_page_failed: bool

    async def close(self) -> None: ...

    async def google_signed_in(self) -> bool: ...

    async def delete_context(self) -> None: ...

    async def navigate(self, url: str) -> None: ...


class BrowserProvider(Protocol):
    async def create(
        self,
        start_url: str,
        on_event: EventSink,
        *,
        context_id: str | None = None,
        login: RecordingLogin | None = None,
    ) -> BrowserSession:
        """Start a recording browser on ``start_url``.

        ``context_id`` is a borrowed Browserbase context with a saved sign-in: demonstrated sign-ins persist,
        but the session reports no context of its own, so nothing ever deletes it. ``login`` is filled into matching
        sign-in forms while the session is open.
        """
        ...


class _PendingContextCleanup(Exception):
    """Startup failed and the service must retry deleting the created context."""

    def __init__(
        self, context_id: str, delete_context: Callable[[], Awaitable[None]], *, timed_out: bool = False
    ) -> None:
        super().__init__("Browserbase context cleanup pending")
        self.context_id = context_id
        self.delete_context = delete_context
        self.timed_out = timed_out


class RecordingStartTimeout(TimeoutError):
    """The browser or start page did not become ready before the create deadline."""


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
        login: RecordingLogin | None = None,
    ) -> None:
        self.browser = browser
        self.runtime = runtime
        self.live_view_url = live_view_url
        self.start_page_failed = False
        self._first_live_view_url = live_view_url
        # Tabs opened during the demonstration (e.g. a "Continue with Google" window), oldest first, each with
        # its own live view. The person demonstrating sees the newest one still open.
        self._opened_tabs: list[tuple[Any, str]] = []
        self._pending_tabs: dict[Any, asyncio.TimerHandle] = {}
        self._release = release
        self.context_id = context_id
        self._delete_context = delete_context
        # Held only while the browser is open; close() drops it.
        self.login = login
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

    async def navigate(self, url: str, *, timeout_ms: int = NAVIGATE_TIMEOUT_MS) -> None:
        """Open a page in the tab the live view shows. Raises Playwright's own errors."""
        context = self.browser.contexts[0]
        if self._opened_tabs:
            page = self._opened_tabs[-1][0]
        elif context.pages:
            page = context.pages[0]
        else:
            page = await context.new_page()
        from playwright.async_api import Error as PlaywrightError

        for attempt in range(NAVIGATE_ATTEMPTS):
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                break
            except PlaywrightError as error:
                # Right after a page fails to load, Chromium is still committing its error page, and that
                # commit reports the next navigation as interrupted even though it usually still lands.
                if 'interrupted by another navigation to "chrome-error://chromewebdata/"' not in str(error):
                    raise
                try:
                    await page.wait_for_load_state("domcontentloaded", timeout=timeout_ms)
                except PlaywrightError:
                    pass
                if _same_page(getattr(page, "url", ""), url):
                    break
                if attempt == NAVIGATE_ATTEMPTS - 1:
                    raise
        self.start_page_failed = False

    async def delete_context(self) -> None:
        if self.context_id is not None and self._delete_context is not None:
            await self._delete_context(self.context_id)

    async def close(self) -> None:
        self.login = None
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

    await context.route("**/*", guarded_route)
    # No expose_binding here: it leaves `__playwright__binding__` globals on every page, and Cloudflare's bot
    # management blocks the site's own requests once it sees them. Page events arrive as console messages.
    await context.add_init_script(CAPTURE_SCRIPT)


async def _install_page_events(session: PlaywrightRecordingSession, page: Any, on_event: EventSink) -> None:
    if page.is_closed():
        return

    def on_console(message: Any) -> None:
        event = console_event(message)
        if event is None:
            return
        # Signing in to Google is not a step an agent repeats: it uses the agent's connected Google account.
        if is_google_sign_in(page.url):
            return
        session.track(on_event(event))

    def on_navigation(frame: Any) -> None:
        # Embedded documents load on their own; they are not instructions to navigate the browser.
        # Their demonstrated interactions still arrive as console messages of the page that embeds them.
        if frame != page.main_frame or not is_public_http_url(frame.url) or is_google_sign_in(frame.url):
            return
        session.track(on_event({"type": "navigation", "url": frame.url}))

    def on_page_loaded() -> None:
        if not is_public_http_url(page.url) or is_google_sign_in(page.url):
            return
        session.start_page_failed = False
        session.track(on_event({"type": "page_loaded", "url": page.url}))

    def on_download(download: Any) -> None:
        if is_google_sign_in(page.url):
            return
        session.watch(_report_download(download, on_event))

    page.on("console", on_console)
    page.on("framenavigated", on_navigation)
    page.on("domcontentloaded", on_page_loaded)
    # The live view shows no download bar, so the recorder reports each download to the person demonstrating.
    page.on("download", on_download)
    if session.login is not None:
        install_sign_in_fill(page, lambda: session.login, session.track)
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


async def _start_playwright_runtime() -> Any:
    from playwright._impl._connection import Connection
    from playwright._impl._object_factory import create_remote_object
    from playwright._impl._transport import PipeTransport
    from playwright.async_api import async_playwright
    from playwright.async_api._generated import Playwright as AsyncPlaywright

    manager = async_playwright()
    loop = asyncio.get_running_loop()
    manager._connection = Connection(None, create_remote_object, PipeTransport(loop), loop)
    task = loop.create_task(manager._connection.run())
    playwright_future = manager._connection.playwright_future
    try:
        done, _ = await asyncio.wait(
            {manager._connection._transport.on_error_future, playwright_future},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if not playwright_future.done():
            playwright_future.cancel()
        runtime = AsyncPlaywright(next(iter(done)).result())
    except BaseException:
        if not playwright_future.done():
            playwright_future.cancel()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise
    # Playwright drops this task; retrieve a later failure without printing its details.
    task.add_done_callback(lambda finished: finished.exception() if not finished.cancelled() else None)
    runtime.stop = manager.__aexit__
    return runtime


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

    async def create(
        self,
        start_url: str,
        on_event: EventSink,
        *,
        context_id: str | None = None,
        login: RecordingLogin | None = None,
    ) -> BrowserSession:
        if not is_public_http_url(start_url):
            raise ValueError("The recording URL must be a public HTTP(S) URL.")
        if not self.project_id:
            raise RuntimeError("BROWSERBASE_PROJECT_ID is required.")

        from browserbase import AsyncBrowserbase

        client = AsyncBrowserbase()
        # Save demonstrated website sign-ins into the authorized credential's shared context. It remains
        # borrowed, never deleted here or by the service. Only a context created here is the session's own.
        saved_context_id = context_id
        context_id = None
        created: Any | None = None
        runtime: Any | None = None
        browser: Any | None = None
        # The API reports every startup failure as a generic 503, so the log must say where startup stopped.
        stage = "create_context" if saved_context_id is None else "create_session"

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
            if saved_context_id is None:
                context_id = (await client.contexts.create(project_id=self.project_id)).id
                stage = "create_session"
            browser_context = {"id": saved_context_id or context_id, "persist": True}
            created = await client.sessions.create(
                project_id=self.project_id,
                keep_alive=True,
                region=self.region,
                api_timeout=max(self.timeout_seconds, 60),
                browser_settings={
                    "viewport": {"width": 1280, "height": 720},
                    "record_session": False,
                    "log_session": False,
                    "context": browser_context,
                },
            )
            stage = "debug_session"
            debug = await client.sessions.debug(created.id)
            stage = "start_runtime"
            runtime = await _start_playwright_runtime()
            stage = "connect"
            browser = await runtime.chromium.connect_over_cdp(created.connect_url)
            stage = "configure"
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
                login=login,
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
            stage = "navigate"
            from playwright.async_api import Error as PlaywrightError
            from playwright.async_api import TimeoutError as PlaywrightTimeoutError

            try:
                await page.goto(start_url, wait_until="domcontentloaded", timeout=START_PAGE_TIMEOUT_SECONDS * 1000)
            except PlaywrightTimeoutError:
                raise RecordingStartTimeout("The recording start page did not load in time.") from None
            except PlaywrightError as error:
                # The browser is up; the person can still open another page. Only the type: the message can
                # carry the connect URL.
                logger.warning("recording_start_page_failed error_type=%s", type(error).__name__)
                session.start_page_failed = True
            return session
        except BaseException as error:
            # Only the stage and type: provider messages can carry the connect URL and its signing key.
            logger.warning("recording_browser_start_failed stage=%s error_type=%s", stage, type(error).__name__)
            timed_out = isinstance(error, TimeoutError)
            cleanup_pending = False
            if browser is not None:
                try:
                    await asyncio.wait_for(browser.close(), CLEANUP_TIMEOUT_SECONDS)
                except Exception as error:
                    logger.warning("recording_browser_cleanup_failed", extra={"error_type": type(error).__name__})
            if runtime is not None:
                try:
                    await asyncio.wait_for(runtime.stop(), CLEANUP_TIMEOUT_SECONDS)
                except Exception as error:
                    logger.warning("recording_runtime_cleanup_failed", extra={"error_type": type(error).__name__})
            if created is not None:
                try:
                    await asyncio.wait_for(
                        client.sessions.update(created.id, project_id=self.project_id, status="REQUEST_RELEASE"),
                        CLEANUP_TIMEOUT_SECONDS,
                    )
                except Exception as error:
                    logger.warning("recording_session_cleanup_failed", extra={"error_type": type(error).__name__})
            if context_id is not None:
                try:
                    await asyncio.wait_for(
                        client.delete(f"/v1/contexts/{context_id}", cast_to=object, body={}),
                        CLEANUP_TIMEOUT_SECONDS,
                    )
                except Exception as error:
                    if getattr(error, "status_code", None) != 404:
                        cleanup_pending = True
                        logger.warning("recording_context_cleanup_failed", extra={"error_type": type(error).__name__})
            try:
                await asyncio.wait_for(client.__aexit__(None, None, None), CLEANUP_TIMEOUT_SECONDS)
            except Exception as error:
                logger.warning("recording_client_cleanup_failed", extra={"error_type": type(error).__name__})
            if cleanup_pending and context_id is not None:
                raise _PendingContextCleanup(
                    context_id, lambda: delete_context(context_id), timed_out=timed_out
                ) from None
            raise


class LocalPlaywrightProvider:
    """Local provider used only by tests and development capture checks.

    ``channel="chrome"`` launches the installed Google Chrome instead of Playwright's bundled Chromium, and
    ``headless=False`` shows the window, so a local run can be driven by hand or by the gate's Test agent.
    """

    def __init__(self, *, channel: str | None = None, headless: bool = True) -> None:
        self.last_session: PlaywrightRecordingSession | None = None
        self.channel = channel
        self.headless = headless

    async def create(
        self,
        start_url: str,
        on_event: EventSink,
        *,
        context_id: str | None = None,
        login: RecordingLogin | None = None,
    ) -> BrowserSession:
        if not is_public_http_url(start_url):
            raise ValueError("The recording URL must be a public HTTP(S) URL.")
        if context_id is not None:
            # No Browserbase here; the demonstration starts signed out.
            logger.warning("recording_saved_context_ignored provider=local")
        from playwright.async_api import async_playwright

        runtime = await async_playwright().start()
        browser = await runtime.chromium.launch(channel=self.channel, headless=self.headless)
        context = await browser.new_context()
        session = PlaywrightRecordingSession(browser=browser, runtime=runtime, live_view_url=None, login=login)
        await _configure_context(context, on_event)
        page = await context.new_page()
        await _install_page_events(session, page, on_event)
        context.on("page", lambda new_page: session.track(_install_page_events(session, new_page, on_event)))
        from playwright.async_api import Error as PlaywrightError

        try:
            await page.goto(start_url, wait_until="domcontentloaded")
        except PlaywrightError as error:
            logger.warning("recording_start_page_failed error_type=%s", type(error).__name__)
            session.start_page_failed = True
        self.last_session = session
        return session
