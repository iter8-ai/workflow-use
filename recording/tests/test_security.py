from __future__ import annotations

import pytest

from workflow_use_recording.security import safe_public_url


@pytest.mark.parametrize("query", ["p=opaque-value", "token=synthetic-value", "session_id=safe-value"])
def test_safe_public_url_rejects_every_query_parameter_and_fragment(query: str) -> None:
    assert safe_public_url(f"https://example.com/reports?{query}#latest") is None


def test_safe_public_url_preserves_a_plain_public_path() -> None:
    assert safe_public_url("https://example.com/reports") == "https://example.com/reports"
