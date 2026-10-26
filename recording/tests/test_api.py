from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

import workflow_use_recording.service as recording_service
from workflow_use_recording.api import RecordingConfig, create_app
from workflow_use_recording.provider import BrowserProvider, BrowserSession, RecordingStartTimeout
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
        self.start_page_blocked = False
        self.network = "direct"
        self.proxy_country: str | None = None
        self.navigate_error: Exception | None = None
        self.navigated: list[str] = []
        self.tabs = [{"id": "tab-1", "title": "Example", "url": "https://example.com", "active": True}]
        self.active_tab_id = "tab-1"

    async def select_tab(self, tab_id: str) -> None:
        for tab in self.tabs:
            tab["active"] = tab["id"] == tab_id
            if tab["active"]:
                self.active_tab_id = tab_id
                self.live_view_url = f"https://browserbase.example/{tab_id}"

    async def close_tab(self, tab_id: str) -> None:
        index = next(index for index, tab in enumerate(self.tabs) if tab["id"] == tab_id)
        active = self.tabs[index]["active"]
        self.tabs.pop(index)
        if active:
            selected = self.tabs[max(index - 1, 0)]
            await self.select_tab(selected["id"])

    async def navigate(self, url: str) -> None:
        if self.navigate_error is not None:
            raise self.navigate_error
        self.navigated.append(url)
        self.start_page_failed = False
        self.start_page_blocked = False
        await self.emit({"type": "navigation", "url": url, "tabId": self.active_tab_id})

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
    def __init__(self, *, start_page_failed: bool = False, start_page_blocked: bool = False) -> None:
        self.sessions: list[FakeSession] = []
        self.start_urls: list[str] = []
        self.options: list[dict[str, Any]] = []
        self.start_page_failed = start_page_failed
        self.start_page_blocked = start_page_blocked

    async def create(
        self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]], **options: Any
    ) -> BrowserSession:
        self.start_urls.append(start_url)
        self.options.append(options)
        session = FakeSession(on_event)
        session.start_page_failed = self.start_page_failed
        if self.start_page_blocked:
            # The provider retried over a proxy and the site still answered with a block page.
            session.start_page_blocked = True
            session.network = "proxy"
            session.proxy_country = options.get("country") or "EE"
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
        self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]], **_options: Any
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
        "liveViewSwitching": False,
        "tabs": [{"id": "tab-1", "title": "Example", "url": "https://example.com", "active": True}],
        "activeTabId": "tab-1",
        "steps": [
            {
                "id": response.json()["steps"][0]["id"],
                "type": "navigation",
                "description": "Open example.com",
                "url": "https://example.com",
                "tabId": "tab-1",
            }
        ],
        "expiresAt": response.json()["expiresAt"],
        "blockedReason": None,
        "downloads": [],
        "organizing": False,
        "google": None,
        "startPageFailed": False,
        "startPageBlocked": False,
        "network": "direct",
        "proxyCountry": None,
    }
    assert "test-key" not in response.text
    assert provider.options == [{"context_id": None, "login": None, "country": None}]


def test_a_blocked_start_page_reports_the_proxy_and_the_stop_response_keeps_it() -> None:
    provider = FakeProvider(start_page_blocked=True)
    with client(provider) as http:
        created = http.post("/recordings", json={"url": "https://example.com", "country": "de"}, headers=headers())
        recording = created.json()
        fetched = http.get(f"/recordings/{recording['id']}", headers=headers()).json()
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers()).json()

    assert created.status_code == 201
    assert provider.options[0]["country"] == "DE"
    assert (recording["startPageBlocked"], recording["network"], recording["proxyCountry"]) == (True, "proxy", "DE")
    assert recording["startPageFailed"] is False and recording["status"] == "recording"
    assert fetched["startPageBlocked"] is True
    # The host saves the network the demonstration ended up on with the agent.
    assert (stopped["network"], stopped["proxyCountry"]) == ("proxy", "DE")
    assert stopped["status"] == "stopped"


@pytest.mark.parametrize("country", ["EST", "E1", "", "E", 12, "e-"])
def test_create_rejects_a_country_that_is_not_an_alpha_2_code(country: Any) -> None:
    provider = FakeProvider()
    with client(provider) as http:
        response = http.post("/recordings", json={"url": "https://example.com", "country": country}, headers=headers())

    assert response.status_code == 422
    assert response.json()["detail"][0]["loc"] == ["body", "country"]
    assert provider.sessions == []


