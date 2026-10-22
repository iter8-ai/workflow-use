from __future__ import annotations

from typing import Any

import pytest
from test_api import FakeProvider, FakeSession, client, headers

WEBSITE = {"grant": "opaque-fire-grant", "origin": "https://app.example.com"}
STATE = {
    "cookies": [{"name": "session", "value": "site-secret", "domain": ".example.com", "path": "/", "expires": -1}],
    "origins": [],
}


class WebsiteSession(FakeSession):
    capture_error: Exception | None = None
    email: str | None = "person@example.com"

    async def capture_website_session(self, origin: str) -> tuple[str | None, dict[str, Any]]:
        if self.closed:
            raise RuntimeError("Cannot capture a closed browser")
        if self.capture_error:
            raise self.capture_error
        return self.email, STATE


class WebsiteProvider(FakeProvider):
    async def create(self, start_url: str, on_event: Any, **options: Any) -> WebsiteSession:
        session = WebsiteSession(on_event)
        self.sessions.append(session)
        return session


def start(http: Any, **extra: Any) -> Any:
    return http.post(
        "/recordings", json={"url": "https://app.example.com", "website_session": WEBSITE, **extra}, headers=headers()
    )


def test_stop_returns_same_handoff_until_deleted() -> None:
    with client(WebsiteProvider()) as http:
        created = start(http)
        assert created.status_code == 201
        path = f"/recordings/{created.json()['id']}"
        assert "websiteSession" not in created.json()
        first = http.post(path + "/stop", headers=headers())
        expected = {**WEBSITE, "googleEmail": "person@example.com", "state": STATE}
        assert first.json()["websiteSession"] == expected
        assert first.json()["websiteSessionStatus"] == "captured"
        assert first.headers["Cache-Control"] == "no-store"
        assert http.post(path + "/stop", headers=headers()).json()["websiteSession"] == expected
        assert "websiteSession" not in http.get(path, headers=headers()).json()
        assert http.post(path + "/google-context", headers=headers()).status_code == 409
        assert http.delete(path, headers=headers()).status_code == 204
        assert http.post(path + "/stop", headers=headers()).status_code == 404


@pytest.mark.parametrize("failure", ["identity", "capture"], ids=["missing_identity", "capture_error"])
def test_stop_reports_no_handoff_when_capture_is_unusable(failure: str) -> None:
    provider = WebsiteProvider()
    with client(provider) as http:
        created = start(http).json()
        session = provider.sessions[0]
        if failure == "identity":
            session.email = None
        else:
            session.capture_error = RuntimeError("secret-error-must-not-leak")
        response = http.post(f"/recordings/{created['id']}/stop", headers=headers())
        assert response.status_code == 200
        assert response.json()["status"] == "stopped"
        assert response.json()["websiteSessionStatus"] == ("rejected" if failure == "identity" else "unavailable")
        assert "websiteSession" not in response.json()
        assert "secret-error-must-not-leak" not in response.text
        assert http.post(f"/recordings/{created['id']}/google-context", headers=headers()).status_code == 409


@pytest.mark.parametrize(
    "extra",
    [
        {"context_id": "borrowed"},
        {"login": {"origins": ["https://app.example.com"], "password": "secret"}},
        *[
            {"website_session": {**WEBSITE, "origin": origin}}
            for origin in [
                "file:///etc/passwd",
                "https://app.example.com/path",
                "https://google.com",
                "https://accounts.google.com",
                "https://user:secret@app.example.com",
                "https://app.example.com:bad",
                "https://localhost",
            ]
        ],
    ],
    ids=["borrowed", "login", "file", "path", "google", "google_accounts", "userinfo", "port", "localhost"],
)
def test_invalid_website_session_request_is_rejected_without_secret_echo(extra: dict[str, Any]) -> None:
    with client(WebsiteProvider()) as http:
        response = start(http, **extra)
        assert response.status_code == 422
        assert "opaque-fire-grant" not in response.text
        assert "secret" not in response.text


