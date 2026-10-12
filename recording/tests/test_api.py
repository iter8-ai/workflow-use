from __future__ import annotations

import json
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
        self.context_id = "context-private"
        self.signed_in = False
        self.cookie_failure = False
        self.deleted = False
        self.start_page_failed = False
        self.navigate_error: Exception | None = None
        self.navigated: list[str] = []

    async def navigate(self, url: str) -> None:
        if self.navigate_error is not None:
            raise self.navigate_error
        self.navigated.append(url)
        self.start_page_failed = False
        await self.emit({"type": "navigation", "url": url})

    async def close(self) -> None:
        self.closed = True

    async def google_signed_in(self) -> bool:
        if self.cookie_failure:
            raise RuntimeError("cookie read failed")
        return self.signed_in

    async def delete_context(self) -> None:
        assert self.closed
        self.deleted = True


class FakeProvider(BrowserProvider):
    def __init__(self, *, start_page_failed: bool = False) -> None:
        self.sessions: list[FakeSession] = []
        self.start_urls: list[str] = []
        self.start_page_failed = start_page_failed

    async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
        self.start_urls.append(start_url)
        session = FakeSession(on_event)
        session.start_page_failed = self.start_page_failed
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

    async def create(self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]]) -> BrowserSession:
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
        "liveViewSwitching": False,
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
        "downloads": [],
        "organizing": False,
        "google": None,
        "startPageFailed": False,
    }
    assert "test-key" not in response.text


def test_create_with_a_failed_start_page_keeps_the_demonstration_open_without_a_step() -> None:
    provider = FakeProvider(start_page_failed=True)
    with client(provider) as http:
        response = http.post("/recordings", json={"url": "https://example.com"}, headers=headers())

    assert response.status_code == 201
    body = response.json()
    assert body["startPageFailed"] is True
    assert body["status"] == "recording"
    assert body["steps"] == []
    assert body["liveViewUrl"] == "https://browserbase.example/debug?token=secret"


def test_navigate_opens_a_page_and_its_navigation_becomes_the_first_step() -> None:
    provider = FakeProvider(start_page_failed=True)
    with client(provider) as http:
        recording = http.post("/recordings", json={"url": "https://example.com"}, headers=headers()).json()
        response = http.post(
            f"/recordings/{recording['id']}/navigate", json={"url": "https://example.com/login"}, headers=headers()
        )

    assert response.status_code == 200
    body = response.json()
    assert body["startPageFailed"] is False
    assert [(step["type"], step["url"]) for step in body["steps"]] == [("navigation", "https://example.com/login")]
    assert provider.sessions[0].navigated == ["https://example.com/login"]


@pytest.mark.parametrize("blocked", [False, True])
@pytest.mark.asyncio
async def test_live_browser_load_clears_failed_start_in_get_and_stop_without_adding_a_step(
    monkeypatch: pytest.MonkeyPatch, blocked: bool
) -> None:
    if blocked:
        monkeypatch.setattr(recording_service, "MAX_STEPS", 1)
    provider = FakeProvider(start_page_failed=True)
    with client(provider) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        assert recording["startPageFailed"] is True and recording["steps"] == []

        await session.emit({"type": "navigation", "url": "https://example.com/login"})
        if blocked:
            await session.emit({"type": "click", "target": "Over the capture limit"})
        await session.emit({"type": "page_loaded", "url": "about:blank"})
        before_load = http.get(f"/recordings/{recording['id']}", headers=headers()).json()
        assert before_load["startPageFailed"] is True
        assert before_load["blockedReason"] == (CAPTURE_LIMIT_REASON if blocked else None)

        await session.emit({"type": "page_loaded", "url": "https://example.com/login"})
        after_load = http.get(f"/recordings/{recording['id']}", headers=headers()).json()
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers()).json()

    for body in (after_load, stopped):
        assert body["startPageFailed"] is False
        assert [(step["type"], step["url"]) for step in body["steps"]] == [
            ("navigation", "https://example.com/login")
        ]


def test_navigate_rejects_unknown_foreign_stopped_and_private_targets() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        path = f"/recordings/{recording['id']}/navigate"
        unknown = http.post("/recordings/missing/navigate", json={"url": "https://example.com"}, headers=headers())
        foreign = http.post(
            path, json={"url": "https://example.com"}, headers=headers("other", "someone@other.example")
        )
        private = http.post(path, json={"url": "http://10.0.0.1"}, headers=headers())
        http.post(f"/recordings/{recording['id']}/stop", headers=headers())
        stopped = http.post(path, json={"url": "https://example.com/next"}, headers=headers())

    assert unknown.status_code == 404
    assert foreign.status_code == 404
    assert private.status_code == 422
    assert private.json()["detail"] == "The recording URL must be a public HTTP(S) URL."
    assert stopped.status_code == 409
    assert provider.sessions[0].navigated == []


