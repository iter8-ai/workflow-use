from __future__ import annotations

import asyncio
import json
import sys
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from workflow_use_recording.provider import BrowserbaseProvider, RecordingStartTimeout, _PendingContextCleanup


class FakePage:
    def __init__(self) -> None:
        self.goto_urls: list[str] = []

    def on(self, _event: str, _callback: Any) -> None:
        pass

    def is_closed(self) -> bool:
        return False

    async def goto(self, url: str, **_kwargs: Any) -> None:
        self.goto_urls.append(url)

    async def wait_for_load_state(self, _state: str, **_kwargs: Any) -> None:
        pass


class FakeContext:
    def __init__(self, page: FakePage) -> None:
        self.pages: list[FakePage] = []
        self._page = page

    async def route(self, _pattern: str, _handler: Any) -> None:
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
    monkeypatch.setitem(sys.modules, "browserbase", browserbase)
    monkeypatch.setattr("workflow_use_recording.provider._start_playwright_runtime", lambda: _start(runtime))

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
                "solve_captchas": False,
                "context": {"id": "context-secret", "persist": True},
            },
        }
    ]
    assert page.goto_urls == ["https://example.com/reports"]
    assert (session.network, session.proxy_country, session.start_page_blocked) == ("direct", None, False)

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


@pytest.mark.asyncio
async def test_failed_startup_cleanup_can_be_retried_without_exposing_context_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    deleted: list[str] = []

    class FailingClient:
        def __init__(self) -> None:
            self.contexts = SimpleNamespace(create=self.create_context)
            self.sessions = SimpleNamespace(create=self.create_session)

        async def create_context(self, **_kwargs: Any) -> Any:
            return SimpleNamespace(id="context-private")

        async def create_session(self, **_kwargs: Any) -> Any:
            raise RuntimeError("provider failure")

        async def delete(self, path: str, **_kwargs: Any) -> None:
            deleted.append(path)
            if len(deleted) == 1:
                raise RuntimeError("temporary delete failure")

        async def __aexit__(self, *_args: Any) -> None:
            pass

    browserbase = ModuleType("browserbase")
    browserbase.AsyncBrowserbase = FailingClient  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "browserbase", browserbase)

    with pytest.raises(_PendingContextCleanup) as caught:
        await BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event)

    assert caught.value.context_id == "context-private"
    assert "context-private" not in str(caught.value)
    assert "context-private" not in repr(caught.value)
    await caught.value.delete_context()
    assert deleted == ["/v1/contexts/context-private"] * 2


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
    popup_debug_ready = asyncio.Event()

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
            if len(context.pages) > 1:
                await popup_debug_ready.wait()
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
    monkeypatch.setattr("workflow_use_recording.provider._start_playwright_runtime", lambda: _start(runtime))

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
        assert service.response(recording).live_view_switching is True
        popup_debug_ready.set()
        first_tab, popup_tab = await tabs()
        assert first_tab.id != popup_tab.id
        await live_view_becomes(popup_tab.debugger_fullscreen_url)
        assert service.response(recording).live_view_switching is False

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


@pytest.mark.asyncio
async def test_popup_live_view_switching_expires_after_fifteen_seconds(monkeypatch: pytest.MonkeyPatch) -> None:
    from datetime import UTC, datetime

    from workflow_use_recording import provider
    from workflow_use_recording.service import Recording, RecordingOwner, RecordingService

    monkeypatch.setattr(provider, "LIVE_VIEW_SWITCH_TIMEOUT_SECONDS", 0.01)
    session = provider.PlaywrightRecordingSession(browser=object(), runtime=object(), live_view_url="first")
    recording = Recording("id", RecordingOwner("org", "user@example.com"), datetime.now(UTC), browser=session)
    page = object()
    session.open_tab(page)
    assert RecordingService.response(recording).live_view_switching is True
    await asyncio.sleep(0.02)
    assert RecordingService.response(recording).live_view_switching is False


