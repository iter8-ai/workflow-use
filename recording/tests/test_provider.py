from __future__ import annotations

import asyncio
import sys
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from workflow_use_recording.provider import BrowserbaseProvider


class FakePage:
    def __init__(self) -> None:
        self.goto_urls: list[str] = []

    def on(self, _event: str, _callback: Any) -> None:
        pass

    def is_closed(self) -> bool:
        return False

    async def goto(self, url: str, **_kwargs: Any) -> None:
        self.goto_urls.append(url)


class FakeContext:
    def __init__(self, page: FakePage) -> None:
        self.pages: list[FakePage] = []
        self._page = page

    async def route(self, _pattern: str, _handler: Any) -> None:
        pass

    async def expose_binding(self, _name: str, _callback: Any) -> None:
        pass

    async def add_init_script(self, _script: str) -> None:
        pass

    def on(self, _event: str, _callback: Any) -> None:
        pass

    async def new_page(self) -> FakePage:
        return self._page

    async def cookies(self) -> list[dict[str, Any]]:
        return []


class FakeBrowser:
    def __init__(self, context: FakeContext) -> None:
        self.contexts = [context]
        self.closed = False

    async def close(self) -> None:
        self.closed = True


class FakeRuntime:
    def __init__(self, browser: FakeBrowser) -> None:
        self.chromium = SimpleNamespace(connect_over_cdp=self.connect_over_cdp)
        self._browser = browser
        self.stopped = False

    async def connect_over_cdp(self, _connect_url: str) -> FakeBrowser:
        return self._browser

    async def stop(self) -> None:
        self.stopped = True


@pytest.mark.asyncio
async def test_browserbase_session_disables_provider_recording_and_logs(monkeypatch: pytest.MonkeyPatch) -> None:
    page = FakePage()
    runtime = FakeRuntime(FakeBrowser(FakeContext(page)))
    clients: list[Any] = []

    class FakeSessions:
        def __init__(self) -> None:
            self.create_calls: list[dict[str, Any]] = []
            self.releases: list[dict[str, str]] = []

        async def create(self, **kwargs: Any) -> Any:
            self.create_calls.append(kwargs)
            return SimpleNamespace(id="session-1", connect_url="wss://connect.browserbase.test/session-1")

        async def debug(self, _session_id: str) -> Any:
            return SimpleNamespace(debugger_fullscreen_url="https://live.browserbase.com/session-1")

        async def update(self, session_id: str, **kwargs: str) -> None:
            self.releases.append({"session_id": session_id, **kwargs})

    class FakeAsyncBrowserbase:
        def __init__(self) -> None:
            self.sessions = FakeSessions()
            self.contexts = SimpleNamespace(create=self.create_context)
            clients.append(self)

        async def create_context(self, **kwargs: Any) -> Any:
            assert kwargs == {"project_id": "project-1"}
            return SimpleNamespace(id="context-secret")

        async def __aexit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
            pass

    browserbase = ModuleType("browserbase")
    browserbase.AsyncBrowserbase = FakeAsyncBrowserbase  # type: ignore[attr-defined]
    playwright_async_api = ModuleType("playwright.async_api")
    playwright_async_api.async_playwright = lambda: SimpleNamespace(start=lambda: _start(runtime))  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "browserbase", browserbase)
    monkeypatch.setitem(sys.modules, "playwright.async_api", playwright_async_api)

    provider = BrowserbaseProvider(project_id="project-1")
    session = await provider.create("https://example.com/reports", _ignore_event)

    assert session.live_view_url == "https://live.browserbase.com/session-1"
    assert clients[0].sessions.create_calls == [
        {
            "project_id": "project-1",
            "keep_alive": True,
            "region": "eu-central-1",
            "api_timeout": 900,
            "browser_settings": {
                "viewport": {"width": 1280, "height": 720},
                "record_session": False,
                "log_session": False,
                "context": {"id": "context-secret", "persist": True},
            },
        }
    ]
    assert page.goto_urls == ["https://example.com/reports"]

    await session.close()


