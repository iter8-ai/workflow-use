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
    "Pin 1234",
    "Pin-1234",
    "Pin=1234",
    "Pin = 1234",
    "pin 1234",
    "pin-1234",
    "pin=1234",
    "pin = 1234",
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

test("rejects compact credential names in text and URL paths", () => {
  for (const text of [
    "Enter apikey",
    "Enter apikeys",
    "Enter API keys",
    "Enter username",
    "Enter usernames",
    "Enter onetime code",
    "Enter onetime-code",
    "Enter onetimecode",
  ]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i, text);
  }

  for (const path of ["apikey", "api-keys", "username", "usernames", "onetime-code", "onetime%20code", "onetimecode"]) {
    const draft = baseDraft();
    draft.url = `https://portal.example.test/${path}`;
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i, path);
  }
});

test("rejects punctuation-separated credential intent in text and URL paths", () => {
  for (const text of [
    "Sign/in to continue",
    "Log\\in",
    "Enter user:name",
    "Enter api+key",
    "Enter pass/word",
    "Enter the one:time code 2468",
  ]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i, text);
  }

  for (const path of ["sign/in", "log%5Cin", "user%3Aname", "api%2Bkey", "pass/word", "one%3Atime%20code"]) {
    const draft = baseDraft();
    draft.url = `https://portal.example.test/${path}`;
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i, path);
  }
});

test("rejects raw credential URL segments before URL normalization", () => {
  for (const url of [
    "https://portal.example.test/password/2468/../../reports",
    "https://portal.example.test\\password\\2468\\..\\..\\reports",
  ]) {
    const draft = baseDraft();
    draft.url = url;
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i, url);
  }
});

test("allows PIN action phrases without allowing PIN values", () => {
  for (const text of [
    "Pin invoice to dashboard",
    "Pin dashboard",
    "Pin to dashboard",
    "pin invoice to dashboard",
    "pin dashboard",
    "pin to dashboard",
    "pin file",
    "pin task",
    "pin note",
    "pin abcd",
    "Pin report2024 to dashboard",
    "Pin invoice1234 to dashboard",
    "Pin 2024 report to dashboard",
    "PIN REPORT2024 TO DASHBOARD",
    "PIN 2024 REPORT TO DASHBOARD",
    "PIN TASK1 TO DASHBOARD",
    "Please pin report2024 to dashboard",
    "Then pin invoice1234 to dashboard",
    "Pin DOC1234 to dashboard",
    "Please pin FY24 to dashboard",
    "Pin report2024 onto dashboard",
    "Pin report2024 on dashboard",
    "PIN THIS REPORT",
    "PIN TASK",
    "PIN NOTE",
    "PIN FILE",
    "PIN ABCD",
    "Pin 2 reports to the dashboard",
    "Pin 3 files for review",
  ]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.doesNotThrow(() => compileAgent(draft), text);
  }

  for (const text of [
    "PIN 1234",
    "PIN A1B2",
    "PIN=abcdef",
    "Pin 1234",
    "Enter PIN ABCD",
    "Enter the PIN number 2468",
    "Enter personal identification number 2468",
    "Enter authenticator code 123456",
    "Enter my PIN",
    "Paste your PIN",
    "Fill in your PIN",
    "Enter a PIN of 1234",
    "Enter the account PIN",
    "PIN1234",
    "PIN ١٢٣٤",
    "PIN\u200B1234",
    "Enter verification codes 123456",
    "Enter recovery code DEMO1234",
    "Enter backup code DEMO1234",
    "Enter passphrase DEMO1234",
    "PIN 1234 accepted",
    "Pin 1234 accepted",
    "pin 1234 accepted",
    "PIN A1B2 temporary",
    "Pin A1B2 temporary",
    "PIN 1234 to continue",
    "PIN DEMO1234 to continue",
    "PIN ABCD1 to continue",
    "PIN a1b2",
    "the PIN is ABCD",
  ]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description: text };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i, text);
  }

  const pinGoal = baseDraft();
  pinGoal.goal = "Use PIN 1234 for access";
  assert.throws(() => compileAgent(pinGoal), /credentials.*managed by the host/i);

  const pinOutcome = baseDraft();
  pinOutcome.steps[0] = { ...pinOutcome.steps[0], expectedOutcome: "PIN 1234 accepted" };
  assert.throws(() => compileAgent(pinOutcome), /credentials.*managed by the host/i);
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

  const recordedHost = baseDraft();
  recordedHost.steps[0] = {
    ...recordedHost.steps[0],
    type: "navigation",
    description: "Open api.key.example",
    url: "https://api.key.example/reports",
  };
  assert.doesNotThrow(() => compileAgent(recordedHost));

  const unrelatedHostText = baseDraft();
  unrelatedHostText.steps[0] = { ...unrelatedHostText.steps[0], description: "Open api.key.example" };
  assert.throws(() => compileAgent(unrelatedHostText), /credentials.*managed by the host/i);

  const recordedCredentialPath = baseDraft();
  recordedCredentialPath.steps[0] = { ...recordedCredentialPath.steps[0], description: "Open api.key.example/password" };
  assert.throws(() => compileAgent(recordedCredentialPath), /credentials.*managed by the host/i);

  for (const description of ["Enter api.key", "Enter pass.word", "Enter user.name", "Enter one.time code 123456"]) {
    const draft = baseDraft();
    draft.steps[0] = { ...draft.steps[0], description };
    assert.throws(() => compileAgent(draft), /credentials.*managed by the host/i, description);
  }
});