@pytest.mark.parametrize(
    "stage",
    ["create_context", "create_session", "debug_session", "start_runtime", "connect", "configure", "navigate"],
)
@pytest.mark.asyncio
async def test_browser_startup_failure_names_its_stage_without_connection_details(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, stage: str
) -> None:
    connect_url = "wss://connect.example/?signingKey=must-not-leak"

    def fail_at(current_stage: str) -> None:
        if stage == current_stage:
            raise RuntimeError(f"WebSocket error: {connect_url}")

    class Client:
        def __init__(self) -> None:
            self.contexts = SimpleNamespace(create=self.create_context)
            self.sessions = SimpleNamespace(create=self.create_session, debug=self.debug, update=self.update)

        async def create_context(self, **_kwargs: Any) -> Any:
            fail_at("create_context")
            return SimpleNamespace(id="context-private")

        async def create_session(self, **_kwargs: Any) -> Any:
            fail_at("create_session")
            return SimpleNamespace(id="session-1", connect_url=connect_url)

        async def debug(self, _session_id: str) -> Any:
            fail_at("debug_session")
            return SimpleNamespace(debugger_fullscreen_url="https://live.example/")

        async def update(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        async def delete(self, _path: str, **_kwargs: Any) -> None:
            pass

        async def __aexit__(self, *_args: Any) -> None:
            pass

    class Runtime:
        def __init__(self) -> None:
            self.chromium = SimpleNamespace(connect_over_cdp=self.connect_over_cdp)

        async def connect_over_cdp(self, _connect_url: str) -> Any:
            fail_at("connect")
            return FakeBrowser(Context(Page()))

        async def stop(self) -> None:
            pass

    class Context(FakeContext):
        async def route(self, _pattern: str, _handler: Any) -> None:
            fail_at("configure")

    class Page(FakePage):
        async def goto(self, url: str, **_kwargs: Any) -> None:
            fail_at("navigate")
            await super().goto(url)

    browserbase = ModuleType("browserbase")
    browserbase.AsyncBrowserbase = Client  # type: ignore[attr-defined]
    runtime = Runtime()

    async def start() -> Runtime:
        fail_at("start_runtime")
        return runtime

    monkeypatch.setitem(sys.modules, "browserbase", browserbase)
    monkeypatch.setattr("workflow_use_recording.provider._start_playwright_runtime", start)

    with caplog.at_level("WARNING", logger="workflow_use_recording.provider"):
        with pytest.raises(RuntimeError):
            await BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event)

    # The service prints only the message text, so the stage and error type must be in it.
    messages = [record.getMessage() for record in caplog.records if record.levelname == "WARNING"]
    assert f"recording_browser_start_failed stage={stage} error_type=RuntimeError" in messages
    assert "WebSocket error" not in caplog.text
    assert connect_url not in caplog.text
    assert "must-not-leak" not in caplog.text
    assert "Traceback" not in caplog.text


def _browserbase_with(monkeypatch: pytest.MonkeyPatch, runtime: FakeRuntime) -> SimpleNamespace:
    calls = SimpleNamespace(releases=[], deleted=[])

    class Client:
        def __init__(self) -> None:
            self.contexts = SimpleNamespace(create=self.create_context)
            self.sessions = SimpleNamespace(create=self.create_session, debug=self.debug, update=self.update)

        async def create_context(self, **_kwargs: Any) -> Any:
            return SimpleNamespace(id="context-private")

        async def create_session(self, **_kwargs: Any) -> Any:
            return SimpleNamespace(id="session-1", connect_url="wss://connect.example/?signingKey=must-not-leak")

        async def debug(self, _session_id: str) -> Any:
            return SimpleNamespace(debugger_fullscreen_url="https://live.example/")

        async def update(self, *_args: Any, **_kwargs: Any) -> None:
            calls.releases.append(1)

        async def delete(self, path: str, **_kwargs: Any) -> None:
            calls.deleted.append(path)

        async def __aexit__(self, *_args: Any) -> None:
            pass

    browserbase = ModuleType("browserbase")
    browserbase.AsyncBrowserbase = Client  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "browserbase", browserbase)
    monkeypatch.setattr("workflow_use_recording.provider._start_playwright_runtime", lambda: _start(runtime))
    return calls


@pytest.mark.asyncio
async def test_a_start_page_that_fails_to_load_keeps_the_session_open(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from playwright.async_api import Error as PlaywrightError

    class Page(FakePage):
        async def goto(self, url: str, **_kwargs: Any) -> None:
            self.goto_urls.append(url)
            raise PlaywrightError(
                "net::ERR_HTTP_RESPONSE_CODE_FAILURE at wss://connect.example/?signingKey=must-not-leak"
            )

    page = Page()
    browser = FakeBrowser(FakeContext(page))
    runtime = FakeRuntime(browser)
    calls = _browserbase_with(monkeypatch, runtime)

    with caplog.at_level("WARNING", logger="workflow_use_recording.provider"):
        session = await BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event)

    assert session.start_page_failed is True
    assert not browser.closed and not runtime.stopped
    assert calls.releases == [] and calls.deleted == []
    assert "recording_start_page_failed error_type=Error" in caplog.text
    assert "must-not-leak" not in caplog.text

    # The next page the person opens clears the failure.
    page.goto = lambda url, **_kwargs: _ok(page, url)  # type: ignore[method-assign]
    await session.navigate("https://example.com/login")
    assert session.start_page_failed is False
    assert page.goto_urls[-1] == "https://example.com/login"