def test_navigate_reports_a_page_that_could_not_be_opened_without_provider_text() -> None:
    from playwright.async_api import Error as PlaywrightError

    provider = FakeProvider(start_page_failed=True)
    with client(provider) as http:
        recording = create_recording(http)
        provider.sessions[0].navigate_error = PlaywrightError("net::ERR_HTTP_RESPONSE_CODE_FAILURE wss://x?token=leak")
        response = http.post(
            f"/recordings/{recording['id']}/navigate", json={"url": "https://example.com/gone"}, headers=headers()
        )
        after = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert response.status_code == 422
    assert response.json() == {"detail": "The page could not be opened."}
    assert after.status_code == 200
    assert after.json()["status"] == "recording"
    assert after.json()["startPageFailed"] is True
    assert after.json()["steps"] == []


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
        wrong_owner = http.get(f"/recordings/{recording_id}", headers=headers(email="other@iter7.example"))
        wrong_tenant = http.get(f"/recordings/{recording_id}", headers=headers(organization="other"))

    assert wrong_owner.status_code == 404
    assert wrong_tenant.status_code == 404


@pytest.mark.asyncio
async def test_credential_entry_records_its_kind_and_continues_without_the_value() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        for _ in range(2):
            await provider.sessions[0].emit(
                {"type": "credential", "target": "Password", "targetKey": "p", "value": "password"}
            )
        await provider.sessions[0].emit({"type": "credential", "target": "Token", "value": "do-not-store-me"})
        await provider.sessions[0].emit({"type": "click", "target": "Download report"})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    body = response.json()
    assert body["blockedReason"] is None
    assert [(step["type"], step.get("value")) for step in body["steps"][1:]] == [
        ("credential", "password"),
        ("click", None),
    ]
    assert "do-not-store-me" not in response.text


@pytest.mark.asyncio
async def test_stop_hands_over_captured_sign_in_values_once() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        await session.emit({"type": "credential", "target": "Email", "targetKey": "u", "value": "username"})
        await session.emit({"type": "sign_in_value", "value": "username", "secret": "synthetic-user"})
        for typed in ("s", "synthetic-password"):
            await session.emit({"type": "sign_in_value", "value": "password", "secret": typed})
        # Only username and password are ever kept; anything else is ignored.
        await session.emit({"type": "sign_in_value", "value": "otp", "secret": "123456"})
        during = http.get(f"/recordings/{recording['id']}", headers=headers())
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers())
        again = http.post(f"/recordings/{recording['id']}/stop", headers=headers())
        after = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert stopped.json()["credentials"] == {"username": "synthetic-user", "password": "synthetic-password"}
    stop_schema = http.get("/openapi.json").json()["components"]["schemas"]
    assert set(stop_schema["CapturedCredentials"]["properties"]) == {"username", "password"}
    assert "credentials" in stop_schema["StoppedRecordingResponse"]["properties"]
    assert stopped.headers["cache-control"] == "no-store"
    for response in (during, again, after):
        assert "credentials" not in response.json()
        assert "synthetic" not in response.text
    assert "synthetic" not in json.dumps(stopped.json()["steps"])
    assert "123456" not in stopped.text


@pytest.mark.asyncio
async def test_cleared_or_oversized_sign_in_field_hands_over_nothing() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        for secret in ("synthetic-password", ""):
            await session.emit({"type": "sign_in_value", "value": "password", "secret": secret})
        for secret in ("synthetic-user", "x" * 10_000):
            await session.emit({"type": "sign_in_value", "value": "username", "secret": secret})
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers())

    assert "credentials" not in stopped.json()
    assert "synthetic" not in stopped.text


