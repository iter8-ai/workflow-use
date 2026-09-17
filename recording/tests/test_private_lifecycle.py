import asyncio

import httpx
import pytest
from playwright.async_api import async_playwright

from workflow_use_recording.api import RecordingConfig, create_app
from workflow_use_recording.service import InvalidRecordingUrl, RecordingConflict, RecordingOwner, RecordingService


class Session:
    """Boundary fake with a real browser page as its disposable resource."""

    def __init__(self, page, *, activation_error=False, close_error=False, close_gate=None):
        self.page = page
        self.live_view_url = page.url
        self.activation_error = activation_error
        self.close_error = close_error
        self.close_gate = close_gate

    async def close(self):
        if self.close_gate:
            started, proceed = self.close_gate
            started.set()
            await proceed.wait()
        if self.close_error:
            self.close_error = False
            raise RuntimeError("transient close failure")
        await self.page.context.close()

    async def activate(self, sink):
        if self.activation_error:
            raise RuntimeError("activation failed")


class Provider:
    def __init__(self, login, fresh, *, prepare_error=False, prepare_gate=None):
        self.login = login
        self.fresh = fresh
        self.prepare_error = prepare_error
        self.prepare_gate = prepare_gate

    async def create_private(self, url):
        return self.login

    async def prepare(self, login, url):
        if self.prepare_gate:
            started, proceed = self.prepare_gate
            started.set()
            await proceed.wait()
        if self.prepare_error:
            raise RuntimeError("prepare failed")
        return self.fresh


@pytest.fixture
async def make_provider():
    async with async_playwright() as runtime:
        browser = await runtime.chromium.launch()

        async def make(
            *, activation_error=False, close_error=False, close_gate=None, prepare_error=False, prepare_gate=None
        ):
            pages = []
            for name in ["login", "fresh"]:
                context = await browser.new_context()
                await context.route("**/*", lambda route: route.fulfill(body="<h1>Private browser</h1>"))
                page = await context.new_page()
                await page.goto(f"https://view.example/{name}")
                pages.append(page)
            login, fresh = pages
            provider = Provider(
                Session(login, close_gate=close_gate),
                Session(fresh, activation_error=activation_error, close_error=close_error),
                prepare_error=prepare_error,
                prepare_gate=prepare_gate,
            )
            return provider, login, fresh

        yield make
        await browser.close()


OWNER = RecordingOwner("tenant", "person@example.com")
OTHER = RecordingOwner("other", OWNER.email)
URL = "https://example.com/login"
READY = "https://example.com/reports"


@pytest.mark.asyncio
async def test_manual_login_is_separate_until_fresh_session_activation(make_provider):
    provider, login, fresh = await make_provider()
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True, idempotency_key="one")
    repeated = await service.create(OWNER, URL, private_login=True, idempotency_key="one")
    assert repeated.id == r.id
    assert service.response(r).live_view_url is None
    assert await service.private_view(r.id, OWNER) == login.url
    await service.record_event(r.id, {"type": "input", "target": "password", "secret": True})
    assert service.response(r).steps == [] and service.response(r).blocked_reason is None
    await service.prepare(r.id, OWNER, READY)
    prepared = service.response(await service.prepare(r.id, OWNER, READY))
    assert prepared.status == "verifying_login" and prepared.live_view_url is None
    assert await login.get_by_role("heading", name="Private browser").is_visible()
    assert await service.private_view(r.id, OWNER) == fresh.url
    await service.record_event(r.id, {"type": "click", "target": "Private account"})
    assert service.response(await service.get(r.id, OWNER)).steps == []
    await service.activate(r.id, OWNER)
    activated = service.response(await service.activate(r.id, OWNER))
    assert login.is_closed()
    assert activated.status == "recording" and len(activated.steps) == 1
    assert activated.steps[0].url == READY
    with pytest.raises(RecordingConflict):
        await service.private_view(r.id, OWNER)
    await service.record_event(r.id, {"type": "navigation", "url": "https://other.example/"})
    assert len(service.response(await service.get(r.id, OWNER)).steps) == 1
    await service.delete(r.id, OWNER)
    assert fresh.is_closed()
    assert await service.get(r.id, OWNER) is None


@pytest.mark.asyncio
async def test_owner_origin_expiry_capacity_and_cancel(make_provider):
    provider, login, _ = await make_provider()
    service = RecordingService(provider, max_sessions=1, timeout_seconds=1)
    r = await service.create(OWNER, URL, private_login=True)
    with pytest.raises(RuntimeError):
        await service.create(OWNER, URL, private_login=True)
    for action in [
        service.private_view(r.id, OTHER),
        service.prepare(r.id, OTHER, READY),
        service.activate(r.id, OTHER),
    ]:
        with pytest.raises(KeyError):
            await action
    for url in [
        "https://other.example/reports",
        "https://example.com/reports?token=a",
        "https://example.com:444/reports",
    ]:
        with pytest.raises(InvalidRecordingUrl):
            await service.prepare(r.id, OWNER, url)
    await asyncio.sleep(1.05)
    assert service.response(await service.get(r.id, OWNER)).status == "expired"
    assert login.is_closed()
    with pytest.raises(RecordingConflict):
        await service.activate(r.id, OWNER)


