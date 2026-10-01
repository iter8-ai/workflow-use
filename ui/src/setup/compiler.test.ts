import assert from "node:assert/strict";
import test from "node:test";

import { compileAgent, doneWhenOptions, requiredCredentials, type SetupDraft } from "./compiler";

const baseDraft = (): SetupDraft => ({
  name: "Download monthly statement",
  url: "https://portal.example.test/reports",
  goal: "Download the monthly statement.",
  inputs: [],
  steps: [
    {
      id: "open-reports",
      type: "click",
      description: "Open the reports section",
      target: "Reports",
      expectedOutcome: "The reports list is visible",
    },
    {
      id: "download-statement",
      type: "click",
      description: "Download the statement",
      target: "Download statement",
      expectedOutcome: "A statement download is offered",
    },
  ],
});

test("compiles an intent-based computer-use stage with download collection", () => {
  const compiled = compileAgent(baseDraft());

  assert.deepEqual(compiled.options, { version: 1, engine: "computer" });
  assert.deepEqual(compiled.parameters, {});
  assert.deepEqual(compiled.stages.map((stage) => stage.type), ["agent", "download"]);
  assert.equal(compiled.stages[0]?.type, "agent");
  assert.equal(compiled.stages[0]?.step_limit, 64);
  assert.match(compiled.stages[0]?.prompt ?? "", /Click Reports to open the reports section\./);
});

test("compiles recorder steps with serialized null optional fields", () => {
  const draft: SetupDraft = {
    name: "Download verification CSV",
    url: "https://github.com/example/setup-check",
    goal: "Download the sample CSV.",
    inputs: [],
    steps: [{
      id: "navigate-1",
      type: "navigation",
      description: "https://github.com/example/setup-check",
      target: null,
      value: null,
      url: "https://github.com/example/setup-check",
      expectedOutcome: null,
    }],
  };

  assert.doesNotThrow(() => compileAgent(draft));
});

test("compiles typed text and chosen options as exact values", () => {
  const draft = baseDraft();
  draft.steps.push(
    { id: "search", type: "input", description: "Search for the statement", target: "Search", value: "bank statement export" },
    { id: "clear", type: "input", description: "Clear the filter", target: "Filter", value: "" },
    { id: "month", type: "select_change", description: "Choose the month", target: "Month", value: "September {2026}" },
  );

  const prompt = compileAgent(draft).stages[0]?.type === "agent" ? (compileAgent(draft).stages[0] as { prompt: string }).prompt : "";

  assert.match(prompt, /Search for the statement: replace any text in Search with exactly "bank statement export"\./);
  assert.match(prompt, /Clear the filter: clear Filter so it is empty\./);
  assert.match(prompt, /Choose the month: in Month, choose exactly "September \{\{2026\}\}"\./);
});

test("compiles a multi-select as separate options", () => {
  const draft = baseDraft();
  draft.steps.push({ id: "status", type: "select_change", description: "Choose statuses", target: "Status", value: JSON.stringify(["Paid, in full", "Overdue"]) });
  const prompt = (compileAgent(draft).stages[0] as { prompt: string }).prompt;
  assert.match(prompt, /in Status, select exactly these options and no others: "Paid, in full", "Overdue"\./);
});

test("requires an option for a choice step and rejects declared inputs", () => {
  const selectStep = baseDraft();
  selectStep.steps.push({ id: "select", type: "select_change", description: "Choose month", target: "Month" });
  assert.throws(() => compileAgent(selectStep), /which option to choose/);

  const declaredInput = baseDraft();
  declaredInput.inputs = [{ name: "month", label: "Month", type: "text", example: "September" }];
  assert.throws(() => compileAgent(declaredInput), /reusable inputs are not supported/i);
});

test("keeps typed text verbatim and rejects missing or secret-field values", () => {
  const multiline = baseDraft();
  multiline.steps.push({ id: "note", type: "input", description: "Fill in Notes", target: "Notes", value: "Line one\n  indented" });
  const prompt = (compileAgent(multiline).stages[0] as { prompt: string }).prompt;
  assert.ok(prompt.includes(JSON.stringify("Line one\n  indented")));

  const missing = baseDraft();
  missing.steps.push({ id: "note", type: "input", description: "Fill in Notes", target: "Notes", value: null });
  assert.throws(() => compileAgent(missing), /does not say what to type/);

  for (const target of ["PIN", "Passphrase", "Card number"]) {
    const secret = baseDraft();
    secret.steps.push({ id: "pin", type: "input", description: `Fill in ${target}`, target, value: "sunflower" });
    assert.throws(() => compileAgent(secret), /Mark it as a saved sign-in field/, target);
  }
});

test("rejects a credential typed into an ordinary field", () => {
  const draft = baseDraft();
  draft.steps.push({ id: "note", type: "input", description: "Fill in Notes", target: "Notes", value: "password: hunter2" });
  assert.throws(() => compileAgent(draft), /Remove sign-in details/);
});

