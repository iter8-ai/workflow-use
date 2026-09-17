import sys
from types import ModuleType, SimpleNamespace

import pytest

from workflow_use_recording.provider import BrowserbaseProvider


class Page:
    def __init__(self):
        self.url = "about:blank"
        self.main_frame = self
        self.evaluated = []
        self.callbacks = {}

    def on(self, event, callback):
        self.callbacks.setdefault(event, []).append(callback)

    async def goto(self, url, **kwargs):
        self.url = url

    async def evaluate(self, script):
        self.evaluated.append(script)


class Context:
    def __init__(self):
        self.pages = [Page()]
        self.bindings, self.scripts, self.cookie_values = [], [], []

    async def route(self, pattern, handler):
        self.handler = handler

    async def expose_binding(self, name, callback):
        self.bindings.append(name)

    async def add_init_script(self, script):
        self.scripts.append(script)

    async def cookies(self):
        return self.cookie_values

    async def add_cookies(self, cookies):
        self.cookie_values = cookies

    def on(self, event, callback):
        pass


@pytest.fixture
def browserbase(monkeypatch):
    contexts, settings, releases = [], [], []

    async def create(**kwargs):
        settings.append(kwargs)
        return SimpleNamespace(id=str(len(settings)), connect_url="wss://private.example")

    async def debug(session_id):
        return SimpleNamespace(debugger_fullscreen_url=f"https://view.example/{session_id}")

    async def release(session_id, **kwargs):
        releases.append(session_id)

    class Client:
        sessions = SimpleNamespace(create=create, debug=debug, update=release)

        async def __aexit__(self, *args):
            pass

    async def ignore(*args, **kwargs):
        pass

    async def connect(url):
        context = Context()
        contexts.append(context)
        return SimpleNamespace(contexts=[context], close=ignore)

    async def start():
        return SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect), stop=ignore)

    module = ModuleType("browserbase")
    module.AsyncBrowserbase = Client
    monkeypatch.setitem(sys.modules, "browserbase", module)
    playwright = ModuleType("playwright.async_api")
    playwright.async_playwright = lambda: SimpleNamespace(start=start)
    monkeypatch.setitem(sys.modules, "playwright.async_api", playwright)
    return contexts, settings, releases


@pytest.mark.asyncio
async def test_provider_transfers_only_origin_cookies_to_fresh_uncaptured_session(browserbase):
    contexts, settings, releases = browserbase
    provider = BrowserbaseProvider(project_id="test")
    login = await provider.create_private("https://app.example.com/login")
    contexts[0].cookie_values = [
        {"name": "auth", "value": "synthetic", "domain": ".example.com", "path": "/", "httpOnly": True, "secure": True},
        {"name": "other", "value": "never-copy", "domain": "other.example.org", "path": "/"},
        {"name": "partition", "value": "never-copy", "domain": "app.example.com", "path": "/", "partitionKey": "x"},
    ]
    fresh = await provider.prepare(login, "https://app.example.com/reports")
    assert len(contexts) == 2 and releases == []
    assert contexts[1].cookie_values == [
        {
            "name": "auth",
            "value": "synthetic",
            "domain": "app.example.com",
            "path": "/",
            "httpOnly": True,
            "secure": True,
        }
    ]
    assert all(not context.bindings and not context.scripts for context in contexts)
    assert all(
        not setting["browser_settings"]["record_session"] and not setting["browser_settings"]["log_session"]
        for setting in settings
    )

    async def sink(event):
        pass

    await fresh.activate(sink)
    await fresh.activate(sink)
    assert contexts[0].bindings == []
    assert contexts[1].bindings == ["workflowUseRecord"]
    assert len(contexts[1].pages[0].evaluated) == 1
    await login.close()
    await fresh.close()
    assert releases == ["1", "2"]


@pytest.mark.asyncio
async def test_provider_rejects_cross_origin_prepare_and_activation(browserbase):
    contexts, settings, releases = browserbase
    provider = BrowserbaseProvider(project_id="test")
    login = await provider.create_private("https://app.example.com/login")
    with pytest.raises(ValueError):
        await provider.prepare(login, "https://elsewhere.example.com/")
    assert len(settings) == 1
    contexts[0].pages[0].url = "https://elsewhere.example.com/"
    with pytest.raises(ValueError):
        await login.activate(None)
    assert contexts[0].bindings == []
    await login.close()


@pytest.mark.asyncio
async def test_navigation_guard_applies_before_and_after_activation(browserbase, monkeypatch):
    contexts, _, _ = browserbase
    provider = BrowserbaseProvider(project_id="test")
    login = await provider.create_private("https://app.example.com/login")

    async def public(url):
        return not url.startswith("http://127.0.0.1")

    monkeypatch.setattr("workflow_use_recording.provider.resolves_to_public_host", public)

    async def request(url, navigation):
        outcome = []

        async def abort():
            outcome.append("abort")

        async def continue_():
            outcome.append("continue")

        await contexts[0].handler(
            SimpleNamespace(
                request=SimpleNamespace(url=url, is_navigation_request=lambda: navigation),
                abort=abort,
                continue_=continue_,
            )
        )
        return outcome

    for active in [False, True]:
        if active:
            await login.activate(None)
        assert await request("https://app.example.com/reports", True) == ["continue"]
        assert await request("https://cdn.example.net/style.css", False) == ["continue"]
        assert await request("https://elsewhere.example.com/login", True) == ["abort"]
        assert await request("http://127.0.0.1/private", False) == ["abort"]
    await login.close()
