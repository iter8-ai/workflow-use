"""Groups a finished demonstration into stages and rewrites its step descriptions with a language model."""

from __future__ import annotations

import json
import logging
import os
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, Protocol

from .models import SetupStep

logger = logging.getLogger(__name__)

MAX_STAGE_LENGTH = 60
MAX_DESCRIPTION_LENGTH = 200

FORMATS: tuple[str, ...] = (
    "%A, %B %o, %Y",
    "%A, %B %-d, %Y",
    "%a, %b %-d, %Y",
    "%A %-d %B %Y",
    "%B %o, %Y",
    "%B %-d, %Y",
    "%b %-d, %Y",
    "%-d %B %Y",
    "%-d %b %Y",
    "%Y-%m-%d",
    "%d.%m.%Y",
    "%d/%m/%Y",
    "%m/%d/%Y",
    "%d-%m-%Y",
    "%m-%d-%Y",
    "%Y/%m/%d",
    "%-d.%-m.%Y",
    "%-d/%-m/%Y",
    "%-m/%-d/%Y",
    "%B %Y",
    "%b %Y",
)


def _ordinal(day: int) -> str:
    suffix = "th" if 11 <= day % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(day % 10, "th")
    return f"{day}{suffix}"


def render(value: date, fmt: str) -> str:
    """Render a FIRE date format without relying on platform-specific %-d support."""
    return value.strftime(
        fmt.replace("%o", _ordinal(value.day)).replace("%-d", str(value.day)).replace("%-m", str(value.month))
    )


_DATE_TOKEN_PATTERNS = {
    "%A": r"(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)",
    "%a": r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)",
    "%B": r"(?:January|February|March|April|May|June|July|August|September|October|November|December)",
    "%b": r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)",
    "%Y": r"\d{4}",
    "%d": r"(?:0[1-9]|[12]\d|3[01])",
    "%-d": r"(?:0?[1-9]|[12]\d|3[01])",
    "%m": r"(?:0[1-9]|1[0-2])",
    "%-m": r"(?:0?[1-9]|1[0-2])",
    "%o": r"(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)",
}


def _matches_format(value: str, fmt: str) -> bool:
    pattern = re.escape(fmt)
    for token in sorted(_DATE_TOKEN_PATTERNS, key=len, reverse=True):
        pattern = pattern.replace(re.escape(token), _DATE_TOKEN_PATTERNS[token])
    return re.fullmatch(pattern, value, flags=re.IGNORECASE) is not None


def _date_like_input(value: str | None) -> bool:
    return bool(value and (re.fullmatch(r"\d{1,4}", value) or any(_matches_format(value, fmt) for fmt in FORMATS)))


INSTRUCTIONS = """\
You tidy up a recorded browser demonstration so a person can review it and an AI agent can repeat it.

Each input line is one recorded step, in order, as JSON: n (step number), type, and where present target (the \
control's label as captured), value, url and the recorder's draft description.

Return the same steps, in the same order, grouped into stages:
- A stage is a run of consecutive steps that serve one purpose, titled in 1 to 4 words, e.g. "Sign in", \
"Open transaction reports", "Set the date range", "Download the report". Use 1 to 6 stages; a short demonstration \
may be a single stage.
- Every step number appears exactly once, in the original order.

Date fields are the only input values you may use. The input lines include a value only when an input contains
1 to 4 digits or text matching one of FIRE's allowed date formats. Never infer a date from a credential, select,
or free-text value. You may merge 2 or 3 consecutive input steps that together enter one calendar date. Return
`n` as the list of their step numbers and add `date: {"value": "YYYY-MM-DD", "format": "parts"}`. The recorded
day/month/year box order is the order of those input steps. For one date text box, return `n` as a one-item list
and the matching FIRE strftime format. Use `date: null` for every non-date step. Do not guess a date that the typed
values do not spell out.

Rewrite each description as one short imperative instruction (at most 12 words) that names the visible control, \
e.g. "Click Reports in the menu", "Open the transaction reports page".
- Click steps start with "Click" followed by the control's name. If the captured target is garbled (words run \
together, or several labels joined), infer the most likely control from the surrounding steps and keep it short.
- A navigation step that follows a click is the page that click opened: describe it as "Open the <page> page".
- Input and select steps name the field only, e.g. "Enter the merchant ID", "Choose the report format". The typed \
text or chosen option is not sent to you and is kept with the step.
- A click whose value is a number was clicked that many times in a row; say so, e.g. "Click Previous month 3 times".
- Credential steps name the saved value and the field, e.g. "Enter the saved password". Never write a password, \
code or other secret.
- A download step means the browser downloaded the named file: write "Download the <kind of file>" without the exact \
file name, because the name usually changes between runs.
- Do not invent controls, values or pages that the steps do not mention.
"""

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["stages"],
    "properties": {
        "stages": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "steps"],
                "properties": {
                    "title": {"type": "string"},
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["n", "description", "date"],
                            "properties": {
                                "n": {
                                    "anyOf": [
                                        {"type": "integer"},
                                        {"type": "array", "minItems": 1, "maxItems": 3, "items": {"type": "integer"}},
                                    ]
                                },
                                "description": {"type": "string"},
                                "date": {
                                    "anyOf": [
                                        {"type": "null"},
                                        {
                                            "type": "object",
                                            "additionalProperties": False,
                                            "required": ["value", "format"],
                                            "properties": {
                                                "value": {"type": "string"},
                                                "format": {"type": "string"},
                                            },
                                        },
                                    ]
                                },
                            },
                        },
                    },
                },
            },
        }
    },
}


