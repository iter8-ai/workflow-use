"""Private provider behavior against real Chromium and a controlled HTTP origin."""

import asyncio
import socket
import sys
from types import ModuleType, SimpleNamespace
from uuid import uuid4

import pytest
from playwright.async_api import Error, async_playwright

from workflow_use_recording.provider import BrowserbaseProvider


@pytest.fixture
async def provider(monkeypatch):
    async def serve(reader, writer):
        try:
            request = await reader.readuntil(b"\r\n\r\n")
            url = request.split(b" ")[1].decode()
            body = (
                "<button>Download report</button>"
                if url.endswith("/frame")
                else '<button>Open report</button><iframe src="/frame"></iframe>'
            ).encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n"
                b"Access-Control-Allow-Origin: *\r\n" + f"Content-Length: {len(body)}\r\n\r\n".encode() + body
            )
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    proxy = f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    runtime = await async_playwright().start()
    browsers = []

    async def connect(url):
        browser = await runtime.chromium.launch(proxy={"server": proxy})
        browsers.append(browser)
        await browser.new_context()
        return browser

    async def ignore(*args, **kwargs):
        pass

    async def start():
        return SimpleNamespace(chromium=SimpleNamespace(connect_over_cdp=connect), stop=ignore)

    async def create(**kwargs):
        return SimpleNamespace(id=str(uuid4()), connect_url="wss://controlled-browser.example")

    async def debug(session_id):
        return SimpleNamespace(debugger_fullscreen_url=f"https://view.example/{session_id}")

    class Client:
        sessions = SimpleNamespace(create=create, debug=debug, update=ignore)
        __aexit__ = ignore

    module = ModuleType("browserbase")
    module.AsyncBrowserbase = Client
    monkeypatch.setitem(sys.modules, "browserbase", module)
    monkeypatch.setattr("playwright.async_api.async_playwright", lambda: SimpleNamespace(start=start))
    original_resolve = socket.getaddrinfo

    def resolve(host, *args, **kwargs):
        if host.endswith(".example.com"):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.215.14", 80))]
        return original_resolve(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    try:
        yield BrowserbaseProvider(project_id="test"), browsers
    finally:
        for browser in browsers:
            await browser.close()
        await runtime.stop()
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_prepare_preserves_only_origin_cookies_in_a_fresh_browser(provider):
    provider, browsers = provider
    login = await provider.create_private("http://app.example.com/login")
    page = browsers[0].contexts[0].pages[0]
    await page.evaluate("localStorage.setItem('login-draft', 'private'); sessionStorage.setItem('otp', 'private')")
    await page.context.add_cookies(
        [
            {"name": "auth", "value": "synthetic", "domain": ".example.com", "path": "/", "httpOnly": True},
            {"name": "other", "value": "never-copy", "domain": "other.example.org", "path": "/"},
            {
                "name": "partition",
                "value": "never-copy",
                "domain": "app.example.com",
                "path": "/",
                "secure": True,
                "partitionKey": "https://example.com",
            },
        ]
    )
    fresh = await provider.prepare(login, "http://app.example.com/reports")
    fresh_page = browsers[1].contexts[0].pages[0]
    assert fresh_page.url == "http://app.example.com/reports"
    assert await fresh_page.evaluate("({...localStorage, ...sessionStorage})") == {}
    cookies = await fresh_page.context.cookies()
    assert [(cookie["name"], cookie["value"], cookie["domain"], cookie["httpOnly"]) for cookie in cookies] == [
        ("auth", "synthetic", "app.example.com", True)
    ]
    assert await fresh_page.context.cookies("http://sibling.example.com/") == []
    await login.close()
    assert page.is_closed()
    assert await fresh_page.get_by_role("button", name="Open report").is_visible()
    await fresh.close()
    assert fresh_page.is_closed()


@pytest.mark.asyncio
async def test_private_clicks_are_not_replayed_and_activation_captures_existing_iframes(provider):
    provider, browsers = provider
    login = await provider.create_private("http://app.example.com/login")
    login_page = browsers[0].contexts[0].pages[0]
    await login_page.get_by_role("button", name="Open report").click()
    fresh = await provider.prepare(login, "http://app.example.com/reports")
    page = browsers[1].contexts[0].pages[0]
    await page.frame_locator("iframe").get_by_role("button").click()
    events = []
    captured = asyncio.Event()

    async def sink(event):
        events.append(event)
        if event.get("target") == "Download report":
            captured.set()

    await fresh.activate(sink)
    await fresh.activate(sink)
    await login_page.get_by_role("button", name="Open report").click()
    await page.get_by_role("button", name="Open report").click()
    await page.frame_locator("iframe").get_by_role("button", name="Download report").click()
    await asyncio.wait_for(captured.wait(), 2)
    assert [event["target"] for event in events if event["type"] == "click"] == ["Open report", "Download report"]
    await login.close()
    await fresh.close()


@pytest.mark.asyncio
async def test_provider_rejects_cross_origin_preparation(provider):
    provider, browsers = provider
    login = await provider.create_private("http://app.example.com/login")
    with pytest.raises(ValueError):
        await provider.prepare(login, "http://elsewhere.example.com/")
    assert await browsers[0].contexts[0].pages[0].get_by_role("button", name="Open report").is_visible()
    await browsers[0].contexts[0].new_page()

    async def sink(event):
        pass

    with pytest.raises(ValueError, match="approved origin"):
        await login.activate(sink)
    await login.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("active", [False, True])
async def test_navigation_and_private_network_requests_are_blocked(provider, active):
    provider, browsers = provider
    login = await provider.create_private("http://app.example.com/login")
    page = browsers[0].contexts[0].pages[0]

    async def sink(event):
        pass

    if active:
        await login.activate(sink)
    await page.goto("http://app.example.com/reports")
    assert await page.get_by_role("button", name="Open report").is_visible()
    assert await page.evaluate("fetch('http://cdn.example.com/style.css').then(r => r.ok)") is True
    assert await page.evaluate("fetch('http://127.0.0.1/private').then(() => 'allowed', () => 'blocked')") == "blocked"
    with pytest.raises(Error, match="ERR_FAILED|ERR_ABORTED"):
        await page.goto("http://elsewhere.example.com/login")
    await login.close()