test("rejects reusable input references", () => {
  const draft = baseDraft();
  draft.steps[0] = { ...draft.steps[0], inputName: "month" };

  assert.throws(() => compileAgent(draft), /reusable inputs are not supported/i);
});

test("rejects every query parameter and fragment", () => {
  for (const url of [
    "https://portal.example.test/reports?p=opaque-value",
    "https://portal.example.test/reports#latest",
  ]) {
    const draft = baseDraft();
    draft.url = url;
    assert.throws(() => compileAgent(draft), /must not include query parameters or a fragment/i);
  }
});

test("escapes braces in non-entry literals", () => {
  const draft = baseDraft();
  draft.steps[0] = { ...draft.steps[0], type: "key_press", value: "Report {draft}" };

  const compiled = compileAgent(draft);
  assert.equal(compiled.stages[0]?.type, "agent");
  assert.match(compiled.stages[0]?.prompt ?? "", /Report \{\{draft\}\}/);
});

test("rejects URL credentials, raw replay targets, and host limits", () => {
  const urlCredentials = baseDraft();
  urlCredentials.url = "https://user:password@example.test/public";

  const rawSelector = baseDraft();
  rawSelector.steps[0] = { ...rawSelector.steps[0], target: "#reports > button" };

  const tooLongName = baseDraft();
  tooLongName.name = "a".repeat(151);

  const tooManySteps = baseDraft();
  tooManySteps.steps = Array.from({ length: 201 }, (_, index) => ({
    id: `step-${index}`,
    type: "click" as const,
    description: "Open reports",
    target: "Reports",
  }));

  assert.throws(() => compileAgent(urlCredentials), /http\(s\).*credentials/i);
  assert.throws(() => compileAgent(rawSelector), /semantic target/i);
  assert.throws(() => compileAgent(tooLongName), /150 characters/i);
  assert.throws(() => compileAgent(tooManySteps), /200 demonstrated steps/i);
});

test("rejects direct and fallback navigation URLs with queries or fragments", () => {
  const direct = baseDraft();
  direct.steps[0] = { ...direct.steps[0], type: "navigation", url: "https://portal.example.test/reports?p=opaque-value" };

  const targetFallback = baseDraft();
  targetFallback.steps[0] = {
    ...targetFallback.steps[0],
    type: "navigation",
    target: "https://portal.example.test/reports#latest",
    url: null,
  };

  const descriptionFallback = baseDraft();
  descriptionFallback.steps[0] = {
    ...descriptionFallback.steps[0],
    type: "navigation",
    description: "https://portal.example.test/reports?p=opaque-value",
    target: null,
    url: null,
  };

  for (const draft of [direct, targetFallback, descriptionFallback]) {
    assert.throws(() => compileAgent(draft), /must not include query parameters or a fragment/i);
  }
});

test("compiles a demonstrated sign-in into placeholders without values", () => {
  const draft = baseDraft();
  draft.steps.unshift(
    { id: "user", type: "credential", description: "Enter the saved username in Email", target: "Email", value: "username" },
    { id: "pass", type: "credential", description: "Enter the saved password in Password", target: "Password", value: "password" },
    { id: "submit", type: "click", description: "Log in", target: "Sign in" },
    { id: "code", type: "credential", description: "Enter the saved otp in Code", target: "Code", value: "otp" },
  );

  const compiled = compileAgent(draft);
  const prompt = compiled.stages[0]?.type === "agent" ? compiled.stages[0].prompt : "";

  assert.deepEqual(requiredCredentials(draft.steps), ["username", "password", "otp"]);
  assert.deepEqual(compiled.parameters, {});
  assert.match(prompt, /Enter the saved username in Email: type exactly \$username into Email\./);
  assert.match(prompt, /type exactly \$password into Password\./);
  assert.match(prompt, /type exactly \$otp into Code\./);
  assert.match(prompt, /Click Sign in to log in\./);
});

test("rejects unknown credential kinds and masked values", () => {
  const unknown = baseDraft();
  unknown.steps[0] = { ...unknown.steps[0], type: "credential", value: "api_key" };
  assert.throws(() => compileAgent(unknown), /saved username, password, or one-time code/);

  const masked = baseDraft();
  masked.steps[0] = { ...masked.steps[0], type: "key_press", value: "••••••" };
  assert.throws(() => compileAgent(masked), /hidden value/);
});

