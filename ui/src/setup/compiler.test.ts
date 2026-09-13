import assert from "node:assert/strict";
import test from "node:test";

import {
  compileAgent,
  type SetupDraft,
} from "./compiler";

const baseDraft = (): SetupDraft => ({
  name: "Download monthly statement",
  url: "https://portal.example.test/reports",
  goal: "Download the selected month's statement.",
  inputs: [
    {
      name: "statement_month",
      label: "Statement month",
      type: "date",
      example: "2026-08-01",
    },
  ],
  steps: [
    {
      id: "open-reports",
      type: "click",
      description: "Open the reports section",
      target: "Reports",
      expectedOutcome: "The reports list is visible",
    },
    {
      id: "choose-month",
      type: "input",
      description: "Choose the statement month",
      target: "Statement month",
      value: "2026-08-01",
      inputName: "statement_month",
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

test("compiles an intent-based computer-use stage with explicit runtime inputs", () => {
  const compiled = compileAgent(baseDraft());

  assert.deepEqual(compiled.options, { version: 1, engine: "computer" });
  assert.equal(compiled.url, "https://portal.example.test/reports");
  assert.deepEqual(compiled.parameters, {});
  assert.equal(compiled.stages.length, 2);
  assert.equal(compiled.stages[0]?.type, "agent");
  assert.equal(compiled.stages[1]?.type, "download");
  assert.equal(compiled.stages[0]?.step_limit, 64);
  assert.match(compiled.prompt, /Download monthly statement/);
  assert.match(compiled.stages[0]?.prompt ?? "", /\{statement_month\}/);
  assert.match(compiled.stages[0]?.prompt ?? "", /Click Reports to open the reports section\./);
  assert.match(compiled.stages[0]?.prompt ?? "", /Set Statement month to \{statement_month\} to choose the statement month\./);
  assert.doesNotMatch(compiled.stages[0]?.prompt ?? "", /Set Statement month to 2026-08-01/);
  assert.match(
    compiled.stages[0]?.prompt ?? "",
    /After this step, check that: The reports list is visible\./,
  );
  assert.doesNotMatch(compiled.stages[0]?.prompt ?? "", /verified|completed successfully/i);
});

test("retains literal values and escapes their braces when no input was assigned", () => {
  const draft = baseDraft();
  draft.inputs = [];
  draft.steps = [
    {
      id: "search",
      type: "input",
      description: "Search for the saved report",
      target: "Search",
      value: "Monthly {draft}",
    },
  ];

  const compiled = compileAgent(draft);

  assert.equal(compiled.stages[0]?.type, "agent");
  assert.match(compiled.stages[0]?.prompt ?? "", /Monthly \{\{draft\}\}/);
  assert.doesNotMatch(compiled.stages[0]?.prompt ?? "", /Monthly \{draft\}/);
});

test("compiles recorder steps with serialized null optional fields", () => {
  const draft: SetupDraft = {
    name: "Download verification CSV",
    url: "https://github.com/example/setup-check",
    goal: "Download the sample CSV.",
    inputs: [],
    steps: [
      {
        id: "navigate-1",
        type: "navigation",
        description: "Open the verification page",
        target: null,
        value: null,
        url: "https://github.com/example/setup-check",
        expectedOutcome: null,
      },
      {
        id: "click-1",
        type: "click",
        description: "Download the sample CSV",
        target: "Download sample CSV",
        value: null,
        url: null,
        expectedOutcome: null,
      },
    ],
  };

  const compiled = compileAgent(draft);

  assert.deepEqual(compiled.stages.map((stage) => stage.type), ["agent", "download"]);
  assert.equal(compiled.stages[0]?.type, "agent");
  assert.match(compiled.stages[0]?.prompt ?? "", /Navigate to https:\/\/github\.com\/example\/setup-check/);
  assert.match(compiled.stages[0]?.prompt ?? "", /Click Download sample CSV to download the sample CSV\./);
});

test("requires declared inputs to be assigned by a demonstrated step", () => {
  const draft = baseDraft();
  draft.steps = draft.steps.filter((step) => step.inputName === undefined);

  assert.throws(() => compileAgent(draft), /statement_month.*referenced/i);
});

test("rejects undeclared and unsupported inputs", () => {
  const undeclared = baseDraft();
  undeclared.steps[1] = { ...undeclared.steps[1], inputName: "period" };

  const unsupported = baseDraft();
  unsupported.inputs[0] = {
    ...unsupported.inputs[0],
    type: "password" as "text",
  };

  assert.throws(() => compileAgent(undeclared), /period.*declared/i);
  assert.throws(() => compileAgent(unsupported), /unsupported input type/i);
});

test("allows reusable values only on demonstrated input or select steps", () => {
  const draft = baseDraft();
  draft.steps[0] = { ...draft.steps[0], inputName: "statement_month" };
  draft.steps[1] = { ...draft.steps[1], inputName: undefined };

  assert.throws(() => compileAgent(draft), /only be used on an input or select/i);
});

test("rejects credentials, secret-like targets, and masked password values", () => {
  const secretInput = baseDraft();
  secretInput.inputs[0] = {
    ...secretInput.inputs[0],
    name: "api_key",
  };
  secretInput.steps[1] = { ...secretInput.steps[1], inputName: "api_key" };

  const secretTarget = baseDraft();
  secretTarget.steps[1] = {
    ...secretTarget.steps[1],
    target: "Password",
  };

  const maskedValue = baseDraft();
  maskedValue.steps[1] = {
    ...maskedValue.steps[1],
    value: "••••••••",
  };

  const loginTarget = baseDraft();
  loginTarget.steps[0] = { ...loginTarget.steps[0], target: "Log in" };

  for (const draft of [secretInput, secretTarget, maskedValue, loginTarget]) {
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});

test("rejects unsafe input names, invalid setup URLs, and raw browser replay targets", () => {
  const unsafeName = baseDraft();
  unsafeName.inputs[0] = { ...unsafeName.inputs[0], name: "__proto__" };
  unsafeName.steps[1] = { ...unsafeName.steps[1], inputName: "__proto__" };

  const credentialUrl = baseDraft();
  credentialUrl.url = "https://person:secret@example.test/reports";

  const rawSelector = baseDraft();
  rawSelector.steps[0] = { ...rawSelector.steps[0], target: "#reports > button" };

  assert.throws(() => compileAgent(unsafeName), /safe lowercase/i);
  assert.throws(() => compileAgent(credentialUrl), /http\(s\).*credentials/i);
  assert.throws(() => compileAgent(rawSelector), /semantic target/i);
});

test("rejects every query parameter before compiling a host-save payload", () => {
  const queryNames = [
    "access_token",
    "api-key",
    "authorization",
    "client_secret",
    "code",
    "credential",
    "id_token",
    "jwt",
    "otp",
    "password",
    "refresh_token",
    "secret",
    "session",
    "signature",
    "sig",
    "token",
    "api_version",
    "client_id",
    "codebook",
    "jwt_mode",
    "p",
    "session_id",
    "tokenized",
  ];

  for (const name of queryNames) {
    const setupUrl = baseDraft();
    setupUrl.url = `https://portal.example.test/reports?${name}=synthetic-value`;

    const stepUrl = baseDraft();
    stepUrl.steps[0] = {
      ...stepUrl.steps[0],
      type: "navigation",
      url: `https://portal.example.test/reports?${name}=synthetic-value`,
    };

    assert.throws(() => compileAgent(setupUrl), /must not include query parameters or a fragment/i, name);
    assert.throws(() => compileAgent(stepUrl), /must not include query parameters or a fragment/i, name);
  }
});

test("rejects fragments before compiling a host-save payload", () => {
  const setupUrl = baseDraft();
  setupUrl.url = "https://portal.example.test/reports#latest";

  const stepUrl = baseDraft();
  stepUrl.steps[0] = {
    ...stepUrl.steps[0],
    type: "navigation",
    url: "https://portal.example.test/reports#latest",
  };

  assert.throws(() => compileAgent(setupUrl), /must not include query parameters or a fragment/i);
  assert.throws(() => compileAgent(stepUrl), /must not include query parameters or a fragment/i);
});

test("keeps setup payloads within host limits", () => {
  const tooLongName = baseDraft();
  tooLongName.name = "a".repeat(151);

  const tooLongInput = baseDraft();
  tooLongInput.inputs[0] = { ...tooLongInput.inputs[0], name: "a".repeat(65) };
  tooLongInput.steps[1] = { ...tooLongInput.steps[1], inputName: "a".repeat(65) };

  assert.throws(() => compileAgent(tooLongName), /150 characters/i);
  assert.throws(() => compileAgent(tooLongInput), /64 characters/i);
});