@pytest.mark.asyncio
async def test_start_page_timeout_closes_browser_and_releases_session(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError

    class Page(FakePage):
        async def goto(self, url: str, **kwargs: Any) -> None:
            assert kwargs["timeout"] == 20_000
            raise PlaywrightTimeoutError("wss://connect.example/?signingKey=must-not-leak")

    browser = FakeBrowser(FakeContext(Page()))
    runtime = FakeRuntime(browser)
    calls = _browserbase_with(monkeypatch, runtime)

    with caplog.at_level("WARNING", logger="workflow_use_recording.provider"):
        with pytest.raises(RecordingStartTimeout):
            await BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event)

    assert browser.closed and runtime.stopped
    assert calls.releases == [1]
    assert calls.deleted == ["/v1/contexts/context-private"]
    assert "must-not-leak" not in caplog.text


@pytest.mark.asyncio
async def test_create_deadline_cancels_hung_navigation_and_cleans_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import workflow_use_recording.service as service_module
    from workflow_use_recording.service import RecordingOwner, RecordingService

    class Page(FakePage):
        async def goto(self, url: str, **_kwargs: Any) -> None:
            await asyncio.Event().wait()

    browser = FakeBrowser(FakeContext(Page()))
    runtime = FakeRuntime(browser)
    calls = _browserbase_with(monkeypatch, runtime)
    monkeypatch.setattr(service_module, "CREATE_TIMEOUT_SECONDS", 0.01)
    service = RecordingService(BrowserbaseProvider(project_id="project-1"), max_sessions=1)

    with pytest.raises(RecordingStartTimeout):
        await service.create(RecordingOwner("iter7", "owner@iter7.example"), "https://example.com")

    assert browser.closed and runtime.stopped
    assert calls.releases == [1]
    assert calls.deleted == ["/v1/contexts/context-private"]
    assert service._recordings == {}


@pytest.mark.asyncio
async def test_hung_browser_close_does_not_block_session_release(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError

    import workflow_use_recording.provider as provider_module

    class Page(FakePage):
        async def goto(self, url: str, **_kwargs: Any) -> None:
            raise PlaywrightTimeoutError("start page timeout")

    class Browser(FakeBrowser):
        async def close(self) -> None:
            await asyncio.Event().wait()

    browser = Browser(FakeContext(Page()))
    runtime = FakeRuntime(browser)
    calls = _browserbase_with(monkeypatch, runtime)
    monkeypatch.setattr(provider_module, "CLEANUP_TIMEOUT_SECONDS", 0.01)

    with pytest.raises(RecordingStartTimeout):
        await asyncio.wait_for(
            BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event), 1
        )

    assert runtime.stopped
    assert calls.releases == [1]
    assert calls.deleted == ["/v1/contexts/context-private"]


async def _ok(page: FakePage, url: str) -> None:
    page.goto_urls.append(url)


@pytest.mark.asyncio
async def test_navigate_retries_once_when_the_error_page_commit_interrupts_it() -> None:
    from playwright.async_api import Error as PlaywrightError

    from workflow_use_recording.provider import PlaywrightRecordingSession

    class Page(FakePage):
        async def goto(self, url: str, **_kwargs: Any) -> None:
            self.goto_urls.append(url)
            if len(self.goto_urls) == 1:
                raise PlaywrightError(
                    'Page.goto: Navigation to "https://example.com/login" is interrupted by another navigation to "chrome-error://chromewebdata/"'
                )

    page = Page()
    context = FakeContext(page)
    context.pages = [page]
    session = PlaywrightRecordingSession(browser=FakeBrowser(context), runtime=object(), live_view_url=None)
    session.start_page_failed = True

    await session.navigate("https://example.com/login")

    assert page.goto_urls == ["https://example.com/login", "https://example.com/login"]
    assert session.start_page_failed is False


@pytest.mark.asyncio
async def test_navigate_accepts_an_interrupted_navigation_that_still_landed() -> None:
    from playwright.async_api import Error as PlaywrightError

    from workflow_use_recording.provider import PlaywrightRecordingSession

    class Page(FakePage):
        url = "chrome-error://chromewebdata/"

        async def goto(self, url: str, **_kwargs: Any) -> None:
            self.goto_urls.append(url)
            self.url = url
            raise PlaywrightError(
                'Page.goto: Navigation to "https://example.com/login" is interrupted by another navigation to "chrome-error://chromewebdata/"'
            )

    page = Page()
    context = FakeContext(page)
    context.pages = [page]
    session = PlaywrightRecordingSession(browser=FakeBrowser(context), runtime=object(), live_view_url=None)
    session.start_page_failed = True

    await session.navigate("https://example.com/login")

    assert page.goto_urls == ["https://example.com/login"]
    assert session.start_page_failed is False


