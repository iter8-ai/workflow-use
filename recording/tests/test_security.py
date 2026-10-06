from __future__ import annotations

import pytest

from workflow_use_recording.security import has_google_session, is_google_sign_in, safe_public_url


@pytest.mark.parametrize("query", ["p=opaque-value", "token=synthetic-value", "session_id=safe-value"])
def test_safe_public_url_rejects_every_query_parameter_and_fragment(query: str) -> None:
    assert safe_public_url(f"https://example.com/reports?{query}#latest") is None


def test_safe_public_url_preserves_a_plain_public_path() -> None:
    assert safe_public_url("https://example.com/reports") == "https://example.com/reports"


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://accounts.google.com/signin", True),
        ("https://ACCOUNTS.GOOGLE.EE./accounts/SetSID", True),
        ("https://accounts.google.co.uk/signin", True),
        ("https://accounts.youtube.com/signin", True),
        ("https://accounts.google.evil.com/signin", False),
        ("https://accounts.google.com.evil.test/signin", False),
    ],
)
def test_google_account_hosts(url: str, expected: bool) -> None:
    assert is_google_sign_in(url) is expected


@pytest.mark.parametrize(
    "change",
    [
        {"name": "HSID"},
        {"domain": ".accounts.google.com"},
        {"path": "/signin"},
        {"value": ""},
        {"expires": 0},
        {"expires": None},
        {"name": "__Secure-1PSID", "secure": False},
    ],
)
def test_google_cookie_requires_exact_sign_in_predicate(change: dict[str, object]) -> None:
    cookie = {"name": "SID", "domain": ".google.com", "path": "/", "value": "opaque", "expires": -1}
    cookie.update(change)
    assert not has_google_session([cookie])


def test_google_cookie_accepts_secure_session_cookie() -> None:
    assert has_google_session(
        [
            {
                "name": "__Secure-1PSID",
                "domain": "google.com",
                "path": "/",
                "value": "opaque",
                "expires": -1,
                "secure": True,
            }
        ]
    )
