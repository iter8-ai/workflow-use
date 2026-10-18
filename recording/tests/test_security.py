from __future__ import annotations

import pytest

from workflow_use_recording.security import has_google_session, is_google_sign_in, safe_public_url, url_origin


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("https://BÜCHER.example./login", "https://xn--bcher-kva.example."),
        ("https://BÜCHER.example:443/login", "https://xn--bcher-kva.example"),
        ("http://[2001:db8::1]:8080/login", "http://[2001:db8::1]:8080"),
    ],
    ids=["idna_with_trailing_dot", "idna_with_default_port", "ipv6_with_port"],
)
def test_url_origin_matches_browser_host_format(url: str, expected: str) -> None:
    assert url_origin(url) == expected


def test_safe_public_url_preserves_query_and_fragment() -> None:
    url = "https://example.com/report?month=2026-09#top"
    assert safe_public_url(url) == url


def test_safe_public_url_preserves_a_plain_public_path() -> None:
    assert safe_public_url("https://example.com/reports") == "https://example.com/reports"


@pytest.mark.parametrize(
    "url",
    ["https://user:pass@example.com/report?month=2026-09#top", "https://127.0.0.1/report?month=2026-09#top"],
)
def test_safe_public_url_rejects_credentials_and_private_hosts(url: str) -> None:
    assert safe_public_url(url) is None


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