@pytest.mark.asyncio
async def test_navigate_gives_up_after_repeated_interruptions() -> None:
    from playwright.async_api import Error as PlaywrightError

    from workflow_use_recording.provider import PlaywrightRecordingSession

    errors = [
        PlaywrightError(f'Page.goto: interrupted by another navigation to "chrome-error://chromewebdata/" ({attempt})')
        for attempt in range(3)
    ]

    class Page(FakePage):
        url = "chrome-error://chromewebdata/"

        async def goto(self, url: str, **_kwargs: Any) -> None:
            self.goto_urls.append(url)
            raise errors[len(self.goto_urls) - 1]

    page = Page()
    context = FakeContext(page)
    context.pages = [page]
    session = PlaywrightRecordingSession(browser=FakeBrowser(context), runtime=object(), live_view_url=None)
    session.start_page_failed = True

    with pytest.raises(PlaywrightError) as caught:
        await session.navigate("https://example.com/login")

    assert caught.value is errors[-1]
    assert len(page.goto_urls) == 3
    assert session.start_page_failed is True


@pytest.mark.asyncio
async def test_navigate_does_not_recover_an_unrelated_interruption_even_if_it_lands() -> None:
    from playwright.async_api import Error as PlaywrightError

    from workflow_use_recording.provider import PlaywrightRecordingSession

    error = PlaywrightError('Page.goto: Navigation to "x" is interrupted by another navigation to "y"')

    class Page(FakePage):
        async def goto(self, url: str, **_kwargs: Any) -> None:
            self.goto_urls.append(url)
            self.url = url
            raise error

    page = Page()
    context = FakeContext(page)
    context.pages = [page]
    session = PlaywrightRecordingSession(browser=FakeBrowser(context), runtime=object(), live_view_url=None)
    session.start_page_failed = True

    with pytest.raises(PlaywrightError) as caught:
        await session.navigate("https://example.com/login")

    assert caught.value is error
    assert page.goto_urls == ["https://example.com/login"]
    assert session.start_page_failed is True


@pytest.mark.asyncio
async def test_navigate_accepts_target_landed_during_final_settle() -> None:
    from playwright.async_api import Error as PlaywrightError

    from workflow_use_recording.provider import PlaywrightRecordingSession

    class Page(FakePage):
        url = "chrome-error://chromewebdata/"

        async def goto(self, url: str, **_kwargs: Any) -> None:
            self.goto_urls.append(url)
            raise PlaywrightError('Page.goto: interrupted by another navigation to "chrome-error://chromewebdata/"')

        async def wait_for_load_state(self, _state: str, **_kwargs: Any) -> None:
            if len(self.goto_urls) == 3:
                self.url = "https://example.com/login/"
            else:
                raise PlaywrightError("load interrupted")

    page = Page()
    context = FakeContext(page)
    context.pages = [page]
    session = PlaywrightRecordingSession(browser=FakeBrowser(context), runtime=object(), live_view_url=None)
    session.start_page_failed = True

    await session.navigate("https://example.com/login")

    assert page.goto_urls == ["https://example.com/login"] * 3
    assert session.start_page_failed is False


@pytest.mark.asyncio
async def test_navigate_does_not_retry_other_navigation_errors() -> None:
    from playwright.async_api import Error as PlaywrightError

    from workflow_use_recording.provider import PlaywrightRecordingSession

    class Page(FakePage):
        async def goto(self, url: str, **_kwargs: Any) -> None:
            self.goto_urls.append(url)
            raise PlaywrightError("net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://example.com/login")

    page = Page()
    context = FakeContext(page)
    context.pages = [page]
    session = PlaywrightRecordingSession(browser=FakeBrowser(context), runtime=object(), live_view_url=None)
    session.start_page_failed = True

    with pytest.raises(PlaywrightError):
        await session.navigate("https://example.com/login")

    assert page.goto_urls == ["https://example.com/login"]
    assert session.start_page_failed is True


@pytest.mark.asyncio
async def test_only_a_loaded_public_main_page_clears_the_start_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    from workflow_use_recording import provider

    async def no_capture(*_args: Any) -> None:
        pass

    monkeypatch.setattr(provider, "install_sign_in_capture", no_capture)
    events: list[dict[str, Any]] = []

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    class Page(FakePage):
        def __init__(self) -> None:
            super().__init__()
            self.handlers: dict[str, Any] = {}
            self.context = object()
            self.main_frame = SimpleNamespace(url="https://example.com/login")
            self.url = "about:blank"

        def on(self, event: str, callback: Any) -> None:
            self.handlers[event] = callback

    session = provider.PlaywrightRecordingSession(browser=object(), runtime=object(), live_view_url=None)
    session.start_page_failed = True
    page = Page()
    await provider._install_page_events(session, page, record)

    page.handlers["framenavigated"](page.main_frame)
    await asyncio.gather(*session._tasks)
    assert session.start_page_failed is True
    assert events == [{"type": "navigation", "url": "https://example.com/login"}]

    for url in ("about:blank", "chrome-error://chromewebdata/", "https://accounts.google.com/login"):
        page.url = url
        page.handlers["domcontentloaded"]()
        assert session.start_page_failed is True

    popup = Page()
    popup.url = "https://example.com/login"
    await provider._install_page_events(session, popup, record)
    popup.handlers["domcontentloaded"]()
    await asyncio.gather(*session._tasks)
    assert session.start_page_failed is False
    assert events[-1] == {"type": "page_loaded", "url": "https://example.com/login"}


