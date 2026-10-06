from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class FixedDateRule(BaseModel):
    kind: Literal["fixed"]


class TodayDateRule(BaseModel):
    kind: Literal["today"]


class YesterdayDateRule(BaseModel):
    kind: Literal["yesterday"]


class DaysAgoDateRule(BaseModel):
    kind: Literal["days_ago"]
    days: int = Field(ge=1, le=366)


class StartOfThisMonthDateRule(BaseModel):
    kind: Literal["start_of_this_month"]


class EndOfThisMonthDateRule(BaseModel):
    kind: Literal["end_of_this_month"]


class StartOfLastMonthDateRule(BaseModel):
    kind: Literal["start_of_last_month"]


class EndOfLastMonthDateRule(BaseModel):
    kind: Literal["end_of_last_month"]


class StartOfLastWeekDateRule(BaseModel):
    kind: Literal["start_of_last_week"]


class EndOfLastWeekDateRule(BaseModel):
    kind: Literal["end_of_last_week"]


class DescribedDateRule(BaseModel):
    kind: Literal["described"]
    text: str = Field(min_length=1, max_length=120)


DateRule = Annotated[
    FixedDateRule
    | TodayDateRule
    | YesterdayDateRule
    | DaysAgoDateRule
    | StartOfThisMonthDateRule
    | EndOfThisMonthDateRule
    | StartOfLastMonthDateRule
    | EndOfLastMonthDateRule
    | StartOfLastWeekDateRule
    | EndOfLastWeekDateRule
    | DescribedDateRule,
    Field(discriminator="kind"),
]


class StepDate(BaseModel):
    value: str
    format: str
    rule: DateRule | None = None


class SetupStep(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    type: Literal[
        "navigation",
        "click",
        "input",
        "credential",
        "select_change",
        "key_press",
        "scroll",
        "download",
        "agent",
        "date",
    ]
    description: str
    target: str | None = None
    value: str | None = None
    url: str | None = None
    expected_outcome: str | None = Field(default=None, serialization_alias="expectedOutcome")
    # Short purpose of the run of steps this one belongs to, e.g. "Sign in"; set after the demonstration.
    stage: str | None = None
    date: StepDate | None = None
    parts: list[SetupStep] | None = None


class RecordedDownload(BaseModel):
    """A file the demonstration browser downloaded. The live view shows no download bar, so the setup page does."""

    id: str
    name: str
    state: Literal["started", "completed", "failed"]


class CreateRecordingRequest(BaseModel):
    url: str


class RecordingGoogle(BaseModel):
    signed_in: bool = Field(serialization_alias="signedIn")


class RecordingResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    status: Literal["recording", "stopped", "expired"]
    live_view_url: str | None = Field(serialization_alias="liveViewUrl")
    steps: list[SetupStep]
    expires_at: datetime = Field(serialization_alias="expiresAt")
    blocked_reason: str | None = Field(serialization_alias="blockedReason")
    downloads: list[RecordedDownload] = Field(default_factory=list)
    # True while the finished steps are being grouped into stages and reworded; poll until it is false.
    organizing: bool = False
    google: RecordingGoogle | None = None


class CapturedCredentials(BaseModel):
    """Sign-in values typed during the demonstration. For the host to store encrypted; never shown to users."""

    username: str | None = None
    password: str | None = None


class StoppedRecordingResponse(RecordingResponse):
    # Present once, on the stop response only, when the demonstration captured sign-in values.
    credentials: CapturedCredentials | None = None
