from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Sequence
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_api import FakeProvider, create_recording, headers

from workflow_use_recording.api import RecordingConfig, create_app
from workflow_use_recording.models import SetupStep
from workflow_use_recording.organize import OrganizedDate, OrganizedStep, parse_organized, step_lines


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
async def test_get_returns_one_date_step_with_original_parts() -> None:
    provider = FakeProvider()
    organizer = StubOrganizer(
        [
            OrganizedStep("Set date", "Open the portal", (1,)),
            OrganizedStep(
                "Set date",
                "Enter the From date",
                (2, 3, 4),
                OrganizedDate("2026-09-06", "parts"),
            ),
        ]
    )
    with organized_client(provider, organizer) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        await session.emit({"type": "input", "target": "From day", "value": "06"})
        await session.emit({"type": "input", "target": "From month", "value": "09"})
        await session.emit({"type": "input", "target": "From year", "value": "2026"})
        http.post(f"/recordings/{recording['id']}/stop", headers=headers())
        body = settled(http, recording["id"])

    assert [step["type"] for step in body["steps"]] == ["navigation", "date"]
    assert body["steps"][1]["id"] == body["steps"][1]["parts"][0]["id"]
    assert body["steps"][1]["target"] == "From"
    assert body["steps"][1]["date"] == {"value": "2026-09-06", "format": "parts", "rule": None}
    assert [part["value"] for part in body["steps"][1]["parts"]] == ["06", "09", "2026"]


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


def _input_steps(*parts: tuple[str, str]) -> list[SetupStep]:
    return [
        SetupStep(id=str(index), type="input", target=target, value=value, description=f"Enter {target}")
        for index, (target, value) in enumerate(parts, 1)
    ]


def _organized_answer(
    numbers: int | list[int],
    description: str,
    *,
    date_value: str | None = None,
    date_format: str | None = None,
) -> str:
    item: dict[str, object] = {"n": numbers, "description": description}
    if date_value is not None or date_format is not None:
        item["date"] = {"value": date_value, "format": date_format}
    return json.dumps({"stages": [{"title": "Set date", "steps": [item]}]})


def test_parts_date_merge_uses_recorded_day_month_year_order() -> None:
    steps = _input_steps(("day", "06"), ("month", "09"), ("year", "2026"))
    organized = parse_organized(
        _organized_answer([1, 2, 3], "Enter the date", date_value="2026-09-06", date_format="parts"), steps
    )

    assert organized is not None
    assert organized[0].numbers == (1, 2, 3)
    assert organized[0].date == OrganizedDate("2026-09-06", "parts")


def test_parts_date_merge_keeps_following_steps_in_order() -> None:
    steps = _input_steps(("day", "06"), ("month", "09"), ("year", "2026"), ("notes", "1234"))
    answer = {
        "stages": [
            {
                "title": "Set date",
                "steps": [
                    {
                        "n": [1, 2, 3],
                        "description": "Enter the date",
                        "date": {"value": "2026-09-06", "format": "parts"},
                    },
                    {"n": 4, "description": "Enter the notes"},
                ],
            }
        ]
    }

    organized = parse_organized(json.dumps(answer), steps)

    assert organized is not None
    assert [item.numbers for item in organized] == [(1, 2, 3), (4,)]


def test_parts_date_merge_infers_month_day_year_from_targets() -> None:
    steps = _input_steps(("month", "09"), ("day", "06"), ("year", "2026"))
    organized = parse_organized(
        _organized_answer([1, 2, 3], "Enter the date", date_value="2026-09-06", date_format="parts"), steps
    )

    assert organized is not None and organized[0].date == OrganizedDate("2026-09-06", "parts")


def test_invalid_date_merge_falls_back_to_original_descriptions() -> None:
    steps = _input_steps(("day", "31"), ("month", "02"), ("year", "2026"))
    organized = parse_organized(
        _organized_answer([1, 2, 3], "Enter the date", date_value="2026-02-31", date_format="parts"), steps
    )

    assert organized is not None
    assert [item.numbers for item in organized] == [(1,), (2,), (3,)]
    assert [item.description for item in organized] == [step.description for step in steps]


def test_two_date_parts_cannot_invent_the_missing_year() -> None:
    steps = _input_steps(("day", "06"), ("month", "09"))
    organized = parse_organized(
        _organized_answer([1, 2], "Enter the date", date_value="2026-09-06", date_format="parts"), steps
    )

    assert organized is not None
    assert [item.numbers for item in organized] == [(1,), (2,)]
    assert [item.description for item in organized] == [step.description for step in steps]


def test_non_input_group_falls_back_to_separate_steps() -> None:
    steps = [
        SetupStep(id="1", type="input", target="day", value="06", description="Enter day"),
        SetupStep(id="2", type="click", target="Apply", description="Click Apply"),
        SetupStep(id="3", type="input", target="year", value="2026", description="Enter year"),
    ]
    answer = {
        "stages": [
            {
                "title": "Set date",
                "steps": [
                    {"n": [1, 2], "description": "Enter the date", "date": {"value": "2026-09-06", "format": "parts"}},
                    {"n": 3, "description": "Enter year"},
                ],
            }
        ]
    }
    organized = parse_organized(json.dumps(answer), steps)

    assert organized is not None
    assert [item.numbers for item in organized] == [(1,), (2,), (3,)]
    assert [item.description for item in organized] == ["Enter day", "Click Apply", "Enter year"]


