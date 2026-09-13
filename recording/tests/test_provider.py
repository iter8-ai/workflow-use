from __future__ import annotations

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
            clients.append(self)

        async def __aexit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
            pass

    browserbase = ModuleType("browserbase")
    browserbase.AsyncBrowserbase = FakeAsyncBrowserbase  # type: ignore[attr-defined]
    playwright_async_api = ModuleType("playwright.async_api")
    playwright_async_api.async_playwright = lambda: SimpleNamespace(start=lambda: _start(runtime))  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "browserbase", browserbase)
    monkeypatch.setitem(sys.modules, "playwright.async_api", playwright_async_api)

    provider = BrowserbaseProvider(project_id="project-1")
    session = await provider.create("https://example.com/reports?month=2026-09", _ignore_event)

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
            },
        }
    ]
    assert page.goto_urls == ["https://example.com/reports?month=2026-09"]

    await session.close()


async def _ignore_event(_event: dict[str, Any]) -> None:
    pass


async def _start(runtime: FakeRuntime) -> FakeRuntime:
    return runtime