test("rejects literal sign-in values in instructions but allows sign-in wording", () => {
  for (const goal of [
    "Log in with password example-secret-123",
    "Password: hunter2",
    "username is jane.doe@example.test",
    "Use API key sk_live_abc123",
    "one-time code 482913",
    "Log in with password correct-horse-battery-staple",
    "Enter verification code 482913",
    "Enter verification code sent to me: 482913",
    "Enter verification code sent to me 482913",
  ]) {
    const draft = baseDraft();
    draft.goal = goal;
    assert.throws(() => compileAgent(draft), /Remove sign-in details/, goal);
  }
  for (const goal of [
    "Log in, then download the monthly statement.",
    "Enter the password and open Reports.",
    "Type $password into the Password field.",
    "Download the token usage report.",
  ]) {
    const draft = baseDraft();
    draft.goal = goal;
    assert.doesNotThrow(() => compileAgent(draft), goal);
  }
});

test("rejects credential values in URL paths but allows sign-in paths", () => {
  for (const url of [
    "https://portal.example.test/token/abc123",
    "https://portal.example.test/api-key/sk_live%5Fabc",
    "https://portal.example.test/token/abc123/../reports",
    "https://portal.example.test/%2574oken/abc123",
    "https://portal.example.test\\token\\abc123\\..\\reports",
  ]) {
    const draft = baseDraft();
    draft.url = url;
    assert.throws(() => compileAgent(draft), /Remove sign-in details/, url);
  }
  for (const url of ["https://portal.example.test/login", "https://portal.example.test/reports/2024"]) {
    const draft = baseDraft();
    draft.url = url;
    assert.doesNotThrow(() => compileAgent(draft), url);
  }
});

test("requires no credentials for a public demonstration", () => {
  assert.deepEqual(requiredCredentials(baseDraft().steps), []);
});

test("compiles each done-when kind to the contracted stage list", () => {
  const draft = baseDraft();
  assert.deepEqual(compileAgent(draft).stages.map((stage) => stage.type), ["agent", "download"]);
  draft.doneWhen = { kind: "text", value: "Export sent" };
  assert.deepEqual(compileAgent(draft).stages.slice(1), [{ type: "expect_text", text: "Export sent" }]);
  draft.doneWhen = { kind: "email", address: "tenant+agent@reiterate.com", channelId: "channel-1" };
  assert.deepEqual(compileAgent(draft).stages.map((stage) => stage.type), ["agent"]);
  draft.doneWhen = { kind: "clicked", value: "Export payments" };
  assert.deepEqual(compileAgent(draft).stages.map((stage) => stage.type), ["agent"]);
});

test("offers the Reiterate email route first for an emailed export", () => {
  const steps = [
    { id: "email", type: "input" as const, description: "Enter Send export to", target: "Send export to", value: "jaan@example.com" },
    { id: "send", type: "click" as const, description: "Click Export payments", target: "Export payments" },
  ];
  const options = doneWhenOptions(steps, { confirmation: "Export sent to jaan@example.com", failureKind: "result", files: [] }, { kind: "file" });
  assert.equal(options[0]?.label, "Send the export to Reiterate instead");
  assert.equal(options[0]?.strength, "strong");
  assert.equal(options[0]?.recommended, true);
  assert.equal(options.at(-2)?.label, "A file is downloaded in the browser");
  assert.equal(options.at(-1)?.label, "Other text appears on the page");
});

test("offers email routing only when a later step sends the entered address", () => {
  const input = { id: "email", type: "input" as const, description: "Enter contact address", target: "Contact", value: "jaan@example.com" };
  const click = { id: "click", type: "click" as const, description: "Click Export payments", target: "Export payments" };
  assert.equal(doneWhenOptions([input], null, { kind: "file" }).some((option) => option.action === "email"), false);
  assert.equal(doneWhenOptions([click, input], null, { kind: "file" }).some((option) => option.action === "email"), false);
  assert.equal(doneWhenOptions([input, click], null, { kind: "file" }).some((option) => option.action === "email"), true);
});

test("suppresses email routing when multiple email inputs could be rewritten", () => {
  const steps = [
    { id: "billing", type: "input" as const, description: "Enter billing contact", target: "Billing email", value: "billing@example.com" },
    { id: "recipient", type: "input" as const, description: "Enter export recipient", target: "Send export to", value: "recipient@example.com" },
    { id: "send", type: "click" as const, description: "Send the export", target: "Send export" },
  ];
  assert.equal(doneWhenOptions(steps, null, { kind: "file" }).some((option) => option.action === "email"), false);
});

test("prefers a stable confirmation prefix and grades exact dynamic text lower", () => {
  const options = doneWhenOptions([], { confirmation: "Download started: payments-september.csv" }, { kind: "file" });
  assert.deepEqual(options.slice(0, 2).map((option) => [option.label, option.strength, option.recommended]), [
    ["“Download started” appears on the page", "strong", true],
    ["“Download started: payments-september.csv” appears on the page", "medium", false],
  ]);
});

test("rejects credentials in custom done-when text", () => {
  const draft = baseDraft();
  draft.doneWhen = { kind: "text", value: "Password: secret123" };
  assert.throws(() => compileAgent(draft), /Remove sign-in details/);
});