@pytest.mark.asyncio
async def test_deleted_or_expired_recordings_forget_captured_sign_in_values() -> None:
    service = recording_service.RecordingService(FakeProvider(), timeout_seconds=60)
    owner = recording_service.RecordingOwner("iter7", "owner@iter7.example")
    event = {"type": "sign_in_value", "value": "password", "secret": "synthetic-password"}

    deleted = await service.create(owner, "https://example.com/")
    await service.record_event(deleted.id, event)
    assert await service.delete(deleted.id, owner)

    expired = await service.create(owner, "https://example.com/")
    await service.record_event(expired.id, event)
    expired.expires_at = expired.expires_at.replace(year=2000)
    await service.cleanup()

    assert deleted.credentials == {} and expired.credentials == {}
    assert "synthetic-password" not in repr(deleted) + repr(expired)


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
    assert inputs[0]["value"] == "generic-synthetic-secret-2"
    assert all(step.get("target") != "Submit" for step in read.json()["steps"])


@pytest.mark.asyncio
async def test_input_values_are_kept_for_replay() -> None:
    provider = FakeProvider()
    value = "generic-synthetic-secret"
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit({"type": "input", "target": "Notes", "value": value})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    inputs = [step for step in response.json()["steps"] if step["type"] == "input"]
    assert inputs[0]["value"] == value


@pytest.mark.asyncio
async def test_selected_option_labels_are_kept_for_replay() -> None:
    provider = FakeProvider()
    value = "generic-synthetic-secret"
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit({"type": "select_change", "target": "Status", "value": value})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    selects = [step for step in response.json()["steps"] if step["type"] == "select_change"]
    assert selects[0]["value"] == value
    assert selects[0]["description"] == f"Choose {value} in Status"


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


def test_signed_in_context_is_private_and_claimed_once() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        url = f"/recordings/{recording['id']}"
        session = provider.sessions[0]
        session.signed_in = True
        assert http.post(f"{url}/google-context", headers=headers()).status_code == 409
        stopped = http.post(f"{url}/stop", headers=headers())
        read = http.get(url, headers=headers())
        foreign = http.post(f"{url}/google-context", headers=headers(email="other@iter7.example"))
        claimed = http.post(f"{url}/google-context", headers=headers())
        again = http.post(f"{url}/google-context", headers=headers())
    assert stopped.json()["google"] == read.json()["google"] == {"signedIn": True}
    assert "context-private" not in stopped.text + read.text
    assert foreign.status_code == 404
    assert claimed.json() == {"contextId": "context-private"}
    assert again.status_code == 200 and again.json() == claimed.json()
    assert not session.deleted


def test_google_context_confirm_routes_follow_state_table() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        url = f"/recordings/{recording['id']}/google-context"
        provider.sessions[0].signed_in = True
        for suffix in ("/adopted", "/returned"):
            assert http.post(url + suffix, headers=headers()).status_code == 409
        assert http.post(url, headers=headers()).status_code == 409

        http.post(f"/recordings/{recording['id']}/stop", headers=headers())
        assert http.post(url + "/returned", headers=headers()).status_code == 204
        assert http.post(url + "/adopted", headers=headers()).status_code == 409
        assert http.post(url, headers=headers()).json() == {"contextId": "context-private"}
        assert http.post(url, headers=headers()).json() == {"contextId": "context-private"}
        assert http.post(url + "/adopted", headers=headers()).status_code == 204
        assert http.post(url + "/adopted", headers=headers()).status_code == 204
        assert http.post(url + "/returned", headers=headers()).status_code == 409
        unavailable = http.post(url, headers=headers())
        assert unavailable.status_code == 409
        assert unavailable.json()["detail"] == "google_context_unavailable"
        assert "context-private" not in unavailable.text

        returned = create_recording(http)
        returned_url = f"/recordings/{returned['id']}/google-context"
        provider.sessions[1].signed_in = True
        http.post(f"/recordings/{returned['id']}/stop", headers=headers())
        assert http.post(returned_url, headers=headers()).status_code == 200
        assert http.post(returned_url + "/returned", headers=headers()).status_code == 204
        assert http.post(returned_url + "/returned", headers=headers()).status_code == 204
        assert http.post(returned_url, headers=headers()).json() == {"contextId": "context-private"}


def test_google_context_routes_hide_foreign_and_unknown_recordings() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        provider.sessions[0].signed_in = True
        http.post(f"/recordings/{recording['id']}/stop", headers=headers())
        assert http.post(f"/recordings/{recording['id']}/google-context", headers=headers()).status_code == 200
        for suffix in ("", "/adopted", "/returned"):
            for recording_id, request_headers in (
                (recording["id"], headers(email="foreign@iter7.example")),
                ("unknown", headers()),
            ):
                response = http.post(f"/recordings/{recording_id}/google-context{suffix}", headers=request_headers)
                assert response.status_code == 404


