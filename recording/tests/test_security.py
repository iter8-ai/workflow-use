from __future__ import annotations

import pytest

from workflow_use_recording.security import safe_public_url


@pytest.mark.parametrize(
    "name",
    [
        "access_token",
        "api-key",
        "authorization",
        "client_secret",
        "code",
        "credential",
        "id_token",
        "jwt",
        "otp",
        "password",
        "refresh_token",
        "secret",
        "session",
        "signature",
        "sig",
        "token",
    ],
)
def test_safe_public_url_strips_recorder_sensitive_query_parameters(name: str) -> None:
    assert safe_public_url(f"https://example.com/reports?{name}=synthetic-value&tab=home#latest") == (
        "https://example.com/reports"
    )


@pytest.mark.parametrize("name", ["api_version", "client_id", "codebook", "jwt_mode", "session_id", "tokenized"])
def test_safe_public_url_preserves_benign_similarly_named_query_parameters(name: str) -> None:
    assert safe_public_url(f"https://example.com/reports?{name}=safe-value#latest") == (
        f"https://example.com/reports?{name}=safe-value"
    )