def test_legacy_stop_has_no_website_session_fields() -> None:
    with client(FakeProvider()) as http:
        created = http.post("/recordings", json={"url": "https://example.com"}, headers=headers()).json()
        stopped = http.post(f"/recordings/{created['id']}/stop", headers=headers()).json()
        assert "websiteSession" not in stopped
        assert "websiteSessionStatus" not in stopped


class IdentityPage:
    def __init__(self, labels: list[str], url: str = "https://myaccount.google.com/") -> None:
        self.labels = labels
        self.url = url
        self.closed = False

    async def goto(self, _url: str, **_options: Any) -> None:
        pass

    def locator(self, _selector: str) -> IdentityPage:
        return self

    @property
    def first(self) -> IdentityPage:
        return self

    async def wait_for(self, **_options: Any) -> None:
        if not self.labels:
            from playwright.async_api import TimeoutError as PlaywrightTimeoutError

            raise PlaywrightTimeoutError("Account label missing")

    async def evaluate_all(self, _script: str) -> list[str]:
        return self.labels

    async def close(self) -> None:
        self.closed = True


class StorageContext:
    def __init__(self, page: IdentityPage) -> None:
        self.page = page
        self.identity_started = False

    async def storage_state(self) -> dict[str, Any]:
        if self.identity_started:
            raise RuntimeError("Identity navigation changed the state")
        return {
            "cookies": [
                *STATE["cookies"],
                {"name": "SID", "value": "google-secret", "domain": ".google.com", "path": "/", "expires": -1},
                {"name": "sibling", "value": "other-secret", "domain": "api.example.com", "path": "/", "expires": -1},
                {"name": "old", "value": "expired", "domain": "app.example.com", "path": "/", "expires": 1},
                *[
                    {"name": name, "value": "verdict", "domain": ".example.com", "path": "/", "expires": -1}
                    for name in ["cf_clearance", "__cf_bm", "_cfuvid", "__cflb", "cf_chl_test"]
                ],
            ],
            "origins": [
                {
                    "origin": "https://app.example.com",
                    "localStorage": [{"name": "token", "value": "site-token"}],
                    "indexedDB": ["must-not-leak"],
                },
                {
                    "origin": "https://myaccount.google.com",
                    "localStorage": [{"name": "token", "value": "google-secret"}],
                },
                {"origin": "https://api.example.com", "localStorage": [{"name": "token", "value": "sibling-secret"}]},
                {"origin": "http://app.example.com", "localStorage": [{"name": "token", "value": "http-secret"}]},
            ],
        }

    async def new_page(self) -> IdentityPage:
        self.identity_started = True
        return self.page


@pytest.mark.parametrize(
    ("labels", "url", "email"),
    [
        (["Google Account: Person (Person@example.com)"], "https://myaccount.google.com/", "person@example.com"),
        (["Google Account: first@example.com second@example.com"], "https://myaccount.google.com/", None),
        (["Google Account: Person"], "https://myaccount.google.com/", None),
        ([], "https://myaccount.google.com/", None),
        (["Google Account: person@example.com"], "https://myaccount.google.com.evil.example/", None),
        (["Google Account: person@example.com"], "http://myaccount.google.com/", None),
    ],
    ids=["verified", "ambiguous", "unknown", "missing_label", "untrusted_host", "insecure"],
)
async def test_provider_returns_only_site_state_with_trusted_unique_identity(
    labels: list[str], url: str, email: str | None
) -> None:
    from types import SimpleNamespace

    from workflow_use_recording.provider import PlaywrightRecordingSession

    page = IdentityPage(labels, url)
    session = PlaywrightRecordingSession(
        browser=SimpleNamespace(contexts=[StorageContext(page)]), runtime=None, live_view_url=None
    )
    assert await session.capture_website_session(WEBSITE["origin"]) == (
        email,
        {
            "cookies": STATE["cookies"],
            "origins": [
                {"origin": "https://app.example.com", "localStorage": [{"name": "token", "value": "site-token"}]}
            ],
        },
    )
    assert page.closed is True