class _ConsoleMessage(SimpleNamespace):
    """What Playwright hands a ``page.on("console")`` listener: the message type, text and argument handles."""

    def __init__(self, *args: Any, type: str = "debug") -> None:
        super().__init__(type=type, args=list(args), text=" ".join(args))


@pytest.mark.asyncio
async def test_a_console_message_with_the_recorder_prefix_becomes_a_step_and_garbage_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from workflow_use_recording import provider

    async def no_capture(*_args: Any) -> None:
        pass

    monkeypatch.setattr(provider, "install_sign_in_capture", no_capture)
    events: list[dict[str, Any]] = []

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    class Page(FakePage):
        def __init__(self) -> None:
            super().__init__()
            self.handlers: dict[str, Any] = {}
            self.context = object()
            self.url = "https://example.com/login"

        def on(self, event: str, callback: Any) -> None:
            self.handlers[event] = callback

    session = provider.PlaywrightRecordingSession(browser=object(), runtime=object(), live_view_url=None)
    page = Page()
    await provider._install_page_events(session, page, record)
    on_console = page.handlers["console"]

    on_console(_ConsoleMessage("__workflowUse__", json.dumps({"type": "click", "target": "Sign in"})))
    # Malformed or foreign console output: not JSON, not an object, the wrong prefix, no prefix, extra arguments,
    # another console level. None of it is a step.
    on_console(_ConsoleMessage("__workflowUse__", "{not json"))
    on_console(_ConsoleMessage("__workflowUse__", json.dumps(["click"])))
    on_console(_ConsoleMessage("__workflowUse__", json.dumps("click")))
    on_console(_ConsoleMessage("__workflowUse__"))
    on_console(_ConsoleMessage("__workflowUse__", json.dumps({"type": "click"}), "extra"))
    on_console(_ConsoleMessage("__workflowUse__", json.dumps({"type": "click"}), type="log"))
    on_console(_ConsoleMessage("__workflowUseX__", json.dumps({"type": "click"})))
    on_console(_ConsoleMessage(json.dumps({"type": "click", "target": "Plain log"})))
    on_console(_ConsoleMessage("Uncaught TypeError: x is not a function", type="error"))
    # A page can forge browser-only events; they arrive empty, as they did through the binding.
    on_console(_ConsoleMessage("__workflowUse__", json.dumps({"type": "page_loaded", "url": "https://x.test"})))
    await asyncio.gather(*session._tasks)
    assert events == [{"type": "click", "target": "Sign in"}, {}]

    # Nothing demonstrated on Google's own sign-in page is a step.
    page.url = "https://accounts.google.com/signin"
    on_console(_ConsoleMessage("__workflowUse__", json.dumps({"type": "click", "target": "Next"})))
    await asyncio.gather(*session._tasks)
    assert len(events) == 2


@pytest.mark.asyncio
async def test_the_recording_context_exposes_no_playwright_binding() -> None:
    """A Playwright binding leaves ``__playwright__binding__`` globals on every page; Cloudflare blocks them."""
    from workflow_use_recording import provider

    async def record(_event: dict[str, Any]) -> None:
        pass

    calls: list[str] = []

    class Context:
        def __getattr__(self, name: str) -> Any:
            async def call(*_args: Any, **_kwargs: Any) -> None:
                calls.append(name)

            return call

    await provider._configure_context(Context(), record)
    assert calls == ["route", "add_init_script"]


@pytest.mark.asyncio
async def test_a_failure_before_the_navigate_stage_still_cleans_up(monkeypatch: pytest.MonkeyPatch) -> None:
    class Context(FakeContext):
        async def route(self, _pattern: str, _handler: Any) -> None:
            raise RuntimeError("configure failed")

    runtime = FakeRuntime(FakeBrowser(Context(FakePage())))
    calls = _browserbase_with(monkeypatch, runtime)

    with pytest.raises(RuntimeError):
        await BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event)

    assert runtime.stopped
    assert calls.releases == [1]
    assert calls.deleted == ["/v1/contexts/context-private"]


