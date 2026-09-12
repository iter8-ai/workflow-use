from __future__ import annotations

from workflow_use_recording.__main__ import runtime_settings


def test_runtime_defaults_to_loopback_and_one_worker(monkeypatch) -> None:
    monkeypatch.delenv("WORKFLOW_USE_HOST", raising=False)
    monkeypatch.delenv("WORKFLOW_USE_PORT", raising=False)

    assert runtime_settings() == ("127.0.0.1", 8090, 1)


def test_runtime_reads_explicit_bind_settings(monkeypatch) -> None:
    monkeypatch.setenv("WORKFLOW_USE_HOST", "0.0.0.0")
    monkeypatch.setenv("WORKFLOW_USE_PORT", "9000")

    assert runtime_settings() == ("0.0.0.0", 9000, 1)