@pytest.mark.parametrize(
    "host",
    ["google.com", "www.google.fi", "google.co.uk", "mail.google.co.uk", "youtube.com", "www.youtube.com"],
    ids=["google", "google_country", "google_country_apex", "google_country_subdomain", "youtube", "youtube_subdomain"],
)
def test_google_website_state_is_excluded_when_origin_is_requested(host: str) -> None:
    from workflow_use_recording.security import website_state

    origin = "https://" + host
    with client(WebsiteProvider()) as http:
        assert start(http, website_session={**WEBSITE, "origin": origin}).status_code == 422
    state = {
        "cookies": [{"name": "session", "value": "secret", "domain": "." + host, "path": "/", "expires": -1}],
        "origins": [{"origin": origin, "localStorage": [{"name": "token", "value": "secret"}]}],
    }
    assert website_state(state, origin) == {"cookies": [], "origins": []}


@pytest.mark.parametrize(
    "host",
    ["google.com.evil.example", "www.google.fi.evil.example", "youtube.com.evil.example", "notgoogle.com"],
    ids=["google_suffix", "country_suffix", "youtube_suffix", "google_prefix"],
)
def test_non_google_website_state_is_preserved_when_host_resembles_google(host: str) -> None:
    from workflow_use_recording.models import RecordingWebsiteSession
    from workflow_use_recording.security import website_state

    origin = "https://" + host
    assert RecordingWebsiteSession(**{**WEBSITE, "origin": origin}).origin == origin
    state = {
        "cookies": [{"name": "session", "value": "site", "domain": host, "path": "/", "expires": -1}],
        "origins": [{"origin": origin, "localStorage": [{"name": "token", "value": "site"}]}],
    }
    assert website_state(state, origin) == state