@pytest.mark.asyncio
async def test_browserbase_session_failure_deletes_the_new_context(monkeypatch: pytest.MonkeyPatch) -> None:
    deleted: list[tuple[str, dict[str, Any]]] = []

    class FailingClient:
        def __init__(self) -> None:
            self.contexts = SimpleNamespace(create=self.create_context)
            self.sessions = SimpleNamespace(create=self.create_session)

        async def create_context(self, **_kwargs: Any) -> Any:
            return SimpleNamespace(id="context-private")

        async def create_session(self, **_kwargs: Any) -> Any:
            raise RuntimeError("provider failure")

        async def delete(self, path: str, **kwargs: Any) -> None:
            deleted.append((path, kwargs))

        async def __aexit__(self, *_args: Any) -> None:
            pass

    browserbase = ModuleType("browserbase")
    browserbase.AsyncBrowserbase = FailingClient  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "browserbase", browserbase)
    with pytest.raises(RuntimeError, match="provider failure"):
        await BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event)
    assert deleted == [("/v1/contexts/context-private", {"cast_to": object, "body": {}})]


async def _ignore_event(_event: dict[str, Any]) -> None:
    pass


async def _start(runtime: FakeRuntime) -> FakeRuntime:
    return runtime


@pytest.mark.asyncio
async def test_popup_closed_before_listener_attachment_is_ignored() -> None:
    from workflow_use_recording.provider import PlaywrightRecordingSession, _install_page_events

    class ClosingContext:
        async def new_cdp_session(self, page: Any) -> Any:
            page.closed = True
            raise RuntimeError("Target.attachToTarget: No target with given id found")

    class ClosingPage(FakePage):
        def __init__(self) -> None:
            super().__init__()
            self.closed = False
            self.context = ClosingContext()

        def is_closed(self) -> bool:
            return self.closed

    page = ClosingPage()
    session = PlaywrightRecordingSession(browser=object(), runtime=object(), live_view_url=None)
    session.track(_install_page_events(session, page, _ignore_event))
    await asyncio.gather(*session._tasks)
    assert page.closed


@pytest.mark.asyncio
async def test_a_download_in_the_demonstration_browser_is_reported_when_it_starts_and_finishes() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    from urllib.parse import quote

    from workflow_use_recording.provider import PlaywrightRecordingSession, _install_page_events

    events: list[dict[str, Any]] = []

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    runtime = await playwright.async_playwright().start()
    browser = await runtime.chromium.launch()
    session = PlaywrightRecordingSession(browser=browser, runtime=runtime, live_view_url=None)
    page = await (await browser.new_context()).new_page()
    await _install_page_events(session, page, record)
    link = '<a download="statement-2026-09.csv" href="data:text/csv;base64,YSxiCjEsMgo=">Export CSV</a>'
    await page.goto("data:text/html," + quote(link))
    await page.get_by_text("Export CSV").click()
    for _ in range(100):
        if any(event.get("state") == "completed" for event in events):
            break
        await asyncio.sleep(0.02)
    await session.close()

    downloads = [event for event in events if event.get("type") == "download"]
    assert [(event["state"], event.get("value")) for event in downloads] == [
        ("started", "statement-2026-09.csv"),
        ("completed", None),
    ]
    assert downloads[0]["downloadId"] == downloads[1]["downloadId"]


@pytest.mark.asyncio
async def test_closing_the_browser_mid_download_does_not_hang() -> None:
    from workflow_use_recording.provider import PlaywrightRecordingSession

    never = asyncio.Event()
    stopped: list[bool] = []

    async def wait_forever() -> None:
        await never.wait()

    class Closeable:
        async def close(self) -> None:
            pass

    class Runtime:
        async def stop(self) -> None:
            stopped.append(True)

    session = PlaywrightRecordingSession(browser=Closeable(), runtime=Runtime(), live_view_url=None)
    session.watch(wait_forever())
    await asyncio.wait_for(session.close(), 2)
    assert stopped == [True]