@pytest.mark.asyncio
async def test_a_loaded_page_or_a_navigate_clears_the_start_page_block_like_a_failed_start() -> None:
    provider = FakeProvider(start_page_blocked=True)
    with client(provider) as http:
        first = create_recording(http)
        session = provider.sessions[0]
        await session.emit({"type": "page_loaded", "url": "https://example.com/reports"})
        after_load = http.get(f"/recordings/{first['id']}", headers=headers()).json()

        second = create_recording(http)
        navigated = http.post(
            f"/recordings/{second['id']}/navigate", json={"url": "https://example.com/login"}, headers=headers()
        ).json()
        stopped = http.post(f"/recordings/{second['id']}/stop", headers=headers()).json()

    assert first["startPageBlocked"] is True and after_load["startPageBlocked"] is False
    assert second["startPageBlocked"] is True and navigated["startPageBlocked"] is False
    assert stopped["startPageBlocked"] is False
    # Clearing the block does not forget which network the browser is on.
    assert (after_load["network"], stopped["network"]) == ("proxy", "proxy")


def test_select_and_close_tab_switch_the_live_view_and_record_steps() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        created = create_recording(http)
        provider.sessions[0].tabs.append(
            {"id": "tab-2", "title": "Reports", "url": "https://reports.example.com/", "active": False}
        )
        selected = http.post(f"/recordings/{created['id']}/tabs/tab-2/select", headers=headers())
        closed = http.post(f"/recordings/{created['id']}/tabs/tab-2/close", headers=headers())

    assert selected.status_code == 200
    body = selected.json()
    assert body["activeTabId"] == "tab-2" and body["liveViewUrl"] == "https://browserbase.example/tab-2"
    assert [tab["active"] for tab in body["tabs"]] == [False, True]
    assert body["steps"][-1]["type"] == "switch_tab" and body["steps"][-1]["tabId"] == "tab-2"
    assert body["steps"][-1]["description"] == 'Switch to the tab "Reports"'
    assert closed.status_code == 200
    body = closed.json()
    assert [tab["id"] for tab in body["tabs"]] == ["tab-1"] and body["activeTabId"] == "tab-1"
    assert body["steps"][-1] == {
        "id": body["steps"][-1]["id"],
        "type": "close_tab",
        "description": 'Close the tab "Reports"',
        "tabId": "tab-2",
    }


def test_tab_endpoints_reject_unknown_tab_last_tab_and_inactive_recording() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        created = create_recording(http)
        base = f"/recordings/{created['id']}"
        unknown_select = http.post(f"{base}/tabs/tab-9/select", headers=headers())
        unknown_close = http.post(f"{base}/tabs/tab-9/close", headers=headers())
        last = http.post(f"{base}/tabs/tab-1/close", headers=headers())
        missing = http.post("/recordings/nope/tabs/tab-1/select", headers=headers())
        http.post(f"{base}/stop", headers=headers())
        stopped = http.post(f"{base}/tabs/tab-1/select", headers=headers())

    assert (unknown_select.status_code, unknown_close.status_code) == (404, 404)
    assert last.status_code == 409
    assert missing.status_code == 404
    assert stopped.status_code == 409


@pytest.mark.asyncio
async def test_a_block_page_that_lands_after_create_marks_the_recording_blocked_until_a_page_loads() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        # Akamai's challenge page loaded, then its script re-requested the page and was refused.
        await session.emit({"type": "page_blocked", "status": 403})
        blocked = http.get(f"/recordings/{recording['id']}", headers=headers()).json()
        await session.emit({"type": "page_loaded", "url": "https://example.com/account"})
        cleared = http.get(f"/recordings/{recording['id']}", headers=headers()).json()
        await session.emit({"type": "page_blocked", "status": 429})
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers()).json()

    assert recording["startPageBlocked"] is False
    assert blocked["startPageBlocked"] is True and blocked["steps"] == recording["steps"]
    assert cleared["startPageBlocked"] is False
    assert stopped["startPageBlocked"] is True and stopped["network"] == "direct"


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


def test_start_page_timeout_has_clear_response_without_leaking_provider_details() -> None:
    class TimeoutProvider(FakeProvider):
        async def create(
            self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]], **_options: Any
        ) -> BrowserSession:
            raise RecordingStartTimeout("wss://connect.example/?signingKey=must-not-leak")

    with client(TimeoutProvider()) as http:
        response = http.post("/recordings", json={"url": "https://example.com"}, headers=headers())

    assert response.status_code == 504
    assert response.json() == {"detail": "The recording start page did not load in time."}
    assert "must-not-leak" not in response.text


def test_startup_deadline_releases_capacity_for_the_next_create(monkeypatch: pytest.MonkeyPatch) -> None:
    class SlowProvider(FakeProvider):
        def __init__(self) -> None:
            super().__init__()
            self.cancelled = False

        async def create(
            self, start_url: str, on_event: Callable[[dict[str, Any]], Awaitable[None]], **_options: Any
        ) -> BrowserSession:
            if not self.cancelled:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.cancelled = True
                    raise
            return await super().create(start_url, on_event)

    monkeypatch.setattr(recording_service, "CREATE_TIMEOUT_SECONDS", 0.01)
    provider = SlowProvider()
    app = create_app(provider, RecordingConfig(service_key="test-key", max_sessions=1))
    with TestClient(app) as http:
        first = http.post("/recordings", json={"url": "https://example.com"}, headers=headers())
        second = http.post("/recordings", json={"url": "https://example.com"}, headers=headers())

    assert first.status_code == 504
    assert first.json() == {"detail": "The recording start page did not load in time."}
    assert provider.cancelled
    assert second.status_code == 201


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
        assert [(step["type"], step["url"]) for step in body["steps"]] == [("navigation", "https://example.com/login")]


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
async def test_navigation_event_with_query_and_fragment_is_recorded_intact() -> None:
    provider = FakeProvider()
    report_url = "https://example.com/report?month=2026-09#top"
    with client(provider) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit({"type": "navigation", "url": report_url})
        response = http.get(f"/recordings/{recording['id']}", headers=headers())

    assert [step["url"] for step in response.json()["steps"]] == ["https://example.com", report_url]


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


