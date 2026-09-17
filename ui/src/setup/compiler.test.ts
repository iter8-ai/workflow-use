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

test("compiles reviewed reusable and literal form values", () => {
  const draft = baseDraft();
  draft.inputs = [{ name: "month", label: "Statement month", type: "date", example: "2026-09-01" }];
  draft.steps.push({ id: "month", type: "input", description: "Enter the statement month", target: "Statement month", inputName: "month" });
  draft.steps.push({ id: "format", type: "select_change", description: "Choose the export format", target: "Export format", value: "Report {draft}" });

  const compiled = compileAgent(draft);
  assert.equal(compiled.stages[0]?.type, "agent");
  assert.match(compiled.stages[0]?.prompt ?? "", /Set Statement month to \{month\}/);
  assert.match(compiled.stages[0]?.prompt ?? "", /Set Export format to Report \{\{draft\}\}/);
  assert.deepEqual(compiled.parameters, {});
});

test("requires a deliberate form binding and semantic target", () => {
  const cases: Array<[(draft: SetupDraft) => void, RegExp]> = [
    [(draft) => { draft.steps.push({ id: "missing", type: "input", description: "Enter month", target: "Month" }); }, /literal value or one reusable input/i],
    [(draft) => { draft.steps.push({ id: "target", type: "input", description: "Enter month", value: "September" }); }, /semantic target/i],
    [(draft) => { draft.steps.push({ id: "both", type: "input", description: "Enter month", target: "Month", value: "September", inputName: "month" }); }, /literal value or one reusable input/i],
    [(draft) => { draft.steps[0] = { ...draft.steps[0], inputName: "month" }; }, /cannot bind a reusable input/i],
    [(draft) => { draft.steps.push({ id: "unknown", type: "select_change", description: "Choose month", target: "Month", inputName: "missing" }); }, /unknown input missing/i],
  ];

  for (const [mutate, expected] of cases) {
    const draft = baseDraft();
    draft.inputs = [{ name: "month", label: "Month", type: "text", example: "September" }];
    draft.steps.push({ id: "valid-input", type: "input", description: "Enter month", target: "Month", inputName: "month" });
    mutate(draft);
    assert.throws(() => compileAgent(draft), expected);
  }
});

test("validates reusable input declarations", () => {
  const cases: Array<[SetupDraft["inputs"], RegExp]> = [
    [[{ name: "report month", label: "Month", type: "text", example: "September" }], /name must start with a letter/i],
    [[{ name: "constructor", label: "Month", type: "text", example: "September" }], /name must start with a letter/i],
    [[{ name: `m${"o".repeat(64)}`, label: "Month", type: "text", example: "September" }], /at most 64/i],
    [[{ name: "month", label: "Month", type: "text", example: "September" }, { name: "month", label: "Other month", type: "text", example: "October" }], /name month is duplicated/i],
    [[{ name: "month", label: "", type: "text", example: "September" }], /input 1 label is required/i],
    [[{ name: "month", label: "Month", type: "choice", example: "September" }] as unknown as SetupDraft["inputs"], /type must be text, date, or number/i],
    [[{ name: "month", label: "Month", type: "text", example: "" }], /input 1 example is required/i],
    [[{ name: "month", label: "Month", type: "text", example: "[redacted]" }], /credentials must be managed by the host/i],
    [[{ name: "month", label: "Month", type: "date", example: "2026-02-30" }], /valid date/i],
    [[{ name: "month", label: "Month", type: "date", example: "2026-99-99" }], /valid date/i],
    [[{ name: "amount", label: "Amount", type: "number", example: "twelve" }], /finite number/i],
    [Array.from({ length: 51 }, (_, index) => ({ name: `input${index}`, label: `Input ${index}`, type: "text" as const, example: "value" })), /at most 50 reusable inputs/i],
  ];

  for (const [inputs, expected] of cases) {
    const draft = baseDraft();
    draft.inputs = inputs;
    draft.steps.push(...inputs.map((input, index) => ({ id: `input-${index}`, type: "input" as const, description: "Enter value", target: "Field", inputName: input.name })));
    assert.throws(() => compileAgent(draft), expected);
  }
});

test("rejects reusable inputs that no form step uses", () => {
  const draft = baseDraft();
  draft.inputs = [{ name: "month", label: "Month", type: "text", example: "September" }];

  assert.throws(() => compileAgent(draft), /input month.*not used/i);
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
  for (const text of ["My PIN is 1234", "PIN: 1234", "PIN: ABCD", "My PIN is abcd", "Enter PİN"]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});

test("rejects credential terms separated by Unicode format characters and punctuation", () => {
  for (const text of ["pass\u200Bword", "sign\u200Bin", "pass-word", "pass word"]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});

test("rejects normalized credential token and phrase variants", () => {
  const texts = [
    "Download saved passwords",
    "Use API tokens",
    "Review credentials",
    "Authenticate to continue",
    "Authorize access",
    "Logging in to the portal",
    "signing in to the portal",
    "password_reset",
    "resetPassword",
    "Complete MFA verification",
    "Complete M.F.A. verification",
    "Complete 2FA verification",
    "Complete 2-FA verification",
    "Enter the verification code",
    "Sign-in to continue",
    "pass\u200Bword",
  ];

  for (const text of texts) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i, text);
  }

  const oauth = baseDraft();
  oauth.url = "https://portal.example.test/oauth/callback";
  assert.throws(() => compileAgent(oauth), /credentials.*managed by the host/i);
});

test("rejects PIN credential values", () => {
  for (const text of [
    "PIN 1234",
    "PIN-1234",
    "PIN=1234",
    "PIN = 1234",
    "PIN ABCD",
    "Pin 1234",
    "Pin-1234",
    "Pin=1234",
    "Pin = 1234",
    "Pin ABCD",
    "pin 1234",
    "pin-1234",
    "pin=1234",
    "pin = 1234",
    "pin abcd",
    "pin ABCD",
    "pin AbCd",
  ]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});

test("allows a valid literal percent after path decoding", () => {
  const draft = baseDraft();
  draft.url = "https://portal.example.test/reports/100%25";
  assert.doesNotThrow(() => compileAgent(draft));
});

test("rejects grammatical authentication and sign-in variants", () => {
  for (const text of ["Authenticating with the bank", "Logged in to the portal", "Signed in to the portal", "Loginto the portal", "Signinto the portal", "Logon to the portal", "Signon to the portal", "Review previous logins", "Review previous signins"]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i, text);
  }
});

test("allows ordinary one-time work but rejects one-time credential phrases", () => {
  const benign = baseDraft();
  benign.steps[0] = { ...benign.steps[0], description: "Create a one time export" };
  assert.doesNotThrow(() => compileAgent(benign));

  for (const text of ["Enter the one-time password", "Enter the one-time passcode", "Enter the one-time code"]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i);
  }
});

test("allows benign PIN report phrases and an API-key hostname", () => {
  const label = baseDraft();
  label.steps[0] = { ...label.steps[0], description: "Open the PIN REPORT" };
  assert.doesNotThrow(() => compileAgent(label));

  const ordinaryAction = baseDraft();
  ordinaryAction.steps[0] = { ...ordinaryAction.steps[0], description: "Pin this report" };
  assert.doesNotThrow(() => compileAgent(ordinaryAction));

  const url = baseDraft();
  url.url = "https://api.key.example/public-report";
  assert.doesNotThrow(() => compileAgent(url));
});
