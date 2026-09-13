from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

import workflow_use_recording.service as recording_service
from workflow_use_recording.api import RecordingConfig, create_app
from workflow_use_recording.provider import BrowserProvider, BrowserSession
from workflow_use_recording.service import CAPTURE_LIMIT_REASON


class FakeSession:
    def __init__(self, emit: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        self.emit = emit
        self.closed = False
        self.live_view_url = "https://browserbase.example/debug?token=secret"

    async def close(self) -> None:
        self.closed = True


class FakeProvider(BrowserProvider):
    def __init__(self) -> None:
        self.sessions: list[FakeSession] = []

    async def create(
        self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> BrowserSession:
        session = FakeSession(on_event)
        self.sessions.append(session)
        return session


class FailingSession(FakeSession):
    async def close(self) -> None:
        raise RuntimeError("wss://browserbase.example/connect?token=must-not-leak")


class FailingProvider(FakeProvider):
    def __init__(self, *, fail_create: bool = False, value_error: bool = False) -> None:
        super().__init__()
        self.fail_create = fail_create
        self.value_error = value_error

    async def create(
        self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]
    ) -> BrowserSession:
        if self.fail_create:
            if self.value_error:
                raise ValueError("wss://browserbase.example/connect?token=must-not-leak")
            raise RuntimeError("wss://browserbase.example/connect?token=must-not-leak")
        session = FailingSession(on_event)
        self.sessions.append(session)
        return session


def client(provider: FakeProvider) -> TestClient:
    return TestClient(
        create_app(
            provider,
            RecordingConfig(service_key="test-key", timeout_seconds=60, max_sessions=4),
        )
    )


def headers(organization: str = "iter7", email: str = "owner@iter7.example") -> dict[str, str]:
    return {
        "X-Workflow-Key": "test-key",
        "x-organization": organization,
        "x-user-email": email,
    }


def create_recording(http: TestClient) -> dict[str, Any]:
    response = http.post("/recordings", json={"url": "https://example.com"}, headers=headers())
    assert response.status_code == 201
    return response.json()


def test_create_returns_only_safe_live_view_response() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        response = http.post("/recordings", json={"url": "https://example.com"}, headers=headers())

    assert response.status_code == 201
    assert response.json() == {
        "id": response.json()["id"],
        "status": "recording",
        "liveViewUrl": "https://browserbase.example/debug?token=secret",
        "steps": [
            {
                "id": response.json()["steps"][0]["id"],
                "type": "navigation",
                "description": "Open example.com",
                "url": "https://example.com",
            }
        ],
        "expiresAt": response.json()["expiresAt"],
        "blockedReason": None,
    }
    assert "test-key" not in response.text


@pytest.mark.parametrize(
    "candidate",
    [
        "http://localhost",
        "http://127.0.0.1",
        "http://10.0.0.1",
        "https://user:password@example.com",
        "file:///tmp/private.html",
    ],
)
def test_create_rejects_private_or_credential_urls(candidate: str) -> None:
    provider = FakeProvider()
    with client(provider) as http:
        response = http.post("/recordings", json={"url": candidate}, headers=headers())

    assert response.status_code == 422
    assert provider.sessions == []
    assert "password" not in response.text


def test_authentication_and_owner_boundaries() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        missing_key = http.post("/recordings", json={"url": "https://example.com"}, headers={})
        assert missing_key.status_code == 401

        response = create_recording(http)
        recording_id = response["id"]
        wrong_owner = http.get(
            f"/recordings/{recording_id}", headers=headers(email="other@iter7.example")
        )
        wrong_tenant = http.get(
            f"/recordings/{recording_id}", headers=headers(organization="other")
        )

    assert wrong_owner.status_code == 404
    assert wrong_tenant.status_code == 404


@pytest.mark.asyncio
async def test_secret_input_blocks_recording_and_omits_value() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit(
            {
                "type": "input",
                "target": "Password",
                "value": "do-not-store-me",
                "secret": True,
            }
        )
        await provider.sessions[0].emit({"type": "click", "target": "Must not be recorded"})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    body = response.json()
    assert body["blockedReason"] == "Credentials and one-time codes cannot be taught yet."
    assert "do-not-store-me" not in response.text
    assert all(step["type"] != "input" for step in body["steps"])
    assert all(step.get("target") != "Must not be recorded" for step in body["steps"])


@pytest.mark.asyncio
async def test_typing_is_compacted_and_late_events_are_ignored_after_stop() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        await session.emit({"type": "input", "target": "Invoice number", "value": "generic-synthetic-secret"})
        await session.emit({"type": "input", "target": "Invoice number", "value": "generic-synthetic-secret-2"})
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers())
        await session.emit({"type": "click", "target": "Submit"})
        read = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert stopped.status_code == 200
    assert session.closed
    inputs = [step for step in read.json()["steps"] if step["type"] == "input"]
    assert len(inputs) == 1
    assert inputs[0].get("value") is None
    assert "generic-synthetic-secret" not in read.text
    assert all(step.get("target") != "Submit" for step in read.json()["steps"])