@pytest.mark.asyncio
async def test_delete_during_preparation_closes_late_fresh_browser(make_provider):
    preparing, continue_prepare = asyncio.Event(), asyncio.Event()
    provider, login, fresh = await make_provider(prepare_gate=(preparing, continue_prepare))
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True)
    task = asyncio.create_task(service.prepare(r.id, OWNER, READY))
    await asyncio.wait_for(preparing.wait(), 2)
    assert service.response(await asyncio.wait_for(service.get(r.id, OWNER), 0.1)).status == "awaiting_login"
    await service.delete(r.id, OWNER)
    continue_prepare.set()
    with pytest.raises(RecordingConflict):
        await task
    assert login.is_closed() and fresh.is_closed()
    assert await service.get(r.id, OWNER) is None


@pytest.mark.asyncio
async def test_api_private_capability_is_owner_bound_and_never_public(make_provider):
    provider, _, _ = await make_provider()
    app = create_app(provider, RecordingConfig(service_key="key"))
    headers = {
        "X-Workflow-Key": "key",
        "x-organization": OWNER.organization,
        "x-user-email": OWNER.email,
        "Idempotency-Key": "one",
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test", headers=headers
    ) as client:
        created = await client.post("/recordings", json={"url": URL, "privateLogin": True})
        assert created.status_code == 201
        body = created.json()
        path = "/recordings/" + body["id"]
        assert body["status"] == "awaiting_login" and body["liveViewUrl"] is None and body["steps"] == []
        assert (await client.post("/recordings", json={"url": URL, "privateLogin": True})).json()["id"] == body["id"]
        assert (await client.get(path + "/private-view", headers={"x-organization": "wrong"})).status_code == 404
        private = await client.get(path + "/private-view")
        assert set(private.json()) == {"liveViewUrl"}
        assert private.headers["cache-control"] == "no-store"
        assert (await client.post(path + "/prepare", json={"url": READY, "cookies": []})).status_code == 422
        assert (await client.post(path + "/prepare", json={"url": READY})).json()["status"] == "verifying_login"
        assert (await client.get(path)).json()["liveViewUrl"] is None
        assert (await client.post(path + "/activate")).json()["status"] == "recording"
        assert (await client.get(path + "/private-view")).status_code == 409
        assert (await client.delete(path)).status_code == 204


@pytest.mark.asyncio
async def test_expiry_closes_both_verification_sessions(make_provider):
    provider, login, fresh = await make_provider()
    service = RecordingService(provider, timeout_seconds=1)
    r = await service.create(OWNER, URL, private_login=True)
    await service.prepare(r.id, OWNER, READY)
    await asyncio.sleep(1.05)
    await service.cleanup()
    assert service.response(await service.get(r.id, OWNER)).status == "expired"
    assert login.is_closed() and fresh.is_closed()
    with pytest.raises(RecordingConflict):
        await service.private_view(r.id, OWNER)


@pytest.mark.asyncio
async def test_failed_activation_closes_both_sessions(make_provider):
    provider, login, fresh = await make_provider(activation_error=True)
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True)
    await service.prepare(r.id, OWNER, READY)
    with pytest.raises(RuntimeError, match="activation failed"):
        await service.activate(r.id, OWNER)
    result = service.response(await service.get(r.id, OWNER))
    assert result.status == "stopped" and result.steps == []
    assert login.is_closed() and fresh.is_closed()


@pytest.mark.asyncio
async def test_close_failure_still_closes_login_then_cleanup_retries_fresh(make_provider):
    provider, login, fresh = await make_provider(close_error=True)
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True)
    await service.prepare(r.id, OWNER, READY)
    with pytest.raises(RuntimeError, match="transient close failure"):
        await service.stop(r.id, OWNER)
    assert login.is_closed()
    assert await fresh.get_by_role("heading", name="Private browser").is_visible()
    assert service.response(r).live_view_url is None
    await service.cleanup()
    assert fresh.is_closed()
    assert service.response(await service.get(r.id, OWNER)).status == "stopped"


@pytest.mark.asyncio
async def test_failed_preparation_closes_login(make_provider):
    provider, login, _ = await make_provider(prepare_error=True)
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True)
    with pytest.raises(RuntimeError, match="prepare failed"):
        await service.prepare(r.id, OWNER, READY)
    assert login.is_closed()
    assert service.response(await service.get(r.id, OWNER)).status == "stopped"


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_fresh_close", [False, True])
async def test_prepare_returning_while_delete_closes_login_is_cleaned_up(make_provider, fail_fresh_close):
    closing, finish_close = asyncio.Event(), asyncio.Event()
    preparing, continue_prepare = asyncio.Event(), asyncio.Event()
    provider, login, fresh = await make_provider(
        close_error=fail_fresh_close,
        close_gate=(closing, finish_close),
        prepare_gate=(preparing, continue_prepare),
    )
    service = RecordingService(provider)
    recording = await service.create(OWNER, URL, private_login=True)
    preparing_task = asyncio.create_task(service.prepare(recording.id, OWNER, READY))
    await asyncio.wait_for(preparing.wait(), 2)
    deleting = asyncio.create_task(service.delete(recording.id, OWNER))
    try:
        await asyncio.wait_for(closing.wait(), 2)
        continue_prepare.set()
        with pytest.raises(RuntimeError):
            await asyncio.wait_for(preparing_task, 2)
        assert fresh.is_closed() is (not fail_fresh_close)
    finally:
        finish_close.set()
        await deleting
        await service.cleanup()
    assert login.is_closed() and fresh.is_closed()
    assert await service.get(recording.id, OWNER) is None
