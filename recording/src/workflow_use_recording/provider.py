from __future__ import annotations

import asyncio
import logging
import os
import re
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal, Protocol
from urllib.parse import urlsplit
from uuid import uuid4

from .capture import CAPTURE_SCRIPT, console_event, install_sign_in_capture, install_sign_in_fill
from .models import country_code
from .security import (
    has_google_session,
    is_google_sign_in,
    is_public_http_url,
    resolves_to_public_host,
    website_state,
)

if TYPE_CHECKING:
    from .models import RecordingLogin


@dataclass
class _Tab:
    id: str
    page: Any
    live_view_url: str | None = None
    title: str = ""
    first_navigation: bool = False


EventSink = Callable[[dict[str, Any]], Awaitable[None]]
Network = Literal["direct", "proxy"]
logger = logging.getLogger(__name__)
LIVE_VIEW_SWITCH_TIMEOUT_SECONDS = 15
NAVIGATE_TIMEOUT_MS = 30_000
NAVIGATE_ATTEMPTS = 3
# The service's create deadline. A direct start-page attempt and a proxied retry must both fit inside it.
START_PAGE_TIMEOUT_SECONDS = 45
START_PAGE_ATTEMPT_TIMEOUT_SECONDS = 20
CLEANUP_TIMEOUT_SECONDS = 2
# A site that answers the main document with one of these is refusing the browser, not failing.
BLOCKED_STATUSES = frozenset({403, 429, 503})
DEFAULT_PROXY_COUNTRY = "EE"


def _same_page(current: str, target: str) -> bool:
    return current.rstrip("/") == target.rstrip("/")


def _blocked_status(response: Any) -> int | None:
    """The main document's status when it is a block page, else None (also for no response at all)."""
    status = getattr(response, "status", None)
    return status if isinstance(status, int) and status in BLOCKED_STATUSES else None


class BrowserSession(Protocol):
    live_view_url: str | None
    # True while the start page failed to load and no page has been opened since.
    start_page_failed: bool
    # True while the site answers the shown page with a block page and no other page has loaded since.
    start_page_blocked: bool
    network: Network
    proxy_country: str | None
    tabs: list[dict[str, Any]]
    active_tab_id: str | None

    async def close(self) -> None: ...

    async def google_signed_in(self) -> bool: ...

    async def capture_website_session(self, origin: str) -> tuple[str | None, dict[str, Any]]: ...

    async def delete_context(self) -> None: ...

    async def navigate(self, url: str) -> None: ...

    async def select_tab(self, tab_id: str) -> None: ...

    async def close_tab(self, tab_id: str) -> None: ...


class BrowserProvider(Protocol):
    async def create(
        self,
        start_url: str,
        on_event: EventSink,
        *,
        context_id: str | None = None,
        login: RecordingLogin | None = None,
        country: str | None = None,
    ) -> BrowserSession:
        """Start a recording browser on ``start_url``.

        ``context_id`` is a borrowed Browserbase context with a saved sign-in: demonstrated sign-ins persist,
        but the session reports no context of its own, so nothing ever deletes it. ``login`` is filled into matching
        sign-in forms while the session is open. ``country`` (ISO 3166-1 alpha-2) picks the proxy exit used
        when the site blocks the direct browser.
        """
        ...


