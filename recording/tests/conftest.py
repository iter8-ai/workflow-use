from __future__ import annotations

import pytest

from workflow_use_recording import service


@pytest.fixture(autouse=True)
def public_hosts_resolve(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tests never resolve hostnames over the network; a test opts out to simulate an unresolvable host."""

    async def resolves(_url: str) -> bool:
        return True

    monkeypatch.setattr(service, "resolves_to_public_host", resolves, raising=False)