@pytest.mark.asyncio
async def test_input_values_are_never_persisted() -> None:
    provider = FakeProvider()
    value = "generic-synthetic-secret"
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit({"type": "input", "target": "Notes", "value": value})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    inputs = [step for step in response.json()["steps"] if step["type"] == "input"]
    assert inputs[0].get("value") is None
    assert value not in response.text


@pytest.mark.asyncio
async def test_selected_option_values_are_never_persisted() -> None:
    provider = FakeProvider()
    value = "generic-synthetic-secret"
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit({"type": "select_change", "target": "Status", "value": value})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    selects = [step for step in response.json()["steps"] if step["type"] == "select_change"]
    assert selects[0].get("value") is None
    assert selects[0]["description"] == "Choose option in Status"
    assert value not in response.text


@pytest.mark.asyncio
async def test_capture_limit_is_visible_to_the_user(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(recording_service, "MAX_STEPS", 2)
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit({"type": "click", "target": "First action"})
        await provider.sessions[0].emit({"type": "click", "target": "Ignored action"})
        await provider.sessions[0].emit({"type": "click", "target": "Must not be recorded"})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert response.json()["blockedReason"] == CAPTURE_LIMIT_REASON
    assert [step["description"] for step in response.json()["steps"]] == [
        "Open example.com",
        "Click First action",
    ]


def test_delete_releases_session_and_expired_session_is_honest() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        deleted = http.delete(f"/recordings/{recording['id']}", headers=headers())
        gone = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert deleted.status_code == 204
    assert provider.sessions[0].closed
    assert gone.status_code == 404
    assert "restarted" in gone.json()["detail"]


def test_expired_recording_releases_its_browser_and_hides_live_view() -> None:
    provider = FakeProvider()
    short_lived = TestClient(
        create_app(provider, RecordingConfig(service_key="test-key", timeout_seconds=1, max_sessions=4))
    )
    with short_lived as http:
        recording = create_recording(http)
        time.sleep(1.05)
        expired = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert expired.status_code == 200
    assert expired.json()["status"] == "expired"
    assert expired.json()["liveViewUrl"] is None
    assert provider.sessions[0].closed


def test_new_recording_evicts_stopped_capture_when_memory_is_full() -> None:
    provider = FakeProvider()
    config = RecordingConfig(service_key="test-key", timeout_seconds=60, max_sessions=1)
    one_slot = TestClient(create_app(provider, config))
    with one_slot as http:
        first = create_recording(http)
        assert http.post(f"/recordings/{first['id']}/stop", headers=headers()).status_code == 200
        next_recording = http.post("/recordings", json={"url": "https://example.org"}, headers=headers())
        evicted = http.get(f"/recordings/{first['id']}", headers=headers())

    assert next_recording.status_code == 201
    assert evicted.status_code == 404


@pytest.mark.asyncio
async def test_plain_text_credential_event_blocks_without_persisting_contents() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit(
            {"type": "input", "target": "API token", "value": "credential-that-must-not-persist", "secret": True}
        )
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert response.json()["blockedReason"]
    assert "credential-that-must-not-persist" not in response.text


def test_create_rejects_query_and_fragment_urls_without_creating_a_recording() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        response = http.post(
            "/recordings",
            json={"url": "https://example.com/callback?p=opaque-value#latest"},
            headers=headers(),
        )

    assert response.status_code == 422
    assert provider.sessions == []
    assert "opaque-value" not in response.text


@pytest.mark.asyncio
async def test_navigation_event_with_query_is_omitted_from_recorded_steps() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit({"type": "navigation", "url": "https://example.com/callback?p=opaque-value"})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert [step["url"] for step in response.json()["steps"]] == ["https://example.com"]
    assert "opaque-value" not in response.text


def test_health_endpoint_never_requires_or_leaks_credentials() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        response = http.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize(
    "operation,value_error",
    [("create", False), ("create", True), ("stop", False), ("delete", False)],
)
def test_provider_errors_are_generic_and_never_leak_connection_urls(
    operation: str, value_error: bool
) -> None:
    provider = FailingProvider(fail_create=operation == "create", value_error=value_error)
    with client(provider) as http:
        if operation == "create":
            response = http.post("/recordings", json={"url": "https://example.com"}, headers=headers())
        else:
            recording = create_recording(http)
            url = f"/recordings/{recording['id']}"
            if operation == "stop":
                response = http.post(f"{url}/stop", headers=headers())
            else:
                response = http.delete(url, headers=headers())

    assert response.status_code == 503
    assert response.json()["detail"] == "Recording service is temporarily unavailable."
    assert "must-not-leak" not in response.text


@pytest.mark.asyncio
async def test_typing_with_same_visible_label_in_distinct_fields_does_not_merge() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit(
            {"type": "input", "target": "Amount", "targetKey": "billing|#amount-a", "value": "10"}
        )
        await provider.sessions[0].emit(
            {"type": "input", "target": "Amount", "targetKey": "billing|#amount-b", "value": "20"}
        )
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    inputs = [step for step in response.json()["steps"] if step["type"] == "input"]
    assert [step.get("value") for step in inputs] == [None, None]
