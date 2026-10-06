import assert from "node:assert/strict";
import test from "node:test";

import { applyOrganizedSteps, authoredSetup, compileAgent, dateRuleChoices, dateRuleLabel, doneWhenOptions, draftChanges, findUnambiguousEmailStep, groupSteps, mergeDateSteps, openQuestions, reopenDraft, replaceStepsFrom, requiredCredentials, resolveDateRule, sameCompletion, type DoneWhen, type SetupDraft, type SetupStep } from "./compiler";

const baseDraft = (): SetupDraft => ({
  name: "Download monthly statement",
  url: "https://portal.example.test/reports",
  goal: "Download the monthly statement.",
  inputs: [],
  doneWhen: { kind: "file" },
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
    doneWhen: { kind: "file" },
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

test("email code clicks arm the listener immediately before request and resend", () => {
  const draft = baseDraft();
  draft.steps = [
    { id: "request", type: "click", description: "Send email code", target: "Send code", requestsEmailCode: true },
    { id: "resend", type: "click", description: "Resend email code", target: "Resend code", requestsEmailCode: true },
    { id: "code", type: "credential", description: "Enter code", target: "Code", value: "otp" },
  ];
  const prompt = (compileAgent(draft, "email").stages[0] as { prompt: string }).prompt;
  assert.equal((prompt.match(/\$otp_request/g) ?? []).length, 2);
  assert.match(prompt, /1\. .*type.*\$otp_request.*immediately.*left click.*same computer tool call.*Send code/is);
  assert.match(prompt, /2\. .*type.*\$otp_request.*immediately.*left click.*same computer tool call.*Resend code/is);
  assert.match(prompt, /3\. .*\$otp/);
});

test("email request instruction keeps the prompt a valid runtime template", () => {
  const draft = baseDraft();
  draft.steps = [
    { id: "request", type: "click", description: "Send email code", target: "Send code", requestsEmailCode: true },
    { id: "code", type: "credential", description: "Enter code", target: "Code", value: "otp" },
  ];
  const prompt = (compileAgent(draft, "email").stages[0] as { prompt: string }).prompt;
  // FIRE renders stage prompts with str.format semantics: a single brace opens a field. The
  // example tool actions must therefore use doubled braces, which render as literal braces.
  assert.deepEqual(templateFields(prompt), []);
  assert.match(prompt, /first \{\{type:"type",text:"\$otp_request"\}\}, then \{\{type:"click",button:"left",x:<live x>,y:<live y>\}\}/);
});

/** Field names a Python str.format template would require; `{{`/`}}` are literals. */
function templateFields(template: string): string[] {
  const fields: string[] = [];
  const re = /\{\{|\}\}|\{([^{}]*)\}/g;
  for (const match of template.matchAll(re)) {
    if (match[1] !== undefined) fields.push(match[1].split("|")[0] ?? match[1]);
  }
  return fields;
}

test("email source rejects unmarked otp, non-click markers, and repeated request clicks", () => {
  const draft = baseDraft();
  draft.steps = [{ id: "code", type: "credential", description: "Enter code", target: "Code", value: "otp" }];
  assert.throws(() => compileAgent(draft, "email"), /mark.*request.*email code/i);
  draft.steps.unshift({ id: "request", type: "input", description: "Enter email", target: "Email", value: "x@example.test", requestsEmailCode: true });
  assert.throws(() => compileAgent(draft, "email"), /only.*click/i);
  draft.steps[0] = { id: "request", type: "click", description: "Send code", value: "2", requestsEmailCode: true };
  assert.throws(() => compileAgent(draft, "email"), /one click/i);
  draft.steps[0] = { id: "request", type: "click", description: "Send code", requestsEmailCode: true };
  assert.doesNotThrow(() => compileAgent(draft, "email"));
  assert.doesNotThrow(() => compileAgent({ ...draft, steps: draft.steps.slice(1) }, "authenticator"));
  assert.doesNotMatch((compileAgent(draft, "authenticator").stages[0] as { prompt: string }).prompt, /\$otp_request/);
  draft.steps.push({ id: "second-code", type: "credential", description: "Enter another code", target: "Code", value: "otp" });
  assert.throws(() => compileAgent(draft, "email"), /mark.*request.*email code/i);
  draft.steps.splice(2, 0, { id: "resend", type: "click", description: "Resend code", requestsEmailCode: true });
  assert.doesNotThrow(() => compileAgent(draft, "email"));
});

test("email request marker is a reviewable edit and survives organization", () => {
  const live = baseDraft();
  const draft = { ...live, steps: live.steps.map((step, index) => index === 0 ? { ...step, requestsEmailCode: true } : step) };
  assert.deepEqual(draftChanges(draft, live), [{ key: "step:open-reports:email-code", label: "Step 1 requests or resends email code", from: "No", to: "Yes" }]);
  const organized = applyOrganizedSteps(draft.steps, live.steps, live.steps.map((step) => ({ ...step, description: `${step.description}.` })));
  assert.equal(organized[0]?.requestsEmailCode, true);
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
    { id: "send", type: "click" as const, description: "Send the export by email", target: "Export payments" },
  ];
  const options = doneWhenOptions(steps, { confirmation: "Export sent to jaan@example.com", failureKind: "result", files: [] }, { kind: "file" });
  assert.equal(options[0]?.label, "Send the export to Reiterate instead");
  assert.equal(options[0]?.strength, "strong");
  assert.equal(options[0]?.recommended, true);
  assert.equal(options.at(-2)?.label, "A file is downloaded in the browser");
  assert.equal(options.at(-1)?.label, "Describe what success looks like");
});

test("offers email routing only when a later step sends the entered address", () => {
  const input = { id: "email", type: "input" as const, description: "Enter export recipient", target: "Send export to", value: "jaan@example.com" };
  const click = { id: "click", type: "click" as const, description: "Send the export by email", target: "Send export" };
  assert.equal(doneWhenOptions([input], null, { kind: "file" }).some((option) => option.action === "email"), false);
  assert.equal(doneWhenOptions([click, input], null, { kind: "file" }).some((option) => option.action === "email"), false);
  assert.equal(doneWhenOptions([input, click], null, { kind: "file" }).some((option) => option.action === "email"), true);
});

test("does not rewrite an unrelated email or treat a CSV download as email delivery", () => {
  const download = { id: "download", type: "click" as const, description: "Download CSV", target: "Export CSV" };
  const send = { id: "send", type: "click" as const, description: "Send the export by email", target: "Send export" };
  for (const target of ["Billing email", "Login email", "Account email", "Contact email"]) {
    const input = { id: "address", type: "input" as const, description: `Enter ${target}`, target, value: "billing@example.test" };
    for (const action of [download, send]) {
      const steps = [input, action];
      assert.equal(findUnambiguousEmailStep(steps), null, target);
      assert.equal(doneWhenOptions(steps, null, { kind: "file" }).some((option) => option.action === "email"), false, target);
    }
  }
  const recipient = { id: "recipient", type: "input" as const, description: "Enter export recipient", target: "Send export to", value: "recipient@example.test" };
  for (const action of [download, { ...send, description: "Open email settings", target: "Email settings" }, { ...send, description: "Send billing update", target: "Send billing update" }]) {
    assert.equal(findUnambiguousEmailStep([recipient, action]), null);
  }
  assert.equal(findUnambiguousEmailStep([recipient, send]), 0);
  const emailDoneWhen = { kind: "email" as const, address: "tenant+agent@reiterate.com", channelId: "channel-1" };
  assert.equal(doneWhenOptions([recipient, send], null, emailDoneWhen)[0]?.doneWhen, emailDoneWhen);
  assert.deepEqual(compileAgent({ ...baseDraft(), steps: [recipient, send], doneWhen: emailDoneWhen }).stages.map((stage) => stage.type), ["agent"]);
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

test("reports editable draft changes against the live setup", () => {
  const live = baseDraft();
  const draft = { ...live, goal: "Download the latest monthly statement.", steps: [...live.steps, {
    id: "archive",
    type: "click" as const,
    description: "Open the archive",
    target: "Archive",
  }] };

  assert.deepEqual(draftChanges(draft, live), [
    { key: "goal", label: "Goal", from: live.goal, to: draft.goal },
    { key: "added:archive", label: "Step added", from: "", to: "Open the archive" },
  ]);
});

test("reports the changed step so it can be reverted independently", () => {
  const live = baseDraft();
  const draft = { ...live, steps: live.steps.map((step, index) => index === 0 ? { ...step, description: "Open the updated reports section" } : step) };

  assert.deepEqual(draftChanges(draft, live), [
    { key: "step:open-reports:description", label: "Step 1 instruction", from: "Open the reports section", to: "Open the updated reports section" },
  ]);
});

test("replaces demonstrated steps from the selected index", () => {
  const steps = baseDraft().steps;
  const replacement = [{ id: "new", type: "click" as const, description: "New action", target: "New" }];

  assert.deepEqual(replaceStepsFrom(steps, 1, replacement), [steps[0], replacement[0]]);
});

test("described success criteria stay in the agent prompt with the evidence contract", () => {
  const compiled = compileAgent({ ...baseDraft(), doneWhen: { kind: "described", value: "  Export {month} was emailed to me  " } });
  assert.deepEqual(compiled.stages.map((stage) => stage.type), ["agent"]);
  const stage = compiled.stages[0];
  assert.equal(stage?.type, "agent");
  const prompt = stage.prompt;
  assert.ok(prompt.includes("Success criterion (written by the user): Export {{month}} was emailed to me"));
  assert.ok(prompt.indexOf("Success criterion") > prompt.indexOf("Demonstrated intent"));
  assert.ok(prompt.includes('Return status completed only when this criterion is visibly met on the current screen, and put the on-screen evidence you relied on in confirmation (short, factual). If you finished the steps but the criterion is not met, return status failed with reason starting exactly "Success criterion not met: " followed by what you saw instead, and step null.'));
});

test("described criteria require 1 to 300 trimmed characters", () => {
  for (const value of ["", "   ", "x".repeat(301)]) {
    assert.throws(() => compileAgent({ ...baseDraft(), doneWhen: { kind: "described", value } }), /1 to 300 characters/);
  }
  assert.doesNotThrow(() => compileAgent({ ...baseDraft(), doneWhen: { kind: "described", value: ` ${"x".repeat(300)} ` } }));
});

test("described criteria reject disclosed credentials", () => {
  for (const value of ["Password: secret123", "verification code 482913"]) {
    assert.throws(() => compileAgent({ ...baseDraft(), doneWhen: { kind: "described", value } }), /Remove sign-in details/);
  }
});

test("offers described confirmation after exact text and replaces the custom text option", () => {
  const options = doneWhenOptions(baseDraft().steps, { confirmation: "Export sent" }, { kind: "file" });
  const exact = options.findIndex((option) => option.doneWhen?.kind === "text");
  assert.deepEqual(options[exact + 1], {
    label: "“Export sent” is shown (checked by the agent)", doneWhen: { kind: "described", value: "Export sent" }, strength: "medium", why: "The agent judges it in context, so small wording changes still pass.",
  });
  assert.deepEqual(options.at(-1), { label: "Describe what success looks like", strength: "medium", why: "Write it in your own words; the agent checks it on the screen at the end of each run.", action: "custom" });
  assert.ok(!options.some((option) => option.label === "Other text appears on the page"));
  assert.equal(new Set(options.map((option) => option.label)).size, options.length);
});


test("does not treat described confirmation evidence as verbatim page text", () => {
  const confirmation = "The green toast says Export sent";
  const options = doneWhenOptions(baseDraft().steps, { confirmation }, { kind: "described", value: "The export was emailed to me" });
  assert.equal(options.some((option) => option.doneWhen?.kind === "text"), false);
  assert.ok(options.some((option) => option.doneWhen?.kind === "described" && option.doneWhen.value === confirmation));
});

test("stages become headings in the agent prompt while step numbers stay global", () => {
  const draft = baseDraft();
  draft.steps = [
    { id: "a", type: "click", description: "Click Log in", target: "Log inUse single sign-on", stage: "Sign in" },
    { id: "b", type: "click", description: "Click Reports in the menu", target: "Reports", stage: "Open reports" },
    { id: "c", type: "click", description: "Click Download", target: "Download", stage: "Open reports" },
  ];
  const prompt = compileAgent(draft).stages[0]?.type === "agent" ? (compileAgent(draft).stages[0] as { prompt: string }).prompt : "";

  assert.match(prompt, /Sign in:\n1\. Click Log in\. Its recorded label was "Log inUse single sign-on"\.\nOpen reports:\n2\. Click Reports in the menu\.\n3\. Click Download\./);
});

test("a demonstrated download tells the agent not to download twice", () => {
  const draft = baseDraft();
  draft.steps = [
    { id: "a", type: "click", description: "Click Export", target: "Export" },
    { id: "d", type: "download", description: "Download the transactions CSV", value: "tx-2026-10-01.csv" },
  ];
  const prompt = (compileAgent(draft).stages[0] as { prompt: string }).prompt;

  assert.match(prompt, /2\. Download the transactions CSV: the previous action starts a file download\. Reiterate keeps the file; the screen does not show it, and a "Download started" message confirms it\. Do not start the download again\. In the demonstration the file was "tx-2026-10-01\.csv"; the name may differ\./);
  assert.equal(doneWhenOptions(draft.steps, null, { kind: "file" }).find((option) => option.doneWhen?.kind === "file")?.recommended, true);
});

test("consecutive steps with the same stage form one group; a step without a stage joins the one before", () => {
  const steps: SetupStep[] = [
    { id: "1", type: "click", description: "a", stage: "Sign in" },
    { id: "2", type: "click", description: "b" },
    { id: "3", type: "click", description: "c", stage: "Download" },
    { id: "4", type: "click", description: "d", stage: "Sign in" },
  ];
  assert.deepEqual(groupSteps(steps).map((group) => [group.stage, group.steps.map(({ index }) => index)]), [
    ["Sign in", [0, 1]],
    ["Download", [2]],
    ["Sign in", [3]],
  ]);
});

test("organized wording arrives without undoing a step the user already edited or removed", () => {
  const recorded: SetupStep[] = [
    { id: "1", type: "click", description: "Click Continue with GoogleorEmail" },
    { id: "2", type: "click", description: "Click Reports" },
    { id: "3", type: "click", description: "Click Download" },
  ];
  const organized: SetupStep[] = [
    { id: "1", type: "click", description: "Click Email login", stage: "Sign in" },
    { id: "2", type: "click", description: "Click Reports in the menu", stage: "Open reports" },
    { id: "3", type: "click", description: "Click Download", stage: "Open reports" },
  ];
  const current: SetupStep[] = [{ ...recorded[0]!, description: "Click Sign in with email" }, recorded[2]!];

  assert.deepEqual(applyOrganizedSteps(current, recorded, organized), [
    { id: "1", type: "click", description: "Click Sign in with email", stage: "Sign in" },
    { id: "3", type: "click", description: "Click Download", stage: "Open reports" },
  ]);
});

test("does not merge organizer date parts across an edited step", () => {
  const recorded = dateParts("To");
  const organized: SetupStep[] = [{
    id: recorded[0]!.id,
    type: "date",
    description: "Enter the To date",
    target: "To",
    date: { value: "2026-09-06", format: "parts", rule: null },
    parts: recorded,
  }];
  const current = [recorded[0]!, { id: "edited", type: "click" as const, description: "Click Apply" }, recorded[1]!, recorded[2]!];
  assert.deepEqual(applyOrganizedSteps(current, recorded, organized).map(({ id, type, description }) => ({ id, type, description })), [
    { id: "To-day", type: "input", description: "Enter the To date" },
    { id: "edited", type: "click", description: "Click Apply" },
    { id: "To-month", type: "input", description: "Enter the To month" },
    { id: "To-year", type: "input", description: "Enter the To year" },
  ]);
});

test("organizer date metadata wins when the UI already merged the same parts", () => {
  const recorded = dateParts("To");
  const current = mergeDateSteps(recorded);
  const organized: SetupStep[] = [{
    id: recorded[0]!.id,
    type: "date",
    description: "Enter the To date",
    target: "To",
    date: { value: "2026-09-06", format: "parts", rule: { kind: "today" } },
    parts: recorded,
  }];
  const merged = applyOrganizedSteps(current, recorded, organized)[0];
  assert.equal(merged?.date?.rule?.kind, "today");
  assert.equal(merged?.description, "Enter the To date");
  assert.equal(merged?.target, "To");
});

test("stage names are checked like instructions", () => {
  const draft = baseDraft();
  draft.steps[0] = { ...draft.steps[0]!, stage: "password: hunter22" };
  assert.throws(() => compileAgent(draft), /Remove sign-in details/);
  draft.steps[0] = { ...draft.steps[0]!, stage: "x".repeat(61) };
  assert.throws(() => compileAgent(draft), /Stage name/);
});

test("repeated clicks on one control compile to a click count the agent repeats", () => {
  const draft = baseDraft();
  draft.steps = [{ id: "a", type: "click", description: "Click Previous month (3 times)", target: "Previous month", value: "3" }];
  const prompt = (compileAgent(draft).stages[0] as { prompt: string }).prompt;
  assert.match(prompt, /1\. Click Previous month \(3 times\)\./);
  draft.steps = [{ id: "a", type: "click", description: "Go back to the earlier month", target: "Previous month", value: "3" }];
  assert.match((compileAgent(draft).stages[0] as { prompt: string }).prompt, /Click Previous month to go back to the earlier month\. Click it 3 times in a row\./);
});

test("steps added after organizing get a neutral heading instead of joining the stage before them", () => {
  const draft = baseDraft();
  draft.steps = [
    { id: "a", type: "click", description: "Click Log in", target: "Log in", stage: "Sign in" },
    { id: "b", type: "click", description: "Click Export", target: "Export", stage: "" },
  ];
  assert.match((compileAgent(draft).stages[0] as { prompt: string }).prompt, /Sign in:\n1\. Click Log in\.\nThen:\n2\. Click Export\./);
});

const dateParts = (field = "From"): SetupStep[] => [
  { id: `${field}-day`, type: "input", description: `Enter the ${field} day`, target: "day", value: "06" },
  { id: `${field}-month`, type: "input", description: `Enter the ${field} month`, target: "month", value: "09" },
  { id: `${field}-year`, type: "input", description: `Enter the ${field} year`, target: "year", value: "2026" },
];

test("merges day/month/year inputs, including month/day/year labels, without merging numbers", () => {
  const merged = mergeDateSteps(dateParts());
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.date, { value: "2026-09-06", format: "parts", rule: null });
  assert.equal(merged[0]?.description, "Enter the From date");
  const preserved = mergeDateSteps(dateParts("To").map((step) => ({ ...step, stage: "Reports", expectedOutcome: "The date is accepted", url: "https://portal.example.test/reports" })));
  assert.equal(preserved[0]?.stage, "Reports");
  assert.equal(preserved[0]?.expectedOutcome, "The date is accepted");
  assert.equal(preserved[0]?.url, "https://portal.example.test/reports");
  assert.equal(mergeDateSteps(merged)[0]?.id, merged[0]?.id);
  const usParts: SetupStep[] = [
    { id: "month", type: "input", description: "Enter From month", target: "month", value: "09" },
    { id: "day", type: "input", description: "Enter From day", target: "day", value: "06" },
    { id: "year", type: "input", description: "Enter From year", target: "year", value: "2026" },
  ];
  const us = mergeDateSteps(usParts);
  assert.equal(us[0]?.date?.value, "2026-09-06");
  assert.equal(mergeDateSteps(usParts, true)[0]?.date?.value, "2026-09-06");
  assert.equal(mergeDateSteps([{ id: "n", type: "input", description: "Enter quantity", target: "Number", value: "06" }])[0]?.type, "input");
  const mixed = mergeDateSteps([
    { id: "from-day", type: "input", description: "Enter From day", target: "From day", value: "06" },
    { id: "to-month", type: "input", description: "Enter To month", target: "To month", value: "09" },
    { id: "from-year", type: "input", description: "Enter From year", target: "From year", value: "2026" },
  ]);
  assert.equal(mixed.every((step) => step.type === "input"), true);
  assert.deepEqual(mergeDateSteps(merged), merged);
});

test("merges a single date field and leaves invalid dates alone", () => {
  const merged = mergeDateSteps([{ id: "date", type: "input", description: "Enter the date", target: "From", value: "06.09.2026" }]);
  assert.equal(merged[0]?.type, "date");
  assert.equal(merged[0]?.date?.format, "%d.%m.%Y");
  const textual = mergeDateSteps([{ id: "text-date", type: "input", description: "Enter the date", target: "From", value: "September 6, 2026" }]);
  assert.equal(textual[0]?.date?.value, "2026-09-06");
  const ambiguousSlash = mergeDateSteps([{ id: "ambiguous-date", type: "input", description: "Enter the date", target: "From", value: "09/06/2026" }]);
  assert.equal(ambiguousSlash[0]?.type, "input");
  const wrongWeekday = mergeDateSteps([{ id: "weekday-date", type: "input", description: "Enter the date", target: "From", value: "Monday, September 6, 2026" }]);
  assert.equal(wrongWeekday[0]?.type, "input");
  assert.equal(mergeDateSteps([{ id: "date", type: "input", description: "Enter the date", target: "From", value: "31.02.2026" }])[0]?.type, "input");
});

test("compiles every date rule with raw builtin fields and escapes user text", () => {
  const step: SetupStep = { id: "from", type: "date", description: "Enter the From date", target: "From", date: { value: "2026-09-06", format: "%d.%m.%Y", rule: null } };
  for (const rule of [
    { kind: "fixed" }, { kind: "today" }, { kind: "yesterday" }, { kind: "days_ago", days: 3 },
    { kind: "start_of_this_month" }, { kind: "end_of_this_month" }, { kind: "start_of_last_month" }, { kind: "end_of_last_month" },
    { kind: "start_of_last_week" }, { kind: "end_of_last_week" }, { kind: "described", text: "the period {selected}" },
  ] as const) {
    const draft = baseDraft();
    draft.steps = [{ ...step, date: { ...step.date!, rule } }];
    const prompt = (compileAgent(draft).stages[0] as { prompt: string }).prompt;
    if (rule.kind === "fixed") assert.match(prompt, /exactly/);
    else if (rule.kind === "described") assert.match(prompt, /the period \{\{selected\}\}/);
    else assert.match(prompt, /\{(?:today|yesterday|days_ago_3|start_of_this_month|end_of_this_month|start_of_last_month|end_of_last_month|start_of_last_week|end_of_last_week)\|/);
  }
});

test("protects a user literal that resembles a date field from FIRE date filling", () => {
  const draft = baseDraft();
  draft.steps = [{ id: "date", type: "date", description: "Enter the date", target: "From", date: { value: "2026-09-06", format: "%d.%m.%Y", rule: { kind: "described", text: "the period {today|%Y}" } } }];
  const prompt = (compileAgent(draft).stages[0] as { prompt: string }).prompt;
  assert.match(prompt, /the period \{\{today\|%Y\}\}/);
});

test("keeps zero-padded day and month tokens for parts dates", () => {
  const draft = baseDraft();
  draft.steps = [{
    id: "parts", type: "date", description: "Enter the From date", target: "From",
    date: { value: "2026-09-06", format: "parts", rule: { kind: "today" } },
    parts: dateParts(),
  }];
  const prompt = (compileAgent(draft).stages[0] as { prompt: string }).prompt;
  assert.match(prompt, /\{today\|%d\}/);
  assert.match(prompt, /\{today\|%m\}/);
});

test("preserves month/day/year order for parts dates", () => {
  const draft = baseDraft();
  const standard = dateParts();
  const parts = [standard[1]!, standard[0]!, standard[2]!];
  draft.steps = [{
    id: "parts-us", type: "date", description: "Enter the From date", target: "From",
    date: { value: "2026-09-06", format: "parts", rule: { kind: "today" } }, parts,
  }];
  const prompt = (compileAgent(draft).stages[0] as { prompt: string }).prompt;
  assert.match(prompt, /type month \{today\|%m\}, day \{today\|%d\} and year \{today\|%Y\}/);
});

test("recommends date rules from goals and resolves month/week boundaries", () => {
  const from: SetupStep = { id: "from", type: "date", description: "Enter From date", target: "From", date: { value: "2026-09-06", format: "%d.%m.%Y", rule: null } };
  const to = { ...from, id: "to", description: "Enter To date", target: "To" };
  assert.equal(dateRuleChoices(from, "Download last month's statement", "2026-10-05")[0]?.rule.kind, "start_of_last_month");
  assert.equal(dateRuleChoices(to, "Download last month's statement", "2026-10-05")[0]?.rule.kind, "end_of_last_month");
  assert.equal(dateRuleChoices(to, "Laadi alla eelmise kuu väljavõte", "2026-10-05")[0]?.rule.kind, "end_of_last_month");
  assert.equal(dateRuleChoices(from, "daily export of yesterday's transactions", "2026-10-05")[0]?.rule.kind, "yesterday");
  assert.equal(dateRuleChoices(to, "No match", "2026-10-05")[0]?.rule.kind, "today");
  assert.equal(dateRuleChoices(from, "Laadi alla eelmise kuu väljavõte", "2026-10-05")[0]?.rule.kind, "start_of_last_month");
  assert.equal(dateRuleChoices(from, "Laadi alla 3 päeva vanused tehingud", "2026-10-05")[0]?.rule.kind, "days_ago");
  assert.equal(resolveDateRule({ kind: "end_of_last_month" }, "2026-03-01"), "2026-02-28");
  assert.equal(resolveDateRule({ kind: "start_of_last_month" }, "2026-01-05"), "2025-12-01");
  assert.equal(dateRuleLabel({ kind: "end_of_last_month" }, "2026-10-05", "%d.%m.%Y"), "End of last month");
});

test("opens date questions and reports a changed date rule", () => {
  const unanswered: SetupStep = { id: "from", type: "date", description: "Enter the From date", target: "From", date: { value: "2026-09-06", format: "%d.%m.%Y", rule: null } };
  const draft = { ...baseDraft(), goal: "Download last month's statement", steps: [unanswered] };
  assert.match(openQuestions(draft, "2026-10-05")[0]!.text, /06\.09\.2026/);
  const answered = { ...draft, steps: [{ ...unanswered, date: { ...unanswered.date!, rule: { kind: "end_of_last_month" as const } } }] };
  assert.deepEqual(draftChanges(answered, draft).map(({ label, from, to }) => ({ label, from, to })), [{ label: "Step 1 date", from: "Unanswered", to: "End of last month" }]);
  const fixed = { ...draft, steps: [{ ...unanswered, date: { ...unanswered.date!, rule: { kind: "fixed" as const } } }] };
  assert.deepEqual(draftChanges(fixed, draft).map(({ from, to }) => ({ from, to })), [{ from: "Unanswered", to: "Always 06.09.2026" }]);
  assert.equal(dateRuleChoices(unanswered, draft.goal, "2026-10-05").find((choice) => choice.rule.kind === "fixed")?.value, "06.09.2026");
});

test("validates date values, formats, relative ranges, and described answers", () => {
  const baseDate: SetupStep = { id: "date", type: "date", description: "Enter date", target: "Date", date: { value: "2026-09-06", format: "%d.%m.%Y", rule: { kind: "days_ago", days: 3 } } };
  for (const [change, message] of [
    [{ date: { ...baseDate.date!, value: "2026-02-30" } }, /valid ISO date/],
    [{ date: { ...baseDate.date!, format: "%Q" } }, /supported date format/],
    [{ date: { ...baseDate.date!, rule: { kind: "days_ago", days: 0 } } }, /between 1 and 366/],
    [{ date: { ...baseDate.date!, rule: { kind: "described", text: "x".repeat(121) } } }, /1 to 120/],
    [{ date: { ...baseDate.date!, rule: { kind: "described", text: "password: hunter2" } } }, /Remove sign-in details/],
  ] as const) {
    const draft = baseDraft();
    draft.steps = [{ ...baseDate, ...change }];
    assert.throws(() => compileAgent(draft), message);
  }
});

const routedAddress = "reports+agent@reiterate.com";

/** One authored Draft per existing completion kind, each with steps that compile under its criterion. */
function draftsByCompletion(): Record<DoneWhen["kind"], SetupDraft> {
  const emailSteps: SetupStep[] = [
    { id: "recipient", type: "input", description: "Enter the export recipient", target: "Send export to", value: routedAddress },
    { id: "send", type: "click", description: "Send the export by email", target: "Send export" },
  ];
  return {
    file: { ...baseDraft(), doneWhen: { kind: "file" } },
    text: { ...baseDraft(), doneWhen: { kind: "text", value: " Export sent " } },
    described: { ...baseDraft(), doneWhen: { kind: "described", value: "The export {month} is listed as sent" } },
    email: { ...baseDraft(), steps: emailSteps, doneWhen: { kind: "email", address: routedAddress, channelId: "route-1" } },
    clicked: { ...baseDraft(), doneWhen: { kind: "clicked", value: "Download statement" } },
  };
}

/** What a host returns for a saved Draft: its projected fields, executable stages and the stored setup, over JSON. */
function saved(draft: SetupDraft, stages: unknown[] = compileAgent(draft).stages, ...stored: [setup?: unknown]) {
  // An explicit undefined setup is an older host that sends none; omitting the argument stores the Draft itself.
  const setup = stored.length === 0 ? draft : stored[0];
  return JSON.parse(JSON.stringify({ name: draft.name, url: draft.url, goal: draft.goal, steps: draft.steps, stages, ...(setup === undefined ? {} : { setup }) })) as {
    name: string; url: string; goal: string; steps: SetupStep[] | null; stages: unknown[]; setup?: unknown;
  };
}

test("refuses to compile a Draft without a completion criterion instead of defaulting to a download", () => {
  const draft: SetupDraft = { ...baseDraft(), doneWhen: undefined };
  assert.throws(() => compileAgent(draft), /completion check/);
  for (const malformed of [{ kind: "files" }, { kind: "text" }, { kind: "email", address: routedAddress }, "file", null]) {
    assert.throws(() => compileAgent({ ...baseDraft(), doneWhen: malformed as unknown as DoneWhen }), /completion check/, JSON.stringify(malformed));
  }
});

test("reopens every completion kind as the same Draft and recompiles it without a change in meaning", () => {
  for (const [kind, draft] of Object.entries(draftsByCompletion())) {
    const compiled = compileAgent(draft);
    const reopened = reopenDraft(saved(draft));
    assert.equal(reopened.kind, "structured", kind);
    assert.deepEqual(reopened.draft.doneWhen, draft.doneWhen, kind);
    assert.deepEqual(compileAgent(reopened.draft), compiled, kind);
    assert.deepEqual(draftChanges(reopened.draft, reopenDraft(saved(draft)).draft), [], kind);
    assert.deepEqual(authoredSetup(reopened, reopened.draft).doneWhen, draft.doneWhen, kind);
  }
});

test("keeps the saved criterion through an unrelated structured edit", () => {
  for (const [kind, draft] of Object.entries(draftsByCompletion())) {
    const reopened = reopenDraft(saved(draft));
    assert.equal(reopened.kind, "structured", kind);
    const edited = { ...reopened.draft, goal: "Download the latest statement.", steps: reopened.draft.steps.map((step, index) => index === 1 ? { ...step, description: `${step.description} again` } : step) };
    assert.deepEqual(compileAgent(edited).stages.slice(1), compileAgent(draft).stages.slice(1), kind);
    assert.deepEqual(authoredSetup(reopened, edited).doneWhen, draft.doneWhen, kind);
    assert.deepEqual(draftChanges(edited, reopened.draft).map((change) => change.key), ["goal", "step:download-statement:description"].filter((key) => kind !== "email" || key === "goal").concat(kind === "email" ? ["step:send:description"] : []), kind);
  }
});

test("keeps raw editing and the stored setup when the saved completion intent is missing or malformed", () => {
  const draft = draftsByCompletion().text;
  const stages = compileAgent(draft).stages;
  const { doneWhen: _omitted, ...withoutCompletion } = draft;
  void _omitted;
  for (const [label, setup] of [
    ["an older host sends no setup", undefined],
    ["the host stored no setup", null],
    ["the setup has no completion", withoutCompletion],
    ["an unknown kind", { ...draft, doneWhen: { kind: "files" } }],
    ["a text check without text", { ...draft, doneWhen: { kind: "text" } }],
    ["an email check without a route", { ...draft, doneWhen: { kind: "email", address: routedAddress } }],
    ["a completion that is not an object", { ...draft, doneWhen: "text" }],
  ] as const) {
    const reopened = reopenDraft(saved(draft, stages, setup));
    assert.deepEqual([reopened.kind, reopened.kind === "raw" ? reopened.reason : null], ["raw", "unknown-completion"], label);
    assert.equal(reopened.draft.doneWhen, undefined, label);
    assert.deepEqual(reopened.draft.steps, [], label);
    const kept = authoredSetup(reopened, { ...reopened.draft, goal: "Changed goal" });
    assert.equal(kept.goal, "Changed goal", label);
    assert.deepEqual(kept.steps, JSON.parse(JSON.stringify(draft.steps)), label);
    if (setup !== null && setup !== undefined) assert.deepEqual(kept.doneWhen, (setup as { doneWhen?: unknown }).doneWhen, label);
    else assert.equal("doneWhen" in kept, false, label);
  }
});

test("treats a saved criterion that its executable stages contradict as inconsistent, not as a new criterion", () => {
  const drafts = draftsByCompletion();
  const agent = (prompt: string) => ({ type: "agent", prompt, step_limit: 64 });
  const promptOf = (draft: SetupDraft) => (compileAgent(draft).stages[0] as { prompt: string }).prompt;
  for (const [label, draft, stages] of [
    ["file without a download", drafts.file, [agent(promptOf(drafts.file))]],
    ["file with an exact-text check", drafts.file, [agent(promptOf(drafts.file)), { type: "expect_text", text: "Export sent" }]],
    ["text with a download", drafts.text, [agent(promptOf(drafts.text)), { type: "download" }]],
    ["text with different text", drafts.text, [agent(promptOf(drafts.text)), { type: "expect_text", text: "Export queued" }]],
    ["described without its criterion in the prompt", drafts.described, [agent(promptOf(drafts.file))]],
    ["email with a download", drafts.email, [agent(promptOf(drafts.email)), { type: "download" }]],
    ["email whose route is not in the instructions", drafts.email, [agent(promptOf(drafts.file))]],
    ["clicked with a download", drafts.clicked, [agent(promptOf(drafts.clicked)), { type: "download" }]],
  ] as const) {
    const reopened = reopenDraft(saved(draft, [...stages]));
    assert.deepEqual([reopened.kind, reopened.kind === "raw" ? reopened.reason : null], ["raw", "inconsistent-completion"], label);
    assert.deepEqual(authoredSetup(reopened, reopened.draft).doneWhen, draft.doneWhen, label);
  }
  // Extra host stages after the completion stage do not change what completion means.
  const withHostStages = reopenDraft(saved(drafts.file, [...compileAgent(drafts.file).stages, { type: "sleep", sleep_ms: 5000 }, { type: "reload" }]));
  assert.equal(withHostStages.kind, "structured");
});

test("keeps an agent without demonstrated steps on raw editing with its stored setup", () => {
  for (const steps of [null, []]) {
    const host = { ...saved(draftsByCompletion().file), steps };
    const reopened = reopenDraft(host);
    assert.deepEqual([reopened.kind, reopened.kind === "raw" ? reopened.reason : null], ["raw", "no-steps"]);
    assert.deepEqual(authoredSetup(reopened, reopened.draft).doneWhen, { kind: "file" });
  }
  const older = reopenDraft({ ...saved(draftsByCompletion().file, undefined, undefined), steps: null });
  assert.deepEqual(authoredSetup(older, older.draft), { name: "Download monthly statement", url: "https://portal.example.test/reports", goal: "Download the monthly statement.", steps: [], inputs: [] });
});

test("compares completion meaning when deciding what changed", () => {
  const drafts = draftsByCompletion();
  assert.equal(sameCompletion({ kind: "text", value: "Export sent" }, { kind: "text", value: " Export sent " }), true);
  assert.equal(sameCompletion({ kind: "text", value: "Export sent" }, { kind: "described", value: "Export sent" }), false);
  assert.equal(sameCompletion({ kind: "email", address: routedAddress, channelId: "route-1" }, { kind: "email", address: routedAddress, channelId: "route-2" }), false);
  assert.equal(sameCompletion({ kind: "clicked", value: "Export" }, { kind: "clicked", value: "Export " }), false);
  assert.equal(sameCompletion(undefined, { kind: "file" }), false);
  assert.equal(sameCompletion(undefined, undefined), true);
  assert.deepEqual(draftChanges({ ...drafts.file, doneWhen: { kind: "text", value: "Export sent" } }, drafts.file).map(({ key, label, from, to }) => ({ key, label, from, to })), [
    { key: "doneWhen", label: "Completion check", from: "A file is downloaded", to: "“Export sent” appears on the page" },
  ]);
  assert.deepEqual(draftChanges({ ...drafts.text, doneWhen: { kind: "text", value: "Export sent" } }, drafts.text), []);
});
