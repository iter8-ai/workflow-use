from __future__ import annotations

import re
from datetime import datetime
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

from .security import url_origin

_COUNTRY_CODE = re.compile(r"[A-Za-z]{2}")


def country_code(value: str) -> str:
    """Return ``value`` as an upper-case ISO 3166-1 alpha-2 country code, or raise ``ValueError``."""
    if not isinstance(value, str) or _COUNTRY_CODE.fullmatch(value) is None:
        raise ValueError("country must be an ISO 3166-1 alpha-2 code such as EE.")
    return value.upper()


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


class RecordingLogin(BaseModel):
    """A saved sign-in the demonstration browser fills in for the person. Values never appear in a repr,
    a log, an event or a response, and the browser session drops them when the recording ends."""

    model_config = ConfigDict(hide_input_in_errors=True)

    # Pages and frames on exactly these origins (scheme://host[:port]) get their sign-in form filled.
    origins: list[Annotated[str, Field(max_length=2000)]] = Field(min_length=1, max_length=10)
    username: Annotated[SecretStr, Field(max_length=2000)] | None = None
    password: Annotated[SecretStr, Field(min_length=1, max_length=2000)]

    @field_validator("origins")
    @classmethod
    def _canonical_origins(cls, origins: list[str]) -> list[str]:
        canonical: list[str] = []
        for origin in origins:
            value = url_origin(origin)
            if value is None:
                raise ValueError("Each origin must be an HTTP(S) origin such as https://app.example.com.")
            parts = urlsplit(origin)
            if parts.path not in {"", "/"} or parts.query or parts.fragment:
                raise ValueError("Each origin must be an HTTP(S) origin such as https://app.example.com.")
            canonical.append(value)
        return canonical


class RecordingWebsiteSession(BaseModel):
    """Opaque FIRE grant, retained only for the server-to-server stop handoff."""

    model_config = ConfigDict(hide_input_in_errors=True)

    grant: SecretStr = Field(min_length=1, max_length=16000)
    origin: str = Field(max_length=2000)

    @field_validator("origin")
    @classmethod
    def _website_origin(cls, origin: str) -> str:
        from .security import is_google_origin, is_public_http_url

        canonical = url_origin(origin)
        parts = urlsplit(origin)
        if (
            canonical is None
            or origin != origin.strip()
            or any(ord(char) < 32 or ord(char) == 127 or char == "\\" for char in origin)
            or any(char in parts.netloc for char in (" ", "%"))
            or parts.netloc.endswith(":")
            or parts.username is not None
            or parts.password is not None
            or not is_public_http_url(origin)
            or parts.path not in {"", "/"}
            or parts.query
            or parts.fragment
            or is_google_origin(canonical)
        ):
            raise ValueError("A public non-Google HTTP(S) origin is required.")
        return canonical


class CreateRecordingRequest(BaseModel):
    url: str
    # Borrowed context, never deleted here; see recording/README.md for saved sign-in persistence.
    context_id: str | None = Field(default=None, min_length=1, max_length=200)
    login: RecordingLogin | None = None
    website_session: RecordingWebsiteSession | None = Field(default=None, repr=False)
    # Where the residential proxy exits when the site blocks the direct browser; ISO 3166-1 alpha-2.
    country: str | None = None

    @field_validator("country")
    @classmethod
    def _alpha_2(cls, value: str | None) -> str | None:
        return None if value is None else country_code(value)

    @model_validator(mode="after")
    def _exclusive_website_session(self) -> CreateRecordingRequest:
        if self.website_session is not None and (self.context_id is not None or self.login is not None):
            raise ValueError("website_session cannot be combined with context_id or login.")
        return self


class NavigateRecordingRequest(BaseModel):
    url: str


class RecordingGoogle(BaseModel):
    signed_in: bool = Field(serialization_alias="signedIn")


class RecordingResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    status: Literal["recording", "stopped", "expired"]
    live_view_url: str | None = Field(serialization_alias="liveViewUrl")
    live_view_switching: bool = Field(serialization_alias="liveViewSwitching")
    steps: list[SetupStep]
    expires_at: datetime = Field(serialization_alias="expiresAt")
    blocked_reason: str | None = Field(serialization_alias="blockedReason")
    downloads: list[RecordedDownload] = Field(default_factory=list)
    # True while the finished steps are being grouped into stages and reworded; poll until it is false.
    organizing: bool = False
    google: RecordingGoogle | None = None
    # True when the start page did not load; the person opens another page with the navigate endpoint.
    start_page_failed: bool = Field(default=False, serialization_alias="startPageFailed")
    # Block-state semantics are documented in recording/README.md under "Blocked start pages".
    start_page_blocked: bool = Field(default=False, serialization_alias="startPageBlocked")
    # The network the demonstration browser is on. "proxy" after a retry over a geolocated residential proxy;
    # the host saves it on the agent so its runs use the same network.
    network: Literal["direct", "proxy"] = "direct"
    proxy_country: str | None = Field(default=None, serialization_alias="proxyCountry")


class CapturedCredentials(BaseModel):
    """Sign-in values typed during the demonstration. For the host to store encrypted; never shown to users."""

    username: str | None = None
    password: str | None = None


class WebsiteSessionHandoff(BaseModel):
    grant: str = Field(repr=False)
    origin: str
    googleEmail: str = Field(repr=False)
    state: dict[str, Any] = Field(repr=False)


class StoppedRecordingResponse(RecordingResponse):
    website_session: WebsiteSessionHandoff | None = Field(
        default=None, serialization_alias="websiteSession", repr=False
    )
    website_session_status: Literal["captured", "unavailable", "rejected"] | None = Field(
        default=None, serialization_alias="websiteSessionStatus"
    )
    # Present once, on the stop response only, when the demonstration captured sign-in values.
    credentials: CapturedCredentials | None = None