@dataclass(frozen=True)
class OrganizedDate:
    value: str
    format: str


@dataclass(frozen=True)
class OrganizedStep:
    stage: str
    description: str
    numbers: tuple[int, ...] = ()
    date: OrganizedDate | None = None


class StepOrganizer(Protocol):
    async def organize(self, steps: Sequence[SetupStep]) -> list[OrganizedStep] | None: ...


def step_lines(steps: Sequence[SetupStep]) -> str:
    """Return one JSON line per step, exposing only safe date-like input values.

    Input values are included only for 1-4 digit values or values matching FIRE's date formats. Credential values
    are always just their kind, and free text, select choices, and other secrets never reach the organizer.
    """
    lines = []
    for number, step in enumerate(steps, start=1):
        fields = {
            "n": number,
            "type": step.type,
            "target": step.target,
            "value": step.value
            if step.type == "input" and _date_like_input(step.value)
            else None
            if step.type in {"input", "select_change", "credential"}
            else step.value,
            "url": step.url,
            "description": _without_value(step),
        }
        lines.append(json.dumps({key: value for key, value in fields.items() if value is not None}, ensure_ascii=False))
    return "\n".join(lines)


def _without_value(step: SetupStep) -> str:
    if step.type in {"input", "select_change"} and step.value:
        return step.description.replace(step.value, "the value")
    return step.description


def parse_organized(text: str, steps_or_count: Sequence[SetupStep] | int) -> list[OrganizedStep] | None:
    """Validate organized output and downgrade invalid date suggestions to original steps.

    ``count`` remains accepted for callers that only need the legacy single-number parser. Date suggestions are
    validated only when the original steps are supplied.
    """
    source_steps = None if isinstance(steps_or_count, int) else list(steps_or_count)
    count = steps_or_count if isinstance(steps_or_count, int) else len(source_steps)
    try:
        payload = json.loads(text)
        stages = payload["stages"]
        if not isinstance(stages, list):
            return None
        organized: list[OrganizedStep] = []
        for stage in stages:
            if not isinstance(stage, dict) or not isinstance(stage.get("title"), str):
                return None
            title = " ".join(stage["title"].split())
            stage_steps = stage.get("steps")
            if not title or len(title) > MAX_STAGE_LENGTH or not isinstance(stage_steps, list) or not stage_steps:
                return None
            for item in stage_steps:
                if not isinstance(item, dict) or not isinstance(item.get("description"), str):
                    return None
                raw_numbers = item.get("n")
                if isinstance(raw_numbers, int) and not isinstance(raw_numbers, bool):
                    numbers = (raw_numbers,)
                elif (
                    isinstance(raw_numbers, list)
                    and 1 <= len(raw_numbers) <= 3
                    and all(isinstance(number, int) and not isinstance(number, bool) for number in raw_numbers)
                ):
                    numbers = tuple(raw_numbers)
                else:
                    return None
                expected = sum(len(existing.numbers) for existing in organized) + 1
                if numbers != tuple(range(expected, expected + len(numbers))):
                    return None
                description = " ".join(item["description"].split())
                if not description or len(description) > MAX_DESCRIPTION_LENGTH:
                    return None
                date_info = _parse_date_info(item.get("date"), numbers, source_steps)
                if (item.get("date") is not None or len(numbers) > 1) and date_info is None:
                    if source_steps is None:
                        return None
                    organized.extend(
                        OrganizedStep(title, source_steps[number - 1].description, (number,)) for number in numbers
                    )
                else:
                    organized.append(OrganizedStep(title, description, numbers, date_info))
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    return organized if sum(len(item.numbers) for item in organized) == count else None


