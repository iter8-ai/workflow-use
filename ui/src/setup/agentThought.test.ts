import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentThought } from "./agentThought";

// Shapes copied from production web-agent run histories (staging tenant).
test("parses the final task outcome the agent returns as JSON", () => {
  const thought = parseAgentThought('{"status":"completed","reason":"Searched for agent-related news, opened the matching article and repository, and downloaded the requirements file.","step":37,"confirmation":"Download started: requirements_txt.txt"}');
  assert.deepEqual(thought, {
    kind: "outcome",
    outcome: { status: "completed", reason: "Searched for agent-related news, opened the matching article and repository, and downloaded the requirements file.", step: 37, confirmation: "Download started: requirements_txt.txt" },
    reasoning: [],
  });
});

test("splits reasoning that precedes the outcome on the same screen", () => {
  const thought = parseAgentThought('**Confirming download status**\n\nI need to give the final status.\n{"status":"blocked","reason":"Login failed.","step":null,"confirmation":null}');
  assert.deepEqual(thought, {
    kind: "outcome",
    outcome: { status: "blocked", reason: "Login failed.", step: null, confirmation: null },
    reasoning: [{ title: "Confirming download status", body: "I need to give the final status." }],
  });
});

test("reads several reasoning summaries as separate notes", () => {
  assert.deepEqual(parseAgentThought("**Exploring filter application**\n\nNo entries found.\n**Evaluating selection process**\n\nFind resets the status."), {
    kind: "reasoning",
    reasoning: [{ title: "Exploring filter application", body: "No entries found." }, { title: "Evaluating selection process", body: "Find resets the status." }],
  });
});

test("names proposed computer actions and keeps safety checks", () => {
  assert.deepEqual(parseAgentThought("Proposed computer actions: click, keypress, teleport. Safety checks: Confirm the purchase."), { kind: "actions", actions: ["click", "keypress", "unknown"], safetyChecks: "Confirm the purchase." });
});

test("keeps unstructured text and ignores braces that are not an outcome", () => {
  assert.deepEqual(parseAgentThought("I looked for the {export} button."), { kind: "text", text: "I looked for the {export} button." });
  assert.deepEqual(parseAgentThought('{"status":"done","reason":"x"}'), { kind: "text", text: '{"status":"done","reason":"x"}' });
  assert.deepEqual(parseAgentThought("Replayed recorded workflow step."), { kind: "replay" });
  assert.deepEqual(parseAgentThought("  "), { kind: "empty" });
});
