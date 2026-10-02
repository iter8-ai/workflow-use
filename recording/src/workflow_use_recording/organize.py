"""Groups a finished demonstration into stages and rewrites its step descriptions with a language model."""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .models import SetupStep

logger = logging.getLogger(__name__)

MAX_STAGE_LENGTH = 60
MAX_DESCRIPTION_LENGTH = 200

INSTRUCTIONS = """\
You tidy up a recorded browser demonstration so a person can review it and an AI agent can repeat it.

Each input line is one recorded step, in order, as JSON: n (step number), type, and where present target (the \
control's label as captured), value, url and the recorder's draft description.

Return the same steps, in the same order, grouped into stages:
- A stage is a run of consecutive steps that serve one purpose, titled in 1 to 4 words, e.g. "Sign in", \
"Open transaction reports", "Set the date range", "Download the report". Use 1 to 6 stages; a short demonstration \
may be a single stage.
- Every step number appears exactly once, in the original order.

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
                            "required": ["n", "description"],
                            "properties": {"n": {"type": "integer"}, "description": {"type": "string"}},
                        },
                    },
                },
            },
        }
    },
}


@dataclass(frozen=True)
class OrganizedStep:
    stage: str
    description: str


class StepOrganizer(Protocol):
    async def organize(self, steps: Sequence[SetupStep]) -> list[OrganizedStep] | None: ...


def step_lines(steps: Sequence[SetupStep]) -> str:
    """One JSON line per step. Typed text and chosen options stay out: the rewrite only names the field, and the
    agent gets the exact value from the step itself. Credential steps carry their kind (username, password), never
    the secret, and a download its file name; a click's value is its click count."""
    lines = []
    for number, step in enumerate(steps, start=1):
        fields = {
            "n": number,
            "type": step.type,
            "target": step.target,
            "value": None if step.type in {"input", "select_change"} else step.value,
            "url": step.url,
            "description": _without_value(step),
        }
        lines.append(json.dumps({key: value for key, value in fields.items() if value is not None}, ensure_ascii=False))
    return "\n".join(lines)


def _without_value(step: SetupStep) -> str:
    if step.type in {"input", "select_change"} and step.value:
        return step.description.replace(step.value, "the value")
    return step.description


def parse_organized(text: str, count: int) -> list[OrganizedStep] | None:
    """Accept the model's answer only if it covers every step exactly once, in order."""
    try:
        stages = json.loads(text)["stages"]
        organized: list[OrganizedStep] = []
        for stage in stages:
            title = " ".join(str(stage["title"]).split())
            if not title or len(title) > MAX_STAGE_LENGTH or not stage["steps"]:
                return None
            for step in stage["steps"]:
                description = " ".join(str(step["description"]).split())
                if step["n"] != len(organized) + 1 or not description or len(description) > MAX_DESCRIPTION_LENGTH:
                    return None
                organized.append(OrganizedStep(stage=title, description=description))
    except (KeyError, TypeError, ValueError):
        return None
    return organized if len(organized) == count else None


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
        organized = parse_organized(response.output_text, len(steps))
        if organized is None:
            logger.warning("recording_organize_rejected")
        return organized