def _borrowing_browserbase(monkeypatch: pytest.MonkeyPatch, *, fail_session: bool = False) -> SimpleNamespace:
    calls = SimpleNamespace(contexts_created=0, sessions=[], deleted=[])

    class Client:
        def __init__(self) -> None:
            self.contexts = SimpleNamespace(create=self.create_context)
            self.sessions = SimpleNamespace(create=self.create_session, debug=self.debug, update=self.update)

        async def create_context(self, **_kwargs: Any) -> Any:
            calls.contexts_created += 1
            return SimpleNamespace(id="context-new")

        async def create_session(self, **kwargs: Any) -> Any:
            calls.sessions.append(kwargs)
            if fail_session:
                raise RuntimeError("provider failure")
            return SimpleNamespace(id="session-1", connect_url="wss://connect.example/session-1")

        async def debug(self, _session_id: str) -> Any:
            return SimpleNamespace(debugger_fullscreen_url="https://live.example/")

        async def update(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        async def delete(self, path: str, **_kwargs: Any) -> None:
            calls.deleted.append(path)

        async def __aexit__(self, *_args: Any) -> None:
            pass

    browserbase = ModuleType("browserbase")
    browserbase.AsyncBrowserbase = Client  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "browserbase", browserbase)
    return calls


@pytest.mark.asyncio
async def test_a_saved_sign_in_context_persists_demonstrated_login_without_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from workflow_use_recording.models import RecordingLogin

    page = FakePage()
    runtime = FakeRuntime(FakeBrowser(FakeContext(page)))
    calls = _borrowing_browserbase(monkeypatch)
    monkeypatch.setattr("workflow_use_recording.provider._start_playwright_runtime", lambda: _start(runtime))
    login = RecordingLogin(origins=["https://example.com"], password="saved-password")

    session = await BrowserbaseProvider(project_id="project-1").create(
        "https://example.com", _ignore_event, context_id="context-saved", login=login
    )

    assert calls.contexts_created == 0
    assert calls.sessions[0]["browser_settings"]["context"] == {"id": "context-saved", "persist": True}
    # The service sees no context of the session's own, so no stop, expiry or claim path can delete or lend it.
    assert session.context_id is None
    assert session.login is login
    await session.close()
    await session.delete_context()
    assert calls.deleted == []
    # Autofill plaintext does not outlive the browser.
    assert session.login is None


@pytest.mark.asyncio
async def test_failed_startup_never_deletes_a_saved_sign_in_context(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _borrowing_browserbase(monkeypatch, fail_session=True)

    with pytest.raises(RuntimeError, match="provider failure"):
        await BrowserbaseProvider(project_id="project-1").create(
            "https://example.com", _ignore_event, context_id="context-saved"
        )

    assert calls.contexts_created == 0
    assert calls.deleted == []


@pytest.mark.asyncio
async def test_local_provider_ignores_a_saved_context_without_logging_it(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    from workflow_use_recording.provider import LocalPlaywrightProvider

    pytest.importorskip("playwright.async_api")

    async def offline(_url: str) -> bool:
        return False

    # No network: the start page is blocked and fails to load, which keeps the session open.
    monkeypatch.setattr("workflow_use_recording.provider.resolves_to_public_host", offline)
    caplog.set_level("WARNING")
    session = await LocalPlaywrightProvider().create("https://example.com", _ignore_event, context_id="context-saved")
    await session.close()

    assert "recording_saved_context_ignored" in caplog.text
    assert "context-saved" not in caplog.text


class ResponsePage(FakePage):
    """A page whose start navigation answers with the given HTTP status (None: no main response)."""

    def __init__(self, status: int | None) -> None:
        super().__init__()
        self.status = status
        self.timeouts: list[int] = []

    async def goto(self, url: str, **kwargs: Any) -> Any:
        self.goto_urls.append(url)
        self.timeouts.append(kwargs["timeout"])
        return None if self.status is None else SimpleNamespace(status=self.status)


def _attempts(
    monkeypatch: pytest.MonkeyPatch, statuses: list[int | None], *, borrowed: bool = False
) -> tuple[list[FakeRuntime], SimpleNamespace]:
    """One fresh fake browser per startup attempt, answering the start page with ``statuses`` in order."""
    runtimes = [FakeRuntime(FakeBrowser(FakeContext(ResponsePage(status)))) for status in statuses]
    pending = list(runtimes)

    async def start() -> FakeRuntime:
        return pending.pop(0)

    calls = SimpleNamespace(sessions=[], releases=[], deleted=[], contexts=0)

    class Client:
        def __init__(self) -> None:
            self.contexts = SimpleNamespace(create=self.create_context)
            self.sessions = SimpleNamespace(create=self.create_session, debug=self.debug, update=self.update)

        async def create_context(self, **_kwargs: Any) -> Any:
            calls.contexts += 1
            return SimpleNamespace(id=f"context-{calls.contexts}")

        async def create_session(self, **kwargs: Any) -> Any:
            calls.sessions.append(kwargs)
            return SimpleNamespace(
                id=f"session-{len(calls.sessions)}", connect_url="wss://connect.example/?signingKey=must-not-leak"
            )

        async def debug(self, session_id: str) -> Any:
            return SimpleNamespace(debugger_fullscreen_url=f"https://live.example/{session_id}")

        async def update(self, session_id: str, **_kwargs: Any) -> None:
            calls.releases.append(session_id)

        async def delete(self, path: str, **_kwargs: Any) -> None:
            calls.deleted.append(path)

        async def __aexit__(self, *_args: Any) -> None:
            pass

    browserbase = ModuleType("browserbase")
    browserbase.AsyncBrowserbase = Client  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "browserbase", browserbase)
    monkeypatch.setattr("workflow_use_recording.provider._start_playwright_runtime", start)
    monkeypatch.delenv("BROWSERBASE_PROXY_COUNTRY", raising=False)
    return runtimes, calls


EE_PROXY = [{"type": "browserbase", "geolocation": {"country": "EE"}}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "blocked"),
    [(403, True), (429, True), (503, True), (200, False)],
    ids=["forbidden", "rate_limited", "unavailable", "loaded"],
)
async def test_navigate_keeps_main_document_block_status_when_interruption_lands(
    monkeypatch: pytest.MonkeyPatch, status: int, blocked: bool
) -> None:
    from playwright.async_api import Error as PlaywrightError

    runtimes, _ = _attempts(monkeypatch, [200])
    session = await BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event)
    page = runtimes[0]._browser.contexts[0]._page
    page.status = status
    goto = page.goto

    async def interrupted_goto(url: str, **kwargs: Any) -> None:
        response = await goto(url, **kwargs)
        session.note_main_response(page, response.status)
        page.url = url
        raise PlaywrightError(
            'Page.goto: Navigation is interrupted by another navigation to "chrome-error://chromewebdata/"'
        )

    page.goto = interrupted_goto
    await session.navigate("https://example.com/login")

    assert page.goto_urls == ["https://example.com", "https://example.com/login"]
    assert session.start_page_blocked is blocked
    await session.close()