SAVED_PASSWORD = "saved-password-must-not-leak"


def test_create_passes_a_saved_sign_in_to_the_browser_and_never_returns_it(caplog: pytest.LogCaptureFixture) -> None:
    provider = FakeProvider()
    body = {
        "url": "https://example.com",
        "context_id": "context-saved-google",
        "login": {
            "origins": ["https://Login.Example.com/", "http://intranet.example.com:8080"],
            "username": "person@example.com",
            "password": SAVED_PASSWORD,
        },
    }
    with client(provider) as http:
        response = http.post("/recordings", json=body, headers=headers())

    assert response.status_code == 201
    [options] = provider.options
    assert options["context_id"] == "context-saved-google"
    login = options["login"]
    assert login.origins == ["https://login.example.com", "http://intranet.example.com:8080"]
    assert login.username.get_secret_value() == "person@example.com"
    assert login.password.get_secret_value() == SAVED_PASSWORD
    assert SAVED_PASSWORD not in response.text and "person@example.com" not in response.text
    assert SAVED_PASSWORD not in caplog.text


def test_create_without_a_saved_sign_in_passes_nothing() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        create_recording(http)

    assert provider.options == [{"context_id": None, "login": None, "country": None}]


def test_create_canonicalizes_unicode_and_trailing_dot_login_origins() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        response = http.post(
            "/recordings",
            json={
                "url": "https://example.com",
                "login": {"origins": ["https://BÜCHER.example./"], "password": SAVED_PASSWORD},
            },
            headers=headers(),
        )

    assert response.status_code == 201
    assert provider.options[0]["login"].origins == ["https://xn--bcher-kva.example."]


def test_create_keeps_unicode_idn_distinct_from_ascii_hostname() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        response = http.post(
            "/recordings",
            json={
                "url": "https://example.com",
                "login": {"origins": ["https://faß.example", "https://fass.example"], "password": SAVED_PASSWORD},
            },
            headers=headers(),
        )

    assert response.status_code == 201
    assert provider.options[0]["login"].origins == ["https://xn--fa-hia.example", "https://fass.example"]


def test_create_rejects_malformed_ipv6_origin_without_echoing_host() -> None:
    provider = FakeProvider()
    with client(provider) as http:
        response = http.post(
            "/recordings",
            json={
                "url": "https://example.com",
                "login": {"origins": ["https://[private-marker]/"], "password": SAVED_PASSWORD},
            },
            headers=headers(),
        )

    assert response.status_code == 422
    assert response.json()["detail"] == [
        {
            "type": "value_error",
            "loc": ["body", "login", "origins"],
            "msg": "Value error, Each origin must be an HTTP(S) origin such as https://app.example.com.",
        }
    ]
    assert "private-marker" not in response.text
    assert SAVED_PASSWORD not in response.text
    assert provider.options == []


@pytest.mark.parametrize(
    "extra",
    [
        {"context_id": ""},
        {"context_id": 7},
        {"login": {"origins": [], "password": SAVED_PASSWORD}},
        {"login": {"origins": ["https://example.com"] * 11, "password": SAVED_PASSWORD}},
        {"login": {"origins": ["https://example.com/sign-in"], "password": SAVED_PASSWORD}},
        {"login": {"origins": ["ftp://example.com"], "password": SAVED_PASSWORD}},
        {"login": {"origins": ["https://example.com"]}},
        {"login": {"origins": ["https://example.com"], "password": ""}},
        {"login": {"origins": ["https://example.com"], "password": SAVED_PASSWORD + "x" * 2000}},
        {"login": {"origins": ["https://example.com"], "username": SAVED_PASSWORD + "x" * 2000, "password": "p"}},
        {"login": {"origins": ["https://example.com"], "password": 123}},
        {"login": SAVED_PASSWORD},
        {"url": 5, "login": {"origins": ["https://example.com"], "password": SAVED_PASSWORD}},
    ],
)
def test_create_rejects_an_invalid_saved_sign_in_without_echoing_it(extra: dict[str, Any]) -> None:
    provider = FakeProvider()
    with client(provider) as http:
        response = http.post("/recordings", json={"url": "https://example.com", **extra}, headers=headers())

    assert response.status_code == 422
    assert SAVED_PASSWORD not in response.text
    assert provider.options == []