@pytest.mark.parametrize(
    ("failure", "status"),
    [("missing_label", "rejected"), ("goto", "unavailable"), ("evaluate_all", "unavailable")],
    ids=["missing_label_rejected", "navigation_timeout_unavailable", "evaluation_timeout_unavailable"],
)
def test_stop_classifies_identity_capture_failure(failure: str, status: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from playwright.async_api import TimeoutError as PlaywrightTimeoutError

    from workflow_use_recording.provider import PlaywrightRecordingSession

    page = IdentityPage([] if failure == "missing_label" else ["Google Account: person@example.com"])
    if failure != "missing_label":
        monkeypatch.setattr(page, failure, AsyncMock(side_effect=PlaywrightTimeoutError("Browser timed out")))
    capture = PlaywrightRecordingSession(
        browser=SimpleNamespace(contexts=[StorageContext(page)]), runtime=None, live_view_url=None
    )
    provider = WebsiteProvider()
    with client(provider) as http:
        created = start(http).json()
        monkeypatch.setattr(provider.sessions[0], "capture_website_session", capture.capture_website_session)
        response = http.post(f"/recordings/{created['id']}/stop", headers=headers())
        assert response.status_code == 200
        assert response.json()["websiteSessionStatus"] == status
        assert "websiteSession" not in response.json()
    assert page.closed is True


async def test_expired_recording_never_returns_website_handoff() -> None:
    from datetime import UTC, datetime, timedelta

    from workflow_use_recording.models import RecordingWebsiteSession
    from workflow_use_recording.service import RecordingOwner, RecordingService

    service = RecordingService(WebsiteProvider())
    owner = RecordingOwner("staging", "owner@example.com")
    recording = await service.create(
        owner, "https://app.example.com", website_session=RecordingWebsiteSession(**WEBSITE)
    )
    recording.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    stopped = await service.stop(recording.id, owner)
    assert stopped.status == "expired"
    assert stopped.website_session_payload is None
    assert stopped.website_session is None
    await service.close()


@pytest.mark.parametrize("action", ["expiry", "delete", "stop"], ids=["expiry", "delete", "explicit_stop"])
async def test_website_context_is_deleted_after_failed_close_retry(action: str) -> None:
    from datetime import UTC, datetime, timedelta

    from workflow_use_recording.models import RecordingWebsiteSession
    from workflow_use_recording.service import RecordingOwner, RecordingService

    class RetryCloseSession(WebsiteSession):
        fail_close = True

        async def close(self) -> None:
            if self.fail_close:
                self.fail_close = False
                raise RuntimeError("Close failed once")
            await super().close()

    class RetryCloseProvider(WebsiteProvider):
        async def create(self, start_url: str, on_event: Any, **options: Any) -> RetryCloseSession:
            session = RetryCloseSession(on_event)
            session.signed_in = True
            self.sessions.append(session)
            return session

    provider = RetryCloseProvider()
    service = RecordingService(provider)
    owner = RecordingOwner("staging", "owner@example.com")
    try:
        recording = await service.create(
            owner, WEBSITE["origin"], website_session=RecordingWebsiteSession(**WEBSITE)
        )
        if action == "expiry":
            recording.expires_at = datetime.now(UTC) - timedelta(seconds=1)
            await service.cleanup()
        else:
            with pytest.raises(RuntimeError, match="Close failed once"):
                await getattr(service, action)(recording.id, owner)
        assert provider.sessions[0].closed is False
        if action != "stop":
            assert recording.website_session is None
            assert recording.website_session_payload is None
        assert await service.claim_google_context(recording.id, owner) == ""
        assert provider.sessions[0].closed is True
        assert provider.sessions[0].deleted is True
        assert await service.adopt_google_context(recording.id, owner) is False
        assert await service.return_google_context(recording.id, owner) is False
        if action == "delete":
            assert await service.delete(recording.id, owner) is True
            assert await service.get(recording.id, owner) is None
    finally:
        await service.close()


async def test_capture_diagnostics_contain_only_counts_and_cookie_domains(caplog: pytest.LogCaptureFixture) -> None:
    import logging
    from types import SimpleNamespace

    from workflow_use_recording.provider import PlaywrightRecordingSession

    class DiagnosticContext(StorageContext):
        async def storage_state(self) -> dict[str, Any]:
            state = await super().storage_state()
            state["cookies"].append(
                {
                    "name": "private-cookie-name",
                    "value": "private-cookie-value",
                    "domain": "evil.example/?query-secret#fragment-secret",
                    "path": "/",
                    "expires": -1,
                }
            )
            state["origins"].append(
                {
                    "origin": "https://evil.example/?query-secret#fragment-secret",
                    "localStorage": [{"name": "private-storage-name", "value": WEBSITE["grant"]}],
                }
            )
            return state

    page = IdentityPage(["Google Account: person@example.com"])
    session = PlaywrightRecordingSession(
        browser=SimpleNamespace(contexts=[DiagnosticContext(page)]), runtime=None, live_view_url=None
    )
    with caplog.at_level(logging.WARNING, logger="workflow_use_recording.provider"):
        email, state = await session.capture_website_session(WEBSITE["origin"])
    assert email == "person@example.com"
    assert state["cookies"] == STATE["cookies"]
    messages = [record.getMessage() for record in caplog.records if record.name == "workflow_use_recording.provider"]
    assert messages == [
        "recording_website_capture raw_cookie_count=10 retained_cookie_count=1 "
        "dropped_cookie_domains=['.example.com', '.google.com', 'api.example.com', 'app.example.com'] "
        "raw_local_storage_origin_count=5 retained_local_storage_origin_count=1"
    ]
    for secret in (
        WEBSITE["grant"],
        "site-secret",
        "google-secret",
        "site-token",
        "sibling-secret",
        "http-secret",
        "private-cookie-name",
        "private-cookie-value",
        "private-storage-name",
        "query-secret",
        "fragment-secret",
        "person@example.com",
    ):
        assert secret not in caplog.text


async def test_handoff_is_cleared_after_retry_window() -> None:
    from datetime import UTC, datetime, timedelta

    from workflow_use_recording.models import RecordingWebsiteSession
    from workflow_use_recording.service import RecordingOwner, RecordingService

    service = RecordingService(WebsiteProvider())
    owner = RecordingOwner("staging", "owner@example.com")
    recording = await service.create(
        owner, "https://app.example.com", website_session=RecordingWebsiteSession(**WEBSITE)
    )
    stopped = await service.stop(recording.id, owner)
    assert stopped.website_session_payload == {**WEBSITE, "googleEmail": "person@example.com", "state": STATE}
    stopped.stopped_at = datetime.now(UTC) - timedelta(minutes=61)
    expired_handoff = await service.get(recording.id, owner)
    assert expired_handoff.website_session_payload is None
    assert expired_handoff.website_session is None
    await service.close()


async def test_cancelled_capture_closes_recording_without_handoff() -> None:
    import asyncio

    from workflow_use_recording.models import RecordingWebsiteSession
    from workflow_use_recording.service import RecordingOwner, RecordingService

    class CancelledSession(WebsiteSession):
        async def capture_website_session(self, origin: str) -> tuple[str | None, dict[str, Any]]:
            raise asyncio.CancelledError

    class CancelledProvider(WebsiteProvider):
        async def create(self, start_url: str, on_event: Any, **options: Any) -> CancelledSession:
            return CancelledSession(on_event)

    service = RecordingService(CancelledProvider())
    owner = RecordingOwner("staging", "owner@example.com")
    recording = await service.create(
        owner, "https://app.example.com", website_session=RecordingWebsiteSession(**WEBSITE)
    )
    with pytest.raises(asyncio.CancelledError):
        await service.stop(recording.id, owner)
    stopped = await service.stop(recording.id, owner)
    assert stopped.status == "stopped"
    assert stopped.website_session_status == "unavailable"
    assert stopped.website_session_payload is None
    assert await service.claim_google_context(recording.id, owner) == ""
    await service.close()


async def test_delete_discards_website_grant_without_capturing() -> None:
    from workflow_use_recording.models import RecordingWebsiteSession
    from workflow_use_recording.service import RecordingOwner, RecordingService

    service = RecordingService(WebsiteProvider())
    owner = RecordingOwner("staging", "owner@example.com")
    recording = await service.create(
        owner, "https://app.example.com", website_session=RecordingWebsiteSession(**WEBSITE)
    )
    assert await service.delete(recording.id, owner) is True
    assert recording.website_session_status is None
    assert recording.website_session_payload is None
    assert recording.website_session is None
    assert await service.get(recording.id, owner) is None
    await service.close()


@pytest.mark.parametrize(
    "origin",
    [
        " https://app.example.com",
        "https://app.example.com\n",
        "https://app.example.com:",
        "https://app.ex ample.com",
        "https://app.example.com\\evil",
        "https://app.%65xample.com",
        "https://@app.example.com",
    ],
    ids=["leading_space", "newline", "empty_port", "host_space", "backslash", "encoded_host", "empty_userinfo"],
)
def test_malformed_website_origin_is_rejected(origin: str) -> None:
    with client(WebsiteProvider()) as http:
        response = start(http, website_session={**WEBSITE, "origin": origin})
        assert response.status_code == 422
        assert "opaque-fire-grant" not in response.text


async def test_cancelled_close_discards_captured_handoff_before_retry() -> None:
    import asyncio

    from workflow_use_recording.models import RecordingWebsiteSession
    from workflow_use_recording.service import RecordingOwner, RecordingService

    class CancelledCloseSession(WebsiteSession):
        closing_cancelled = False

        async def close(self) -> None:
            if not self.closing_cancelled:
                self.closing_cancelled = True
                raise asyncio.CancelledError
            await super().close()

    class CancelledCloseProvider(WebsiteProvider):
        async def create(self, start_url: str, on_event: Any, **options: Any) -> CancelledCloseSession:
            return CancelledCloseSession(on_event)

    service = RecordingService(CancelledCloseProvider())
    owner = RecordingOwner("staging", "owner@example.com")
    recording = await service.create(
        owner, "https://app.example.com", website_session=RecordingWebsiteSession(**WEBSITE)
    )
    with pytest.raises(asyncio.CancelledError):
        await service.stop(recording.id, owner)
    stopped = await service.stop(recording.id, owner)
    assert stopped.status == "stopped"
    assert stopped.website_session_payload is None
    assert stopped.website_session_status == "unavailable"
    await service.close()