@pytest.mark.asyncio
async def test_a_blocked_start_page_is_retried_once_over_a_geolocated_proxy(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    runtimes, calls = _attempts(monkeypatch, [403, 200])

    with caplog.at_level("WARNING", logger="workflow_use_recording.provider"):
        session = await BrowserbaseProvider(project_id="project-1").create("https://www.example.com/en", _ignore_event)

    # The blocked session and the context made for it are gone; the proxied one is the recording's.
    assert "proxies" not in calls.sessions[0]
    assert calls.sessions[1]["proxies"] == EE_PROXY
    assert calls.sessions[1]["browser_settings"]["solve_captchas"] is False
    assert calls.sessions[1]["browser_settings"]["context"] == {"id": "context-2", "persist": True}
    assert calls.releases == ["session-1"]
    assert calls.deleted == ["/v1/contexts/context-1"]
    assert runtimes[0]._browser.closed and runtimes[0].stopped
    assert not runtimes[1]._browser.closed and not runtimes[1].stopped
    assert session.live_view_url == "https://live.example/session-2"
    assert session.context_id == "context-2"
    assert (session.network, session.proxy_country) == ("proxy", "EE")
    assert session.start_page_blocked is False and session.start_page_failed is False
    for runtime, timeout in zip(runtimes, [20_000, 45_000], strict=True):
        page = runtime._browser.contexts[0]._page
        assert page.goto_urls == ["https://www.example.com/en"] and page.timeouts == [timeout]
    assert "recording_start_page_blocked status=403 network=direct" in caplog.text
    assert "recording_browser_start_failed" not in caplog.text
    assert "example.com" not in caplog.text and "must-not-leak" not in caplog.text


@pytest.mark.asyncio
async def test_a_start_page_blocked_over_the_proxy_too_stays_open_and_is_marked_blocked(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    runtimes, calls = _attempts(monkeypatch, [429, 503])

    with caplog.at_level("WARNING", logger="workflow_use_recording.provider"):
        session = await BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event)

    assert len(calls.sessions) == 2 and calls.sessions[1]["proxies"] == EE_PROXY
    assert calls.releases == ["session-1"] and calls.deleted == ["/v1/contexts/context-1"]
    assert not runtimes[1]._browser.closed and not runtimes[1].stopped
    assert (session.network, session.proxy_country, session.start_page_blocked) == ("proxy", "EE", True)
    assert session.start_page_failed is False
    assert "recording_start_page_blocked status=429 network=direct" in caplog.text
    assert "recording_start_page_blocked status=503 network=proxy" in caplog.text

    # The next page the person opens clears the block, unless that page is blocked too.
    page = runtimes[1]._browser.contexts[0]._page
    goto = page.goto

    async def responding_goto(url: str, **kwargs: Any) -> Any:
        response = await goto(url, **kwargs)
        session.note_main_response(page, response.status)
        return response

    page.goto = responding_goto
    await session.navigate("https://example.com/login")
    assert session.start_page_blocked is True
    page.status = 200
    await session.navigate("https://example.com/login")
    assert session.start_page_blocked is False


@pytest.mark.asyncio
async def test_a_start_page_that_loads_directly_uses_one_direct_session(monkeypatch: pytest.MonkeyPatch) -> None:
    runtimes, calls = _attempts(monkeypatch, [200, 200])

    session = await BrowserbaseProvider(project_id="project-1").create("https://example.com", _ignore_event)

    assert len(calls.sessions) == 1 and "proxies" not in calls.sessions[0]
    assert calls.releases == [] and calls.deleted == []
    assert (session.network, session.proxy_country, session.start_page_blocked) == ("direct", None, False)
    assert not runtimes[0]._browser.closed
    assert runtimes[0]._browser.contexts[0]._page.timeouts == [20_000]


@pytest.mark.asyncio
async def test_a_blocked_start_page_with_a_borrowed_sign_in_is_not_retried(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    runtimes, calls = _attempts(monkeypatch, [403, 200])

    with caplog.at_level("WARNING", logger="workflow_use_recording.provider"):
        session = await BrowserbaseProvider(project_id="project-1").create(
            "https://example.com", _ignore_event, context_id="context-saved"
        )

    assert len(calls.sessions) == 1 and "proxies" not in calls.sessions[0]
    assert calls.contexts == 0 and calls.releases == [] and calls.deleted == []
    assert not runtimes[0]._browser.closed
    assert (session.network, session.proxy_country, session.start_page_blocked) == ("direct", None, True)
    assert runtimes[0]._browser.contexts[0]._page.timeouts == [45_000]
    assert "recording_start_page_blocked status=403 network=direct" in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("requested", "env", "expected"),
    [("de", "LV", "DE"), (None, "lv", "LV"), (None, None, "EE")],
)
async def test_the_proxy_country_comes_from_the_request_then_the_environment_then_estonia(
    monkeypatch: pytest.MonkeyPatch, requested: str | None, env: str | None, expected: str
) -> None:
    _, calls = _attempts(monkeypatch, [403, 200])
    if env is not None:
        monkeypatch.setenv("BROWSERBASE_PROXY_COUNTRY", env)

    session = await BrowserbaseProvider(project_id="project-1").create(
        "https://example.com", _ignore_event, country=requested
    )

    assert calls.sessions[1]["proxies"] == [{"type": "browserbase", "geolocation": {"country": expected}}]
    assert session.proxy_country == expected


@pytest.mark.parametrize("value", ["EST", "E1", "E", "e-"])
def test_an_invalid_proxy_country_in_the_environment_is_rejected_at_startup(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv("BROWSERBASE_PROXY_COUNTRY", value)
    with pytest.raises(ValueError):
        BrowserbaseProvider(project_id="project-1")


def test_an_empty_proxy_country_in_the_environment_means_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BROWSERBASE_PROXY_COUNTRY", "")
    assert BrowserbaseProvider(project_id="project-1").proxy_country == "EE"


@pytest.mark.asyncio
async def test_a_blocked_page_load_does_not_clear_the_block_but_a_later_page_does(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from workflow_use_recording import provider

    async def no_capture(*_args: Any) -> None:
        pass

    monkeypatch.setattr(provider, "install_sign_in_capture", no_capture)

    class Page(FakePage):
        def __init__(self) -> None:
            super().__init__()
            self.handlers: dict[str, Any] = {}
            self.context = object()
            self.main_frame = SimpleNamespace(url="https://example.com/")
            self.url = "https://example.com/"

        def on(self, event: str, callback: Any) -> None:
            self.handlers[event] = callback

        def respond(self, status: int, *, main: bool = True) -> None:
            request = SimpleNamespace(is_navigation_request=lambda: main)
            frame = self.main_frame if main else SimpleNamespace(url="https://cdn.example/frame")
            self.handlers["response"](
                SimpleNamespace(status=status, request=request, frame=frame, url="https://example.com/")
            )

    page = Page()
    context = FakeContext(page)
    context.pages = [page]
    _browserbase_with(monkeypatch, FakeRuntime(FakeBrowser(context)))
    events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    session = await BrowserbaseProvider(project_id="project-1").create("https://example.com/", events.put)

    # The block page itself loads fine as far as the browser is concerned; a 403 document is not a loaded page.
    page.respond(403)
    page.handlers["domcontentloaded"]()
    assert await asyncio.wait_for(events.get(), 1) == {"type": "page_blocked", "status": 403}
    assert session.start_page_blocked is True

    # A subresource or frame answering 200 does not stand in for the main document.
    page.respond(200, main=False)
    page.handlers["domcontentloaded"]()
    assert session.start_page_blocked is True

    page.respond(200)
    page.handlers["domcontentloaded"]()
    assert await asyncio.wait_for(events.get(), 1) == {"type": "page_loaded", "url": "https://example.com/"}
    assert session.start_page_blocked is False

    # Akamai lets the first document through, then its challenge script re-requests the page and gets 403.
    page.respond(403)
    assert await asyncio.wait_for(events.get(), 1) == {"type": "page_blocked", "status": 403}
    assert session.start_page_blocked is True
    await session.close()
