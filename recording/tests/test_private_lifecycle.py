import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from workflow_use_recording.api import RecordingConfig, create_app
from workflow_use_recording.service import InvalidRecordingUrl, RecordingConflict, RecordingOwner, RecordingService


class Session:
    def __init__(self, name):
        self.live_view_url = f"https://view.example/{name}"
        self.closed = False
        self.capture = False

    async def close(self):
        self.closed = True

    async def activate(self, sink):
        self.capture = True
        self.sink = sink


class Provider:
    def __init__(self):
        self.sessions = []
        self.preparing = None
        self.continue_prepare = None

    async def create_private(self, url):
        session = Session(str(len(self.sessions)))
        self.sessions.append(session)
        return session

    async def prepare(self, login, url):
        if self.preparing:
            self.preparing.set()
            await self.continue_prepare.wait()
        return await self.create_private(url)


OWNER = RecordingOwner("tenant", "person@example.com")
OTHER = RecordingOwner("other", OWNER.email)
URL = "https://example.com/login"
READY = "https://example.com/reports"


@pytest.mark.asyncio
async def test_manual_login_is_separate_until_fresh_session_activation():
    provider = Provider()
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True, idempotency_key="one")
    assert r is await service.create(OWNER, URL, private_login=True, idempotency_key="one")
    assert len(provider.sessions) == 1
    assert service.response(r).live_view_url is None
    assert await service.private_view(r.id, OWNER) == provider.sessions[0].live_view_url
    await service.record_event(r.id, {"type": "input", "target": "password", "secret": True})
    assert r.steps == [] and r.blocked_reason is None
    assert not provider.sessions[0].capture
    await service.prepare(r.id, OWNER, READY)
    await service.prepare(r.id, OWNER, READY)
    assert len(provider.sessions) == 2
    assert not provider.sessions[0].closed
    assert not provider.sessions[1].capture
    assert r.status == "verifying_login"
    assert service.response(r).live_view_url is None
    assert await service.private_view(r.id, OWNER) == provider.sessions[1].live_view_url
    await service.activate(r.id, OWNER)
    await service.activate(r.id, OWNER)
    assert provider.sessions[0].closed and provider.sessions[1].capture
    assert r.status == "recording" and len(r.steps) == 1
    assert r.steps[0].url == READY
    with pytest.raises(RecordingConflict):
        await service.private_view(r.id, OWNER)
    await service.record_event(r.id, {"type": "navigation", "url": "https://other.example/"})
    assert len(r.steps) == 1
    await service.delete(r.id, OWNER)
    assert all(s.closed for s in provider.sessions)


@pytest.mark.asyncio
async def test_owner_origin_expiry_capacity_and_cancel():
    provider = Provider()
    service = RecordingService(provider, max_sessions=1)
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
    r.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    assert (await service.get(r.id, OWNER)).status == "expired"
    assert provider.sessions[0].closed
    with pytest.raises(RecordingConflict):
        await service.activate(r.id, OWNER)


@pytest.mark.asyncio
async def test_delete_during_preparation_closes_late_fresh_browser():
    provider = Provider()
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True)
    provider.preparing, provider.continue_prepare = asyncio.Event(), asyncio.Event()
    task = asyncio.create_task(service.prepare(r.id, OWNER, READY))
    await provider.preparing.wait()
    assert (await asyncio.wait_for(service.get(r.id, OWNER), 0.1)).status == "awaiting_login"
    await service.delete(r.id, OWNER)
    provider.continue_prepare.set()
    with pytest.raises(RecordingConflict):
        await task
    assert all(s.closed for s in provider.sessions)


@pytest.mark.asyncio
async def test_api_private_capability_is_owner_bound_and_never_public():
    provider = Provider()
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
async def test_expiry_closes_both_verification_sessions():
    provider = Provider()
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True)
    await service.prepare(r.id, OWNER, READY)
    r.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    await service.cleanup()
    assert r.status == "expired"
    assert all(s.closed for s in provider.sessions)
    with pytest.raises(RecordingConflict):
        await service.private_view(r.id, OWNER)


@pytest.mark.asyncio
async def test_failed_activation_closes_both_sessions():
    provider = Provider()
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True)
    await service.prepare(r.id, OWNER, READY)

    async def fail(sink):
        raise RuntimeError("activation failed")

    provider.sessions[1].activate = fail
    with pytest.raises(RuntimeError):
        await service.activate(r.id, OWNER)
    assert r.status == "stopped"
    assert all(s.closed for s in provider.sessions)
    assert r.steps == []


@pytest.mark.asyncio
async def test_close_failure_still_attempts_both_handles_then_retries():
    provider = Provider()
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True)
    await service.prepare(r.id, OWNER, READY)
    original = provider.sessions[1].close

    async def fail_once():
        provider.sessions[1].close = original
        raise RuntimeError("close failed")

    provider.sessions[1].close = fail_once
    with pytest.raises(RuntimeError):
        await service.stop(r.id, OWNER)
    assert provider.sessions[0].closed
    assert service.response(r).live_view_url is None
    await service.cleanup()
    assert all(s.closed for s in provider.sessions)
    assert r.status == "stopped"


@pytest.mark.asyncio
async def test_failed_preparation_closes_login():
    provider = Provider()
    service = RecordingService(provider)
    r = await service.create(OWNER, URL, private_login=True)

    async def fail(login, url):
        raise RuntimeError("prepare failed")

    provider.prepare = fail
    with pytest.raises(RuntimeError):
        await service.prepare(r.id, OWNER, READY)
    assert provider.sessions[0].closed
    assert r.status == "stopped"


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_fresh_close", [False, True])
async def test_prepare_returning_while_delete_closes_login_is_cleaned_up(fail_fresh_close):
    provider = Provider()
    service = RecordingService(provider)
    recording = await service.create(OWNER, URL, private_login=True)
    login = provider.sessions[0]
    closing, finish_close = asyncio.Event(), asyncio.Event()
    provider.preparing, provider.continue_prepare = asyncio.Event(), asyncio.Event()

    async def close_login():
        closing.set()
        await finish_close.wait()
        login.closed = True

    login.close = close_login
    original_create = provider.create_private

    async def create_fresh(url):
        fresh = await original_create(url)
        original_close = fresh.close

        async def fail_once():
            fresh.close = original_close
            raise RuntimeError("transient close failure")

        if fail_fresh_close:
            fresh.close = fail_once
        return fresh

    provider.create_private = create_fresh
    preparing = asyncio.create_task(service.prepare(recording.id, OWNER, READY))
    await asyncio.wait_for(provider.preparing.wait(), 1)
    deleting = asyncio.create_task(service.delete(recording.id, OWNER))
    try:
        await asyncio.wait_for(closing.wait(), 1)
        provider.continue_prepare.set()
        with pytest.raises(RuntimeError):
            await asyncio.wait_for(preparing, 1)
        assert len(provider.sessions) == 2
        assert provider.sessions[1].closed is (not fail_fresh_close)
    finally:
        finish_close.set()
        await deleting
        await service.cleanup()
    assert all(session.closed for session in provider.sessions)
    assert await service.get(recording.id, OWNER) is None