_PART_WORDS = {
    "day": "d",
    "dd": "d",
    "päev": "d",
    "month": "m",
    "mm": "m",
    "kuu": "m",
    "year": "y",
    "yyyy": "y",
    "aasta": "y",
}
_PART_WORD = re.compile(r"(?<![\wäöõü])(" + "|".join(_PART_WORDS) + r")(?![\wäöõü])", re.I)
_DATE_FIELD_WORD = re.compile(r"(?<![\wäöõü])(date|from|to|kuupäev)(?![\wäöõü])", re.I)
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _part_order(steps: Sequence[SetupStep]) -> tuple[str, ...] | None:
    labels: list[str | None] = []
    for step in steps:
        words = {_PART_WORDS[match.group(1).lower()] for match in _PART_WORD.finditer(step.target or "")}
        if len(words) > 1:
            return None
        labels.append(next(iter(words), None))
    if any(label is not None for label in labels):
        if any(label is None for label in labels) or len(set(labels)) != len(labels):
            return None
        return tuple(label for label in labels if label is not None)
    return ("d", "m", "y")[: len(steps)]


def _parse_date_info(raw: Any, numbers: tuple[int, ...], steps: Sequence[SetupStep] | None) -> OrganizedDate | None:
    if (
        steps is None
        or not isinstance(raw, dict)
        or not isinstance(raw.get("value"), str)
        or not isinstance(raw.get("format"), str)
    ):
        return None
    if any(number < 1 or number > len(steps) for number in numbers):
        return None
    parts = [steps[number - 1] for number in numbers]
    if any(part.type != "input" for part in parts):
        return None
    try:
        value = date.fromisoformat(raw["value"])
    except (TypeError, ValueError):
        return None
    if not _ISO_DATE.fullmatch(raw["value"]):
        return None
    fmt = raw["format"]
    if fmt == "parts":
        if len(parts) != 3:
            return None
        order = _part_order(parts)
        if order is None:
            return None
        values: dict[str, int] = {}
        for component, part in zip(order, parts, strict=True):
            if not isinstance(part.value, str) or not re.fullmatch(r"\d{1,4}", part.value):
                return None
            values[component] = int(part.value)
        if any(
            values.get(component) != getattr(value, attribute)
            for component, attribute in (("d", "day"), ("m", "month"), ("y", "year"))
            if component in values
        ):
            return None
        return OrganizedDate(raw["value"], fmt)
    if len(parts) != 1 or fmt not in FORMATS or parts[0].value is None or render(value, fmt) != parts[0].value:
        return None
    if not any(token in fmt for token in ("%d", "%-d", "%o")):
        return None
    if not _DATE_FIELD_WORD.search(f"{parts[0].target or ''} {parts[0].description}"):
        return None
    return OrganizedDate(raw["value"], fmt)


class OpenAIStepOrganizer:
    def __init__(self, *, model: str | None = None, timeout_seconds: float = 40, client: Any | None = None) -> None:
        self.model = model or os.environ.get("WORKFLOW_USE_ORGANIZER_MODEL", "gpt-5.6-luna")
        self.timeout_seconds = timeout_seconds
        self._client = client

    def _openai(self) -> Any:
        if self._client is None:
            from openai import AsyncOpenAI

            self._client = AsyncOpenAI(max_retries=1)
        return self._client

    async def organize(self, steps: Sequence[SetupStep]) -> list[OrganizedStep] | None:
        response = await self._openai().responses.create(
            model=self.model,
            store=False,
            reasoning={"effort": "low"},
            instructions=INSTRUCTIONS,
            input=step_lines(steps),
            text={"format": {"type": "json_schema", "name": "organized_steps", "strict": True, "schema": SCHEMA}},
            timeout=self.timeout_seconds,
        )
        organized = parse_organized(response.output_text, steps)
        if organized is None:
            logger.warning("recording_organize_rejected")
        return organized
