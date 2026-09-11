from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class SetupStep(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    type: Literal["navigation", "click", "input", "select_change", "key_press", "scroll", "agent"]
    description: str
    target: str | None = None
    value: str | None = None
    url: str | None = None
    expected_outcome: str | None = Field(default=None, serialization_alias="expectedOutcome")


class CreateRecordingRequest(BaseModel):
    url: str


class RecordingResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    status: Literal["recording", "stopped", "expired"]
    live_view_url: str | None = Field(serialization_alias="liveViewUrl")
    steps: list[SetupStep]
    expires_at: datetime = Field(serialization_alias="expiresAt")
    blocked_reason: str | None = Field(serialization_alias="blockedReason")