def test_single_field_date_merge_requires_a_matching_fire_format() -> None:
    steps = _input_steps(("date", "06.09.2026"))
    organized = parse_organized(
        _organized_answer([1], "Enter the date", date_value="2026-09-06", date_format="%d.%m.%Y"), steps
    )

    assert organized is not None and organized[0].date == OrganizedDate("2026-09-06", "%d.%m.%Y")


def test_step_lines_exposes_only_date_like_input_values() -> None:
    steps = [
        SetupStep(id="1", type="input", target="day", value="06", description="Enter 06"),
        SetupStep(id="2", type="input", target="notes", value="private text", description="Enter private text"),
        SetupStep(id="3", type="input", target="notes", value="private 2026", description="Enter private 2026"),
        SetupStep(id="4", type="input", target="month", value="Sep 2026", description="Enter Sep 2026"),
        SetupStep(id="5", type="credential", target="Password", value="password", description="Enter saved password"),
    ]
    sent = step_lines(steps)

    assert '"value": "06"' in sent
    assert "private text" not in sent
    assert "private 2026" not in sent
    assert '"value": "Sep 2026"' in sent
    assert '"value": "password"' in sent


def test_legacy_single_number_output_still_parses() -> None:
    answer = '{"stages":[{"title":"Open","steps":[{"n":1,"description":"Open the portal"}]}]}'

    organized = parse_organized(answer, 1)

    assert organized is not None and organized[0].numbers == (1,)


def test_setup_step_serializes_date_and_parts() -> None:
    parts = _input_steps(("day", "06"), ("month", "09"), ("year", "2026"))
    step = SetupStep(
        id="1",
        type="date",
        description="Enter the date",
        date={"value": "2026-09-06", "format": "parts", "rule": None},
        parts=parts,
    )

    serialized = step.model_dump(mode="json")

    assert serialized["date"] == {"value": "2026-09-06", "format": "parts", "rule": None}
    assert serialized["parts"] == [part.model_dump(mode="json") for part in parts]


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
async def test_quick_repeat_clicks_on_one_control_become_one_step_with_a_count() -> None:
    provider = FakeProvider()
    with TestClient(create_app(provider, RecordingConfig(service_key="test-key", timeout_seconds=60))) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        await session.emit({"type": "click", "target": "Previous month"})
        await session.emit({"type": "click", "target": "Previous month", "repeat": True})
        await session.emit({"type": "click", "target": "Previous month", "repeat": True})
        await session.emit({"type": "click", "target": "Previous month"})
        body = http.get(f"/recordings/{recording['id']}", headers=headers()).json()

    assert [(step["description"], step.get("value")) for step in body["steps"][1:]] == [
        ("Click Previous month (3 times)", "3"),
        ("Click Previous month", None),
    ]


def test_typed_text_and_chosen_options_are_not_sent_to_the_organizer() -> None:
    steps = [
        SetupStep(id="1", type="input", target="Merchant ID", value="10023-private", description="Enter 10023-private"),
        SetupStep(id="2", type="select_change", target="Format", value="CSV", description="Choose CSV in Format"),
    ]
    sent = step_lines(steps)
    assert "10023-private" not in sent
    assert "CSV" not in sent
    assert "Merchant ID" in sent and "Format" in sent


@pytest.mark.asyncio
async def test_a_failed_download_is_reported_but_leaves_no_step() -> None:
    provider = FakeProvider()
    with TestClient(create_app(provider, RecordingConfig(service_key="test-key", timeout_seconds=60))) as http:
        recording = create_recording(http)
        session = provider.sessions[0]
        await session.emit({"type": "download", "downloadId": "d-1", "state": "started", "value": "report.csv"})
        await session.emit({"type": "download", "downloadId": "d-1", "state": "failed"})
        body = http.get(f"/recordings/{recording['id']}", headers=headers()).json()

    assert body["downloads"] == [{"id": "d-1", "name": "report.csv", "state": "failed"}]
    assert [step["type"] for step in body["steps"]] == ["navigation"]


@pytest.mark.asyncio
async def test_a_stalled_organizer_leaves_the_recorded_steps(monkeypatch: pytest.MonkeyPatch) -> None:
    import workflow_use_recording.service as recording_service

    monkeypatch.setattr(recording_service, "ORGANIZE_TIMEOUT_SECONDS", 0.05)

    class Stalled(StubOrganizer):
        async def organize(self, steps: Sequence[SetupStep]) -> list[OrganizedStep] | None:
            await asyncio.sleep(10)
            return None

    provider = FakeProvider()
    with organized_client(provider, Stalled()) as http:
        recording = create_recording(http)
        stopped = http.post(f"/recordings/{recording['id']}/stop", headers=headers()).json()
        body = settled(http, recording["id"])

    assert stopped["organizing"] is True
    assert body["organizing"] is False
    assert body["steps"] == stopped["steps"]