@pytest.mark.asyncio
@pytest.mark.parametrize("start_path", ["", "/", "/redirect"])
async def test_browser_startup_records_only_top_level_navigation(
    monkeypatch: pytest.MonkeyPatch, start_path: str
) -> None:
    from workflow_use_recording import provider as recording_provider
    from workflow_use_recording.service import RecordingOwner, RecordingService

    playwright = pytest.importorskip("playwright.async_api")
    context_route = playwright.BrowserContext.route

    async def fixture_route(context: Any, pattern: Any, handler: Any, **kwargs: Any) -> None:
        await context_route(context, pattern, handler, **kwargs)

        async def serve(route: Any) -> None:
            url = route.request.url
            if url == "https://example.com/redirect":
                await route.fulfill(content_type="text/html", body="<script>location.replace('/')</script>")
            elif url == "https://example.com/":
                await route.fulfill(
                    content_type="text/html",
                    body="""
                    <iframe name="reports" src="https://example.com/widget"></iframe>
                    <iframe src="https://widgets.example.org/embedded"></iframe>
                    <a href="/next">Next</a>
                """,
                )
            elif url.endswith("/widget"):
                await route.fulfill(content_type="text/html", body="<button>Reports</button>")
            elif url.endswith("/embedded"):
                await route.fulfill(content_type="text/html", body="<button>Embedded reports</button>")
            else:
                await route.fulfill(content_type="text/html", body='<a href="/">Back to start</a>')

        # Controlled fixture responses, with real browser navigation and recorder listeners.
        await context_route(context, "**/*", serve)

    monkeypatch.setattr(playwright.BrowserContext, "route", fixture_route)
    provider = recording_provider.LocalPlaywrightProvider()
    service = RecordingService(provider)
    owner = RecordingOwner("iter7", "owner@iter7.example")
    try:
        recording = await service.create(owner, "https://example.com" + start_path)
        assert provider.last_session is not None
        page = provider.last_session.browser.contexts[0].pages[0]
        await page.wait_for_url("https://example.com/", wait_until="load")
        initial = [("navigation", "https://example.com/redirect", None)] if start_path == "/redirect" else []
        initial.append(("navigation", "https://example.com/", None))
        assert [(step.type, step.url, step.target) for step in recording.steps] == initial
        await page.frame_locator('iframe[name="reports"]').get_by_role("button", name="Reports").click()
        await page.frame_locator('iframe[src$="/embedded"]').get_by_role("button", name="Embedded reports").click()
        await page.get_by_role("link", name="Next", exact=True).click()
        await page.get_by_role("link", name="Back to start").click()
        await page.wait_for_load_state("load")
        expected = initial + [
            ("click", None, "Reports"),
            ("click", None, "Embedded reports"),
            ("click", None, "Next"),
            ("navigation", "https://example.com/next", None),
            ("click", None, "Back to start"),
            ("navigation", "https://example.com/", None),
        ]
        assert [(step.type, step.url, step.target) for step in recording.steps] == expected
        await service.stop(recording.id, owner)
        assert [(step.type, step.url, step.target) for step in service.response(recording).steps] == expected
    finally:
        await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "google_host", ["accounts.google.com", "accounts.google.ee", "accounts.google.co.uk", "accounts.youtube.com"]
)
async def test_a_sign_in_window_the_website_opens_is_shown_in_the_live_view_and_not_recorded(
    monkeypatch: pytest.MonkeyPatch,
    google_host: str,
) -> None:
    """Browserbase's live view shows one tab. When a site's "Continue with Google" opens a window, the person
    demonstrating must see that window, then the site again once it closes. Google's sign-in is not a step."""
    from workflow_use_recording.service import RecordingOwner, RecordingService

    playwright = pytest.importorskip("playwright.async_api")
    context_route = playwright.BrowserContext.route

    async def fixture_route(context: Any, pattern: Any, handler: Any, **kwargs: Any) -> None:
        await context_route(context, pattern, handler, **kwargs)

        async def serve(route: Any) -> None:
            if route.request.url.startswith(f"https://{google_host}/"):
                body = """
                    <label>Email or phone <input type="email" autocomplete="username"></label>
                    <label>Password <input type="password" name="Passwd"></label>
                    <button>Next</button>
                """
            else:
                body = f"""<button onclick="window.open('https://{google_host}/signin', 'google', 'popup')">
                    Continue with Google</button>"""
            await route.fulfill(content_type="text/html", body=body)

        await context_route(context, "**/*", serve)

    monkeypatch.setattr(playwright.BrowserContext, "route", fixture_route)
    runtime = await playwright.async_playwright().start()
    browser = await runtime.chromium.launch()
    context = await browser.new_context()

    async def tabs() -> list[Any]:
        listed = []
        for page in context.pages:
            cdp = await context.new_cdp_session(page)
            target_id = (await cdp.send("Target.getTargetInfo"))["targetInfo"]["targetId"]
            await cdp.detach()
            listed.append(
                SimpleNamespace(id=target_id, debugger_fullscreen_url=f"https://live.browserbase.com/{target_id}")
            )
        return listed

    class Sessions:
        async def create(self, **_kwargs: Any) -> Any:
            return SimpleNamespace(id="session-1", connect_url="wss://connect.browserbase.test/session-1")

        async def debug(self, _session_id: str) -> Any:
            return SimpleNamespace(debugger_fullscreen_url="https://live.browserbase.com/first-tab", pages=await tabs())

        async def update(self, _session_id: str, **_kwargs: str) -> None:
            pass

    class AsyncBrowserbase:
        def __init__(self) -> None:
            self.sessions = Sessions()
            self.contexts = SimpleNamespace(create=self.create_context)

        async def create_context(self, **_kwargs: Any) -> Any:
            return SimpleNamespace(id="context-secret")

        async def delete(self, _path: str, **_kwargs: Any) -> None:
            pass

        async def __aexit__(self, *_args: Any) -> None:
            pass

    async def connect_over_cdp(_connect_url: str) -> Any:
        return browser

    browserbase = ModuleType("browserbase")
    browserbase.AsyncBrowserbase = AsyncBrowserbase  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "browserbase", browserbase)
    service = RecordingService(BrowserbaseProvider(project_id="project-1"))
    owner = RecordingOwner("iter7", "owner@iter7.example")
    monkeypatch.setattr(runtime.chromium, "connect_over_cdp", connect_over_cdp)
    monkeypatch.setattr(playwright, "async_playwright", lambda: SimpleNamespace(start=lambda: _start(runtime)))

    async def live_view_becomes(expected: str) -> None:
        for _ in range(100):
            if service.response(recording).live_view_url == expected:
                return
            await asyncio.sleep(0.05)
        assert service.response(recording).live_view_url == expected

    try:
        recording = await service.create(owner, "https://example.com/login")
        assert service.response(recording).live_view_url == "https://live.browserbase.com/first-tab"
        site = context.pages[0]
        async with site.expect_popup() as opened:
            await site.get_by_role("button", name="Continue with Google").click()
        google = await opened.value
        await google.wait_for_load_state()
        first_tab, popup_tab = await tabs()
        assert first_tab.id != popup_tab.id
        await live_view_becomes(popup_tab.debugger_fullscreen_url)

        await google.get_by_label("Email or phone").fill("person@example.com")
        await google.get_by_label("Password").press_sequentially("google-password")
        await google.get_by_role("button", name="Next").click()
        await google.close()
        await live_view_becomes("https://live.browserbase.com/first-tab")

        await service.stop(recording.id, owner)
        assert [(step.type, step.target) for step in recording.steps] == [
            ("navigation", None),
            ("click", "Continue with Google"),
        ]
        assert service.take_credentials(recording) == {}
    finally:
        await service.close()
