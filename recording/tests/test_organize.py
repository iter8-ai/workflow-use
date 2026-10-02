from __future__ import annotations

import asyncio
import time
from collections.abc import Sequence
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_api import FakeProvider, create_recording, headers

from workflow_use_recording.api import RecordingConfig, create_app
from workflow_use_recording.models import SetupStep
from workflow_use_recording.organize import OrganizedStep, parse_organized, step_lines


class StubOrganizer:
    def __init__(self, result: list[OrganizedStep] | None = None, error: Exception | None = None) -> None:
        self.result = result
        self.error = error
        self.calls: list[list[SetupStep]] = []

    async def organize(self, steps: Sequence[SetupStep]) -> list[OrganizedStep] | None:
        self.calls.append(list(steps))
        if self.error is not None:
            raise self.error
        return self.result


def organized_client(provider: FakeProvider, organizer: StubOrganizer) -> TestClient:
    return TestClient(
        create_app(provider, RecordingConfig(service_key="test-key", timeout_seconds=60, max_sessions=4), organizer)
    )


def settled(http: TestClient, recording_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 5
    while True:
        body = http.get(f"/recordings/{recording_id}", headers=headers()).json()
        if not body["organizing"] or time.monotonic() > deadline:
            return body
        time.sleep(0.02)


@pytest.mark.asyncio
async def test_finished_demonstration_is_grouped_into_stages_with_clearer_steps() -> None:
    provider = FakeProvider()
    organizer = StubOrganizer(
        [
            OrganizedStep("Sign in", "Open the portal"),
            OrganizedStep("Sign in", "Click Log in"),
            OrganizedStep("Download the report", "Click Download"),
        ]
    )
    with organized_client(provider, organizer) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit({"type": "click", "target": "Log inUse single sign-on"})
        await provider.sessions[0].emit({"type": "click", "target": "Download"})
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers()).json()
        body = settled(http, recording["id"])

    assert stopped["organizing"] is True
    assert [step["description"] for step in stopped["steps"]] == [
        "Open example.com",
        "Click Log inUse single sign-on",
        "Click Download",
    ]
    assert body["organizing"] is False
    assert [(step["stage"], step["description"]) for step in body["steps"]] == [
        ("Sign in", "Open the portal"),
        ("Sign in", "Click Log in"),
        ("Download the report", "Click Download"),
    ]
    # Ids and the recorded facts the agent replays are unchanged.
    assert [step["id"] for step in body["steps"]] == [step["id"] for step in stopped["steps"]]
    assert body["steps"][1]["target"] == "Log inUse single sign-on"


@pytest.mark.asyncio
async def test_steps_stay_as_recorded_when_organizing_fails() -> None:
    provider = FakeProvider()
    with organized_client(provider, StubOrganizer(error=RuntimeError("model unavailable"))) as http:
        recording = create_recording(http)
        await provider.sessions[0].emit({"type": "click", "target": "Reports"})
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers()).json()
        body = settled(http, recording["id"])

    assert body["organizing"] is False
    assert body["steps"] == stopped["steps"]
    assert all("stage" not in step for step in body["steps"])


@pytest.mark.asyncio
async def test_secrets_never_reach_the_organizer() -> None:
    provider = FakeProvider()
    organizer = StubOrganizer(None)
    with organized_client(provider, organizer) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        await session.emit({"type": "credential", "target": "Password", "targetKey": "p", "value": "password"})
        await session.emit({"type": "sign_in_value", "value": "password", "secret": "synthetic-password"})
        http.post(f"/recordings/{recording['id']}/stop", headers=headers())
        settled(http, recording["id"])

    sent = step_lines(organizer.calls[0])
    assert '"value": "password"' in sent
    assert "synthetic-password" not in sent


def test_an_answer_that_drops_or_reorders_steps_is_rejected() -> None:
    answer = '{"stages":[{"title":"Sign in","steps":[{"n":2,"description":"Click"},{"n":1,"description":"Open"}]}]}'
    assert parse_organized(answer, 2) is None
    assert parse_organized('{"stages":[{"title":"Sign in","steps":[{"n":1,"description":"Open"}]}]}', 2) is None


@pytest.mark.asyncio
async def test_downloads_become_steps_and_report_completion() -> None:
    provider = FakeProvider()
    with TestClient(create_app(provider, RecordingConfig(service_key="test-key", timeout_seconds=60))) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        await session.emit({"type": "click", "target": "Export"})
        await session.emit({"type": "download", "downloadId": "d-1", "state": "started", "value": "tx-2026-10-01.csv"})
        during = http.get(f"/recordings/{recording['id']}", headers=headers()).json()
        await session.emit({"type": "download", "downloadId": "d-1", "state": "completed"})
        await session.emit({"type": "download", "downloadId": "d-2", "state": "started", "value": "broken.pdf"})
        await session.emit({"type": "download", "downloadId": "d-2", "state": "failed"})
        after = http.get(f"/recordings/{recording['id']}", headers=headers()).json()

    assert during["downloads"] == [{"id": "d-1", "name": "tx-2026-10-01.csv", "state": "started"}]
    assert [(step["type"], step["description"]) for step in during["steps"][1:]] == [
        ("click", "Click Export"),
        ("download", "Download tx-2026-10-01.csv"),
    ]
    assert [(item["name"], item["state"]) for item in after["downloads"]] == [
        ("tx-2026-10-01.csv", "completed"),
        ("broken.pdf", "failed"),
    ]


@pytest.mark.asyncio
async def test_page_scripts_cannot_fake_a_download() -> None:
    from workflow_use_recording.capture import page_event

    assert page_event({"type": "download", "downloadId": "x", "state": "started", "value": "fake.csv"}) == {}


@pytest.mark.asyncio
async def test_a_double_click_is_one_step_but_a_later_click_on_the_same_control_is_another() -> None:
    provider = FakeProvider()
    with TestClient(create_app(provider, RecordingConfig(service_key="test-key", timeout_seconds=60))) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        await session.emit({"type": "click", "target": "Next page"})
        await session.emit({"type": "click", "target": "Next page"})
        await asyncio.sleep(1.1)
        await session.emit({"type": "click", "target": "Next page"})
        body = http.get(f"/recordings/{recording['id']}", headers=headers()).json()

    assert [step.get("target") for step in body["steps"][1:]] == ["Next page", "Next page"]
