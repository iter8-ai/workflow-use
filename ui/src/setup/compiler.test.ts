import assert from "node:assert/strict";
import test from "node:test";

import { compileAgent, type SetupDraft } from "./compiler";

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

test("rejects every form-entry step and declared input", () => {
  const inputStep = baseDraft();
  inputStep.steps.push({ id: "input", type: "input", description: "Enter report month", target: "Month" });

  const selectStep = baseDraft();
  selectStep.steps.push({ id: "select", type: "select_change", description: "Choose month", target: "Month" });

  const declaredInput = baseDraft();
  declaredInput.inputs = [{ name: "month", label: "Month", type: "text", example: "September" }];

  for (const draft of [inputStep, selectStep, declaredInput]) {
    assert.throws(() => compileAgent(draft), /form-entry tasks are not supported/i);
  }
});

test("rejects reusable input references", () => {
  const draft = baseDraft();
  draft.steps[0] = { ...draft.steps[0], inputName: "month" };

  assert.throws(() => compileAgent(draft), /reusable inputs are not supported/i);
});

test("rejects credential intent in saved or prompt-bearing fields", () => {
  const mutations: Array<(draft: SetupDraft) => void> = [
    (draft) => { draft.name = "Login report"; },
    (draft) => { draft.goal = "Enter the one-time code"; },
    (draft) => { draft.url = "https://portal.example.test/login"; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], description: "Enter password" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], expectedOutcome: "OTP accepted" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], target: "Log in" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], type: "key_press", value: "API key" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], type: "navigation", url: "https://portal.example.test/login" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], type: "navigation", target: "https://portal.example.test/login", url: null }; },
  ];

  for (const mutate of mutations) {
    const draft = baseDraft();
    mutate(draft);
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
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
  urlCredentials.url = "https://person:secret@example.test/reports";

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

test("allows benign text and paths containing credential-like substrings", () => {
  const mutations: Array<(draft: SetupDraft) => void> = [
    (draft) => { draft.goal = "Assign invoices to the project."; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], description: "Open the product catalog index" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], expectedOutcome: "The design integration page is visible" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], target: "Download authors report" }; },
    (draft) => { draft.url = "https://portal.example.test/author/reports"; },
  ];

  for (const mutate of mutations) {
    const draft = baseDraft();
    mutate(draft);
    assert.doesNotThrow(() => compileAgent(draft));
  }
});

test("rejects standalone credential and sign-in intent", () => {
  const mutations: Array<(draft: SetupDraft) => void> = [
    (draft) => { draft.name = "Credential report"; },
    (draft) => { draft.goal = "Use the secret to download the report."; },
    (draft) => { draft.goal = "Complete MFA verification."; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], description: "Enter password" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], description: "Enter your PIN" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], expectedOutcome: "Token accepted" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], target: "Sign in" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], target: "Sign-in" }; },
    (draft) => { draft.url = "https://portal.example.test/login"; },
    (draft) => { draft.url = "https://portal.example.test/sign-in"; },
    (draft) => { draft.url = "https://portal.example.test/log-in"; },
  ];

  for (const mutate of mutations) {
    const draft = baseDraft();
    mutate(draft);
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});

test("rejects normalized and encoded credential intent", () => {
  const mutations: Array<(draft: SetupDraft) => void> = [
    (draft) => { draft.steps[0] = { ...draft.steps[0], target: "Sign‑in" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], target: "Log in" }; },
    (draft) => { draft.goal = "Authenticate before downloading the report."; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], expectedOutcome: "Authenticated" }; },
    (draft) => { draft.url = "https://portal.example.test/sign%2Din"; },
    (draft) => { draft.url = "https://portal.example.test/%6cogin"; },
    (draft) => { draft.url = "https://portal.example.test/%zz"; },
  ];

  for (const mutate of mutations) {
    const draft = baseDraft();
    mutate(draft);
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});

test("allows PIN as an ordinary verb but rejects credential PIN phrases", () => {
  const benign = baseDraft();
  benign.steps[0] = { ...benign.steps[0], description: "Pin the report to the dashboard" };
  assert.doesNotThrow(() => compileAgent(benign));

  for (const text of ["Enter PIN", "Provide your PIN", "PIN verification"]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});

test("rejects authorization variants and repeated encoded credential paths", () => {
  const mutations: Array<(draft: SetupDraft) => void> = [
    (draft) => { draft.goal = "Authorize access to the report."; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], expectedOutcome: "Authorized" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], description: "Log into the portal" }; },
    (draft) => { draft.steps[0] = { ...draft.steps[0], description: "Sign on to continue" }; },
    (draft) => { draft.url = "https://portal.example.test/%256cogin"; },
    (draft) => { draft.url = "https://portal.example.test/%25%36%63ogin"; },
  ];

  for (const mutate of mutations) {
    const draft = baseDraft();
    mutate(draft);
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});

test("rejects credential PIN values after compatible normalization", () => {
  for (const text of ["My PIN is 1234", "PIN: 1234", "Enter PİN"]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});