def test_unsigned_context_is_deleted_after_release() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        url = f"/recordings/{recording['id']}"
        stopped = http.post(f"{url}/stop", headers=headers())
        claimed = http.post(f"{url}/google-context", headers=headers())
    assert stopped.json()["google"] == {"signedIn": False}
    assert provider.sessions[0].deleted
    assert claimed.status_code == 409


def test_cookie_read_failure_fails_closed_and_deletes_context() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        provider.sessions[0].cookie_failure = True
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers())
    assert stopped.json()["google"] == {"signedIn": False}
    assert provider.sessions[0].deleted


def test_delete_and_eviction_remove_unclaimed_contexts() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        first = create_recording(http)
        provider.sessions[0].signed_in = True
        http.post(f"/recordings/{first['id']}/stop", headers=headers())
        http.delete(f"/recordings/{first['id']}", headers=headers())
        assert provider.sessions[0].deleted

    provider = FakeProvider()
    one_slot = TestClient(
        create_app(provider, RecordingConfig(service_key="test-key", timeout_seconds=60, max_sessions=1))
    )
    with one_slot as http:
        first = create_recording(http)
        provider.sessions[0].signed_in = True
        http.post(f"/recordings/{first['id']}/stop", headers=headers())
        create_recording(http)
        assert provider.sessions[0].deleted


@pytest.mark.asyncio
async def test_typing_into_a_secret_labelled_field_keeps_only_the_kind() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit(
            {"type": "input", "target": "API token", "value": "credential-that-must-not-persist"}
        )
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert "credential-that-must-not-persist" not in response.text
    assert [(step["type"], step["value"]) for step in response.json()["steps"][1:]] == [("credential", "password")]


@pytest.mark.asyncio
async def test_typed_text_is_kept_verbatim_and_oversized_text_is_not_truncated() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit(
            {"type": "input", "target": "Notes", "targetKey": "a", "value": "Line one\n  two"}
        )
        await provider.sessions[0].emit({"type": "input", "target": "Memo", "targetKey": "b", "tooLong": True})
        await provider.sessions[0].emit({"type": "input", "target": "PIN", "targetKey": "c", "value": "sunflower"})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    steps = response.json()["steps"][1:]
    assert [(step["type"], step.get("value")) for step in steps] == [
        ("input", "Line one\n  two"),
        ("input", None),
        ("credential", "password"),
    ]
    assert "sunflower" not in response.text


def test_create_opens_the_typed_address_with_its_query_and_fragment() -> None:
    provider = FakeProvider()
    url = "https://example.com/billing/?business_id=123#invoices"
    with client(provider) as http:
        response = http.post("/recordings", json={"url": url}, headers=headers())

    assert response.status_code == 201
    assert provider.start_urls == [url]


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
def test_provider_errors_are_generic_and_never_leak_connection_urls(operation: str, value_error: bool) -> None:
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
    assert [step.get("value") for step in inputs] == ["10", "20"]


def test_start_url_whose_host_does_not_resolve_is_rejected_before_a_browser_is_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def unresolvable(_url: str) -> bool:
        return False

    monkeypatch.setattr(recording_service, "resolves_to_public_host", unresolvable, raising=False)
    provider = FakeProvider()
    with client(provider) as http:
        response = http.post(
            "/recordings", json={"url": "https://no-such-host.example/private-path"}, headers=headers()
        )

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "The recording URL host no-such-host.example could not be resolved to a public address."
    )
    assert provider.sessions == []


@pytest.mark.parametrize("value_error, error_type", [(False, "RuntimeError"), (True, "ValueError")])
def test_failed_recording_start_is_logged_by_error_type_without_connection_details(
    caplog: pytest.LogCaptureFixture,
    value_error: bool,
    error_type: str,
) -> None:
    provider = FailingProvider(fail_create=True, value_error=value_error)
    with caplog.at_level("WARNING", logger="workflow_use_recording"), client(provider) as http:
        response = http.post("/recordings", json={"url": "https://example.com"}, headers=headers())

    assert response.status_code == 503
    assert response.json() == {"detail": "Recording service is temporarily unavailable."}
    messages = [record.getMessage() for record in caplog.records if record.levelname == "WARNING"]
    assert f"recording_start_failed error_type={error_type}" in messages
    assert "wss://browserbase.example/connect" not in caplog.text
    assert "must-not-leak" not in caplog.text
    assert "Traceback" not in caplog.text