class _StartPageBlocked(Exception):
    """The site answered the start page with a block status; the caller retries over a proxy."""

    def __init__(self, status: int) -> None:
        super().__init__("Recording start page blocked")
        self.status = status


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
        network: Network = "direct",
        proxy_country: str | None = None,
    ) -> None:
        self.browser = browser
        self.runtime = runtime
        self.live_view_url = live_view_url
        self._fallback_live_view_url = live_view_url
        self.start_page_failed = False
        self.start_page_blocked = False
        self.network = network
        self.proxy_country = proxy_country
        # Status of each tab's latest main document, so a block page's own load does not count as a loaded page.
        self._main_status: dict[Any, int] = {}
        self._tabs: list[_Tab] = []
        self._active_tab_id: str | None = None
        self._next_tab_number = 1
        self._resolve_live_view: Callable[[Any], Awaitable[str | None]] | None = None
        self._capture_page_pending = False
        self._selection_generation = 0
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

    @property
    def active_tab_id(self) -> str | None:
        return self._active_tab_id

    @property
    def tabs(self) -> list[dict[str, Any]]:
        return [
            {
                "id": tab.id,
                "title": tab.title,
                "url": getattr(tab.page, "url", ""),
                "active": tab.id == self._active_tab_id,
            }
            for tab in self._tabs
        ]

    def tab_for(self, page: Any) -> _Tab | None:
        return next((tab for tab in self._tabs if tab.page is page), None)

    def register_tab(self, page: Any, live_view_url: str | None = None) -> _Tab:
        known = self.tab_for(page)
        if known is not None:
            return known
        tab = _Tab(f"tab-{self._next_tab_number}", page, live_view_url or self._fallback_live_view_url)
        self._next_tab_number += 1
        self._tabs.append(tab)
        if self._active_tab_id is None:
            self._active_tab_id = tab.id
            self.live_view_url = tab.live_view_url
        page.on("close", lambda _page: self.forget_tab(page))
        return tab

    async def update_title(self, page: Any) -> None:
        tab = self.tab_for(page)
        if tab is not None and not page.is_closed():
            with suppress(Exception):
                tab.title = await page.title()

    async def resolve_tab_live_view(self, tab: _Tab) -> None:
        if tab.live_view_url == self._fallback_live_view_url and self._resolve_live_view is not None:
            with suppress(Exception):
                live_view_url = await self._resolve_live_view(tab.page)
                if live_view_url is not None and self.tab_for(tab.page) is tab and not tab.page.is_closed():
                    tab.live_view_url = live_view_url
                    if self._active_tab_id == tab.id:
                        self.live_view_url = live_view_url

    async def select_tab(self, tab_id: str) -> None:
        tab = next((tab for tab in self._tabs if tab.id == tab_id), None)
        if tab is None or tab.page.is_closed():
            raise KeyError(tab_id)
        await self.resolve_tab_live_view(tab)
        await tab.page.bring_to_front()
        self._selection_generation += 1
        self._active_tab_id = tab.id
        self.live_view_url = tab.live_view_url

    async def close_tab(self, tab_id: str) -> None:
        tab = next((tab for tab in self._tabs if tab.id == tab_id), None)
        if tab is None or tab.page.is_closed():
            raise KeyError(tab_id)
        if len(self._tabs) == 1:
            raise ValueError("Cannot close the last tab.")
        await tab.page.close()
        self.forget_tab(tab.page)

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
        tab = self.tab_for(page)
        if tab is None or page.is_closed():
            return
        tab.live_view_url = live_view_url
        self._active_tab_id = tab.id
        self.live_view_url = live_view_url

    def forget_tab(self, page: Any) -> None:
        self.finish_tab(page)
        self._main_status.pop(page, None)
        index = next((index for index, tab in enumerate(self._tabs) if tab.page is page), None)
        if index is None:
            return
        was_active = self._tabs[index].id == self._active_tab_id
        self._tabs.pop(index)
        if was_active:
            previous = self._tabs[max(0, index - 1)] if self._tabs else None
            self._active_tab_id = previous.id if previous else None
            self.live_view_url = previous.live_view_url if previous else None
            if previous is not None and self._resolve_live_view is not None:
                self.watch(self.resolve_tab_live_view(previous))

    def track(self, coroutine: Awaitable[None]) -> None:
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def note_main_response(self, page: Any, status: int) -> None:
        self._main_status[page] = status

    def page_blocked(self, page: Any) -> bool:
        return self._main_status.get(page) in BLOCKED_STATUSES

    def watch(self, coroutine: Awaitable[None]) -> None:
        task = asyncio.create_task(coroutine)
        self._watchers.add(task)
        task.add_done_callback(self._watchers.discard)

    async def google_signed_in(self) -> bool:
        return has_google_session(await self.browser.contexts[0].cookies())

    async def capture_website_session(self, origin: str) -> tuple[str | None, dict[str, Any]]:
        """Capture before identity navigation; only a trusted Google page identifies the account."""
        from playwright.async_api import TimeoutError as PlaywrightTimeoutError

        context = self.browser.contexts[0]
        state = await context.storage_state()
        filtered = website_state(state, origin)
        logger.warning(
            "recording_website_capture raw_cookie_count=%s retained_cookie_count=%s "
            "dropped_cookie_domains=%s raw_local_storage_origin_count=%s retained_local_storage_origin_count=%s",
            len(state.get("cookies", [])),
            len(filtered["cookies"]),
            sorted(
                {
                    cookie["domain"].lower()
                    for cookie in state.get("cookies", [])
                    if cookie not in filtered["cookies"]
                    and isinstance(cookie.get("domain"), str)
                    and len(cookie["domain"]) <= 254
                    and re.fullmatch(r"\.?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*", cookie["domain"])
                }
            ),
            sum(bool(item.get("localStorage")) for item in state.get("origins", [])),
            len(filtered["origins"]),
        )
        if not has_google_session(state.get("cookies", [])):
            return None, filtered
        self._capture_page_pending = True
        try:
            page = await context.new_page()
        finally:
            self._capture_page_pending = False
        try:
            await page.goto("https://myaccount.google.com/", wait_until="domcontentloaded", timeout=10_000)
            # Copy of FIRE adapters/google_session.py complete(), with ambiguous labels rejected.
            if urlsplit(page.url).hostname != "myaccount.google.com" or urlsplit(page.url).scheme != "https":
                return None, filtered
            account = page.locator("[aria-label*='Google Account']")
            try:
                await account.first.wait_for(state="attached", timeout=2_000)
            except PlaywrightTimeoutError:
                return None, filtered
            labels = await account.evaluate_all(
                "elements => elements.map(element => element.getAttribute('aria-label'))"
            )
            emails = {
                email.lower()
                for label in labels
                if isinstance(label, str)
                for email in re.findall(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", label)
            }
            # Recheck after reading to reject a navigation away from the trusted document.
            if urlsplit(page.url).hostname != "myaccount.google.com" or urlsplit(page.url).scheme != "https":
                return None, filtered
            return (next(iter(emails)) if len(emails) == 1 else None), filtered
        finally:
            with suppress(Exception):
                async with asyncio.timeout(2):
                    await page.close()

    async def navigate(self, url: str, *, timeout_ms: int = NAVIGATE_TIMEOUT_MS) -> None:
        """Open a page in the active recording tab. Raises Playwright's own errors."""
        context = self.browser.contexts[0]
        if self._active_tab_id:
            page = next(tab.page for tab in self._tabs if tab.id == self._active_tab_id)
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
        self.start_page_blocked = self.page_blocked(page)

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

    tab = session.tab_for(page) or session.register_tab(page)

    async def page_event(event: dict[str, Any]) -> None:
        # Console payloads come from the website; only the provider assigns the tab identity.
        if event.get("type"):
            event["tabId"] = tab.id
        await on_event(event)

    def on_console(message: Any) -> None:
        event = console_event(message)
        if event is None:
            return
        # Signing in to Google is not a step an agent repeats: it uses the agent's connected Google account.
        if is_google_sign_in(page.url):
            return
        event.pop("openedNewTab", None)
        session.track(page_event(event))

    def on_navigation(frame: Any) -> None:
        # Embedded documents load on their own; they are not instructions to navigate the browser.
        # Their demonstrated interactions still arrive as console messages of the page that embeds them.
        if frame != page.main_frame or not is_public_http_url(frame.url) or is_google_sign_in(frame.url):
            return
        event = {"type": "navigation", "url": frame.url}
        if tab.first_navigation:
            event["openedNewTab"] = True
            tab.first_navigation = False
        session.track(page_event(event))

    def on_response(response: Any) -> None:
        if not response.request.is_navigation_request() or response.frame != page.main_frame:
            return
        session.note_main_response(page, response.status)
        # A site can let the first document through and block the one its challenge script requests next.
        if _blocked_status(response) is not None and is_public_http_url(response.url):
            session.start_page_blocked = True
            session.track(page_event({"type": "page_blocked", "status": response.status}))

    def on_page_loaded() -> None:
        # A 403 or similar block page renders like any other, but it is not the page the person asked for.
        if not is_public_http_url(page.url) or is_google_sign_in(page.url) or session.page_blocked(page):
            return
        session.start_page_failed = False
        session.start_page_blocked = False
        session.track(session.update_title(page))
        session.track(page_event({"type": "page_loaded", "url": page.url}))

    def on_download(download: Any) -> None:
        if is_google_sign_in(page.url):
            return
        session.watch(_report_download(download, page_event))

    page.on("console", on_console)
    page.on("framenavigated", on_navigation)
    page.on("response", on_response)
    page.on("domcontentloaded", on_page_loaded)
    # The live view shows no download bar, so the recorder reports each download to the person demonstrating.
    page.on("download", on_download)
    if session.login is not None:
        install_sign_in_fill(page, lambda: session.login, session.track)
    await session.update_title(page)
    try:
        # Chrome can reuse a popup's initial window while skipping init scripts on its first loaded document.
        await page.evaluate(CAPTURE_SCRIPT)
        await install_sign_in_capture(page.context, page, lambda event: session.track(page_event(event)))
    except Exception:
        if not page.is_closed():
            raise
    if tab.first_navigation and is_public_http_url(getattr(page, "url", "")) and not is_google_sign_in(page.url):
        tab.first_navigation = False
        session.track(page_event({"type": "navigation", "url": page.url, "openedNewTab": True}))


async def _report_download(download: Any, on_event: EventSink) -> None:
    download_id = str(uuid4())
    name = download.suggested_filename
    await on_event({"type": "download", "downloadId": download_id, "state": "started", "value": name})
    failure = await download.failure()
    await on_event({"type": "download", "downloadId": download_id, "state": "failed" if failure else "completed"})


async def _show_opened_tab(
    session: PlaywrightRecordingSession, client: Any, session_id: str, page: Any, generation: int
) -> None:
    """Resolve an opened tab's Live View; show it if foreground and not superseded.

    Browserbase's live view shows one tab. Without this, a sign-in window opened by "Continue with Google"
    stays invisible and the page looks like it ignored the click.
    """
    try:
        live_view_url = await _tab_live_view(client, session_id, page)
        if live_view_url is None:
            logger.warning("Opened tab has no live view")
            return
        tab = session.tab_for(page)
        if tab is None or page.is_closed():
            return
        tab.live_view_url = live_view_url
        # A background target=_blank must leave the current live view alone. Some sites/browsers do not
        # expose focus reliably during popup creation; those keep the previous foreground-popup behavior.
        try:
            foreground = await page.evaluate("document.hasFocus()")
        except Exception:
            foreground = True
        if foreground and generation == session._selection_generation:
            session.show_tab(page, live_view_url)
    except Exception:
        # The demonstration continues in the tab already shown.
        if not page.is_closed():
            logger.warning("Could not show the opened tab", exc_info=True)
    finally:
        session.finish_tab(page)


async def _tab_live_view(client: Any, session_id: str, page: Any) -> str | None:
    cdp = await page.context.new_cdp_session(page)
    try:
        target_id = (await cdp.send("Target.getTargetInfo"))["targetInfo"]["targetId"]
    finally:
        await cdp.detach()
    for _ in range(10):
        debug = await client.sessions.debug(session_id)
        listed = next((tab for tab in getattr(debug, "pages", None) or [] if tab.id == target_id), None)
        if listed is not None:
            return listed.debugger_fullscreen_url
        await asyncio.sleep(0.3)
    return None


async def _resolve_initial_live_view(
    session: PlaywrightRecordingSession, client: Any, session_id: str, page: Any
) -> None:
    try:
        live_view_url = await _tab_live_view(client, session_id, page)
    except Exception:
        logger.warning("Could not resolve the initial tab live view")
        return
    tab = session.tab_for(page)
    if tab is not None and live_view_url is not None:
        tab.live_view_url = live_view_url
        if session.active_tab_id == tab.id:
            session.live_view_url = live_view_url


async def _show_local_opened_tab(session: PlaywrightRecordingSession, page: Any, generation: int) -> None:
    try:
        foreground = await page.evaluate("document.hasFocus()")
    except Exception:
        foreground = True
    if foreground and not page.is_closed() and generation == session._selection_generation:
        tab = session.tab_for(page)
        if tab is not None:
            session._active_tab_id = tab.id


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
        proxy_country: str | None = None,
    ) -> None:
        self.project_id = project_id or os.environ.get("BROWSERBASE_PROJECT_ID")
        self.region = region
        self.timeout_seconds = min(max(timeout_seconds, 1), 900)
        # Where the residential proxy exits for the retry after a blocked start page. A bad value fails here,
        # at startup, rather than on the first blocked site.
        self.proxy_country = country_code(
            proxy_country or os.environ.get("BROWSERBASE_PROXY_COUNTRY") or DEFAULT_PROXY_COUNTRY
        )

    async def create(
        self,
        start_url: str,
        on_event: EventSink,
        *,
        context_id: str | None = None,
        login: RecordingLogin | None = None,
        country: str | None = None,
    ) -> BrowserSession:
        if not is_public_http_url(start_url):
            raise ValueError("The recording URL must be a public HTTP(S) URL.")
        if not self.project_id:
            raise RuntimeError("BROWSERBASE_PROJECT_ID is required.")
        retry_country = country_code(country) if country is not None else self.proxy_country
        try:
            # A borrowed sign-in context is not retried: Browserbase lets one session hold a context at a time,
            # and the released session may still be shutting down when the retry would open it again.
            return await self._start(
                start_url, on_event, saved_context_id=context_id, login=login, retry_when_blocked=context_id is None
            )
        except _StartPageBlocked as blocked:
            logger.warning("recording_start_page_blocked status=%s network=direct", blocked.status)
        return await self._start(
            start_url, on_event, saved_context_id=context_id, login=login, proxy_country=retry_country
        )

    async def _start(
        self,
        start_url: str,
        on_event: EventSink,
        *,
        saved_context_id: str | None,
        login: RecordingLogin | None,
        proxy_country: str | None = None,
        retry_when_blocked: bool = False,
    ) -> PlaywrightRecordingSession:
        """One startup attempt: a Browserbase session, the attached browser and the start page navigation.

        With ``proxy_country`` the session's traffic exits through Browserbase's residential proxy in that
        country. With ``retry_when_blocked`` a start page answered with a block status tears the attempt down
        (the same cleanup as any startup failure) and raises ``_StartPageBlocked`` for the caller to retry.
        """
        from browserbase import AsyncBrowserbase

        client = AsyncBrowserbase()
        network: Network = "direct" if proxy_country is None else "proxy"
        # A saved sign-in's context persists demonstrated website sign-ins but remains borrowed: only a
        # context this call creates is owned and may be deleted by this provider or the service.
        context_id: str | None = None
        created: Any | None = None
        runtime: Any | None = None
        browser: Any | None = None
        buffered_events: list[dict[str, Any]] = []
        event_state = "buffer" if retry_when_blocked else "live"

        async def attempt_event(event: dict[str, Any]) -> None:
            if event_state == "buffer":
                buffered_events.append(event)
            elif event_state == "live":
                await on_event(event)

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
            session_settings: dict[str, Any] = {
                "project_id": self.project_id,
                "keep_alive": True,
                "region": self.region,
                "api_timeout": max(self.timeout_seconds, 60),
                "browser_settings": {
                    "viewport": {"width": 1280, "height": 720},
                    "record_session": False,
                    "log_session": False,
                    # A person is in the live view and solves challenges; Browserbase's solver would fight them.
                    "solve_captchas": False,
                    "context": browser_context,
                },
            }
            if proxy_country is not None:
                session_settings["proxies"] = [{"type": "browserbase", "geolocation": {"country": proxy_country}}]
            created = await client.sessions.create(**session_settings)
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
                network=network,
                proxy_country=proxy_country,
            )
            session._resolve_live_view = lambda target_page: _tab_live_view(client, created.id, target_page)
            context = contexts[0]
            await _configure_context(context, attempt_event)
            page = context.pages[0] if context.pages else await context.new_page()
            session.register_tab(page)
            if getattr(debug, "pages", None):
                await _resolve_initial_live_view(session, client, created.id, page)
            elif getattr(debug, "pages", None) is not None:
                session.watch(_resolve_initial_live_view(session, client, created.id, page))
            for existing_page in context.pages:
                session.register_tab(existing_page)
                await _install_page_events(session, existing_page, attempt_event)

            def on_new_page(new_page: Any) -> None:
                if session._capture_page_pending:
                    return
                session.register_tab(new_page).first_navigation = True
                session.open_tab(new_page)
                session.track(_install_page_events(session, new_page, attempt_event))
                session.watch(_show_opened_tab(session, client, created.id, new_page, session._selection_generation))

            context.on("page", on_new_page)
            stage = "navigate"
            from playwright.async_api import Error as PlaywrightError
            from playwright.async_api import TimeoutError as PlaywrightTimeoutError

            try:
                response = await page.goto(
                    start_url,
                    wait_until="domcontentloaded",
                    timeout=(START_PAGE_ATTEMPT_TIMEOUT_SECONDS if retry_when_blocked else START_PAGE_TIMEOUT_SECONDS)
                    * 1000,
                )
            except PlaywrightTimeoutError:
                if retry_when_blocked and session.page_blocked(page):
                    raise _StartPageBlocked(session._main_status[page]) from None
                raise RecordingStartTimeout("The recording start page did not load in time.") from None
            except PlaywrightError as error:
                if retry_when_blocked and session.page_blocked(page):
                    raise _StartPageBlocked(session._main_status[page]) from None
                # The browser is up; the person can still open another page. Only the type: the message can
                # carry the connect URL.
                logger.warning("recording_start_page_failed error_type=%s", type(error).__name__)
                session.start_page_failed = True
            else:
                blocked = _blocked_status(response)
                if blocked is not None and retry_when_blocked:
                    raise _StartPageBlocked(blocked)
                if blocked is not None:
                    # The browser stays up on the block page; the person may open another page.
                    logger.warning("recording_start_page_blocked status=%s network=%s", blocked, network)
                    session.start_page_blocked = True
            if retry_when_blocked:
                for event in buffered_events:
                    await on_event(event)
                buffered_events.clear()
                event_state = "live"
            return session
        except BaseException as error:
            event_state = "discard"
            buffered_events.clear()
            if not isinstance(error, _StartPageBlocked):
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
        country: str | None = None,
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
        session.register_tab(page)
        await _install_page_events(session, page, on_event)

        def on_new_page(new_page: Any) -> None:
            if session._capture_page_pending:
                return
            session.register_tab(new_page).first_navigation = True
            session.track(_install_page_events(session, new_page, on_event))
            session.track(_show_local_opened_tab(session, new_page, session._selection_generation))

        context.on("page", on_new_page)
        from playwright.async_api import Error as PlaywrightError

        try:
            response = await page.goto(start_url, wait_until="domcontentloaded")
        except PlaywrightError as error:
            logger.warning("recording_start_page_failed error_type=%s", type(error).__name__)
            session.start_page_failed = True
        else:
            # No proxy to retry over locally; the block is only reported.
            session.start_page_blocked = _blocked_status(response) is not None
        self.last_session = session
        return session
