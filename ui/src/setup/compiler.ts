export type SetupStep = {
  id: string;
  type: "navigation" | "click" | "input" | "select_change" | "key_press" | "scroll" | "agent";
  description: string;
  target?: string | null;
  value?: string | null;
  url?: string | null;
  expectedOutcome?: string | null;
  inputName?: string;
};

export type SetupInput = {
  name: string;
  label: string;
  type: "text" | "date" | "number";
  example: string;
};

export type SetupDraft = {
  name: string;
  url: string;
  goal: string;
  steps: SetupStep[];
  inputs: SetupInput[];
};

type AgentStage = {
  type: "agent";
  prompt: string;
  step_limit: number;
};

type DownloadStage = {
  type: "download";
};

type WorkflowStage = AgentStage | DownloadStage;

type CompiledAgent = {
  url: string;
  prompt: string;
  options: { version: 1; engine: "computer" };
  stages: WorkflowStage[];
  parameters: Record<string, never>;
};

const credentialIntentPatterns = [
  /\b(?:passwords?|pass words?)\b/i,
  /\bpasscodes?\b/i,
  /\bsecrets?\b/i,
  /\b(?:api )?tokens?\b/i,
  /\bapi keys?\b/i,
  /\bcredentials?\b/i,
  /\bauth\b/i,
  /\bauthenticat(?:e|es|ed|ing|ion)\b/i,
  /\bauthoriz(?:e|es|ed|ing|ation|ations)\b/i,
  /\boauth(?:2)?\b/i,
  /\b(?:log(?:ged|ging)?\s*(?:in|into|on)|logins?|logons?)\b/i,
  /\b(?:sign(?:ed|ing)?\s*(?:in|into|on)|signins?|signons?)\b/i,
  /\bone time (?:password|passcode|code)\b/i,
  /\b(?:one time )?(?:otp|totp)\b/i,
  /\b(?:mfa|m f a|2fa|2 fa|2 f a)\b/i,
  /\bverification code\b/i,
  /\b(?:cvv|cvc)\b/i,
  /\bsocial security(?: number)?\b/i,
  /\bssn\b/i,
  /\bcredit cards?\b/i,
  /\bcard numbers?\b/i,
  /\buser names?\b/i,
];
const pinIntentPattern = /\b(?:enter|provide|type|use|submit|verify) (?:your )?pin\b|\bpin (?:code|verification)\b|\b(?:my )?pin\s*(?:is|:)\s*\S+\b/i;
const pinValuePattern = /\bpin(?:\s*=\s*|\s+)(?!(?:report|the|this|that|these|those|a|an|my|your|our)\b)(?:\d+|[a-z0-9]+(?:\s+[a-z0-9]+)*)\b/i;
const maximumPathDecodes = 4;
const rawReplayPattern = /\b(?:css|xpath|selector)\b|#[a-z][\w-]*(?:\s*[>+~]|\[)|\[[^\]]+\]|(?:^|\s)(?:x|y)\s*[:=]\s*\d+|^\s*\d+(?:px)?\s*,\s*\d+(?:px)?\s*$/i;
const maximumNameLength = 150;
const maximumUrlLength = 2_048;
const maximumSteps = 200;
const maximumInputs = 50;
const maximumInputNameLength = 64;
const maximumInputExampleLength = 2_000;
const inputNamePattern = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const forbiddenInputNames = new Set(["constructor", "prototype", "__proto__"]);

export function compileAgent(draft: SetupDraft): CompiledAgent {
  validateDraft(draft);

  const task = `Complete ${escapeLiteral(draft.name)}: ${escapeLiteral(draft.goal)}`;
  const instructions = draft.steps.map(formatStep).join("\n");
  const prompt = [
    "Use the current, live browser screen to complete this task.",
    "Ground every action in what is visible. Do not replay CSS selectors, DOM locators, or recorded coordinates.",
    `Start at ${escapeLiteral(draft.url)}.`,
    task,
    "Demonstrated intent:",
    instructions,
  ].join("\n\n");

  return {
    url: draft.url,
    prompt: task,
    options: { version: 1, engine: "computer" },
    stages: [{ type: "agent", prompt, step_limit: 64 }, { type: "download" }],
    parameters: {},
  };
}

function validateDraft(draft: SetupDraft): void {
  requireText(draft.name, "Agent name");
  requireMaximumLength(draft.name, maximumNameLength, "Agent name");
  requireText(draft.goal, "Agent goal");
  if (containsSensitiveText(draft.name) || containsSensitiveText(draft.goal)) {
    throw credentialError();
  }
  validateUrl(draft.url, "Setup URL");

  if (draft.steps.length === 0) {
    throw new Error("Add at least one demonstrated step before creating the agent.");
  }
  if (draft.steps.length > maximumSteps) {
    throw new Error(`A setup can contain at most ${maximumSteps} demonstrated steps.`);
  }
  const inputNames = validateInputs(draft.inputs);
  const usedInputNames = new Set<string>();

  const stepIds = new Set<string>();
  for (const step of draft.steps) {
    requireText(step.id, "Step id");
    requireText(step.description, `Description for step ${step.id}`);
    if (containsSensitiveText(step.description) || containsSensitiveText(optionalStepText(step.expectedOutcome) ?? "")) {
      throw credentialError();
    }
    if (stepIds.has(step.id)) {
      throw new Error(`Step id ${step.id} is duplicated.`);
    }
    stepIds.add(step.id);

    validateStep(step);
    if (step.type === "input" || step.type === "select_change") {
      const target = optionalStepText(step.target);
      const value = optionalStepText(step.value);
      const inputName = optionalStepText(step.inputName);
      if (target === undefined || target.trim() === "") {
        throw new Error(`Form step ${step.id} requires a semantic target.`);
      }
      if ((value === undefined) === (inputName === undefined)) {
        throw new Error(`Form step ${step.id} requires either a literal value or one reusable input.`);
      }
      if (value !== undefined && value.trim() === "") {
        throw new Error(`Form step ${step.id} requires a non-empty literal value.`);
      }
      if (inputName !== undefined && !inputNames.has(inputName)) {
        throw new Error(`Form step ${step.id} references unknown input ${inputName}.`);
      }
      if (inputName !== undefined) {
        usedInputNames.add(inputName);
      }
    } else if (step.inputName !== undefined) {
      throw new Error(`Step ${step.id} cannot bind a reusable input.`);
    }
  }
  for (const inputName of inputNames) {
    if (!usedInputNames.has(inputName)) {
      throw new Error(`Reusable input ${inputName} is not used by a form step.`);
    }
  }
}

function validateInputs(inputs: SetupInput[]): Set<string> {
  if (inputs.length > maximumInputs) {
    throw new Error(`A setup can contain at most ${maximumInputs} reusable inputs.`);
  }
  const names = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    const label = `Reusable input ${index + 1}`;
    requireText(input.name, `${label} name`);
    if (input.name.length > maximumInputNameLength || !inputNamePattern.test(input.name) || forbiddenInputNames.has(input.name)) {
      throw new Error(`${label} name must start with a letter and contain at most 64 letters, numbers, or underscores.`);
    }
    if (names.has(input.name)) {
      throw new Error(`Reusable input name ${input.name} is duplicated.`);
    }
    requireText(input.label, `${label} label`);
    requireMaximumLength(input.label, maximumNameLength, `${label} label`);
    requireText(input.example, `${label} example`);
    requireMaximumLength(input.example, maximumInputExampleLength, `${label} example`);
    if (isMaskedValue(input.example)) {
      throw credentialError();
    }
    if (input.type !== "text" && input.type !== "date" && input.type !== "number") {
      throw new Error(`${label} type must be text, date, or number.`);
    }
    if (input.type === "date" && !isCalendarDate(input.example)) {
      throw new Error(`${label} example must be a valid date in YYYY-MM-DD format.`);
    }
    if (input.type === "number" && !isFiniteNumber(input.example)) {
      throw new Error(`${label} example must be a finite number.`);
    }
    if (containsSensitiveText(input.name) || containsSensitiveText(input.label) || containsSensitiveText(input.example)) {
      throw credentialError();
    }
    names.add(input.name);
  }
  return names;
}

function validateStep(step: SetupStep): void {
  const url = optionalStepText(step.url);
  const target = optionalStepText(step.target);
  const value = optionalStepText(step.value);
  if (step.type === "navigation") {
    validateUrl(url ?? target ?? step.description, `URL for step ${step.id}`);
  } else if (url !== undefined) {
    validateUrl(url, `URL for step ${step.id}`);
  }
  if (target !== undefined && containsSensitiveText(target)) {
    throw credentialError();
  }
  if (value !== undefined && isMaskedValue(value)) {
    throw credentialError();
  }
  if (value !== undefined && containsSensitiveText(value)) {
    throw credentialError();
  }
  if (looksLikeRawReplay(target) || looksLikeRawReplay(step.description)) {
    throw new Error(`Step ${step.id} must use a semantic target, not a selector or screen coordinates.`);
  }
}

function formatStep(step: SetupStep, index: number): string {
  const targetValue = optionalStepText(step.target);
  const literalValue = optionalStepText(step.value);
  const expectedOutcome = optionalStepText(step.expectedOutcome);
  const target = targetValue === undefined ? undefined : escapeLiteral(targetValue);
  const value = step.inputName === undefined
    ? literalValue === undefined ? undefined : escapeLiteral(literalValue)
    : `{${step.inputName}}`;
  const description = escapeLiteral(step.description);

  const instruction = formatInstruction(step, target, value, description);
  const outcome = expectedOutcome === undefined
    ? ""
    : ` After this step, check that: ${escapeLiteral(expectedOutcome)}.`;
  return `${index + 1}. ${instruction}${outcome}`;
}

function formatInstruction(
  step: SetupStep,
  target: string | undefined,
  value: string | undefined,
  description: string,
): string {
  const intent = continuation(step.description, optionalStepText(step.value));
  if (step.type === "navigation") {
    return `Navigate to ${escapeLiteral(step.url ?? step.target ?? step.description)} to ${intent}.`;
  }
  if (step.type === "click") {
    return target === undefined ? `Complete this action: ${description}.` : `Click ${target} to ${intent}.`;
  }
  if (step.type === "input" || step.type === "select_change") {
    return target === undefined ? `Enter ${value} to ${intent}.` : `Set ${target} to ${value} to ${intent}.`;
  }
  if (step.type === "key_press") {
    return value === undefined ? `Complete this action: ${description}.` : `Press ${value} to ${intent}.`;
  }
  if (step.type === "scroll") {
    return `Scroll as needed to ${description}.`;
  }
  return `Follow this demonstrated intent: ${description}.`;
}

function validateUrl(value: string, label: string): void {
  requireText(value, label);
  requireMaximumLength(value, maximumUrlLength, label);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an http(s) URL without credentials.`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    throw new Error(`${label} must be an http(s) URL without credentials.`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`${label} must not include query parameters or a fragment.`);
  }
  if (containsSensitiveText(decodedPathname(url.pathname))) {
    throw credentialError();
  }
}

function requireText(value: string, label: string): void {
  if (value.trim() === "") {
    throw new Error(`${label} is required.`);
  }
}

function requireMaximumLength(value: string, maximum: number, label: string): void {
  if (value.length > maximum) {
    throw new Error(`${label} must be at most ${maximum} characters.`);
  }
}

function containsSensitiveText(value: string): boolean {
  const normalized = normalizeIntentText(value);
  return credentialIntentPatterns.some((pattern) => pattern.test(normalized))
    || pinIntentPattern.test(normalized)
    || pinValuePattern.test(normalized);
}

function normalizeIntentText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}|\p{Cf}/gu, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[._\p{Pd}\u2212\s]+/gu, " ")
    .trim();
}

function decodedPathname(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < maximumPathDecodes; attempt += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      throw credentialError();
    }
    if (next === decoded || !/%[0-9a-f]{2}/i.test(next)) {
      return next;
    }
    decoded = next;
  }
  throw credentialError();
}

function isMaskedValue(value: string): boolean {
  return /^\s*(?:[•●◦*]{3,}|\[?redacted\]?)\s*$/i.test(value);
}

function optionalStepText(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isFiniteNumber(value: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
}

function looksLikeRawReplay(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && rawReplayPattern.test(value);
}

function escapeLiteral(value: string): string {
  return value.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

function continuation(description: string, literalValue: string | undefined): string {
  const withoutLiteral = literalValue === undefined || literalValue === ""
    ? description
    : description.split(literalValue).join("the supplied value");
  const escaped = escapeLiteral(withoutLiteral.trim());
  return escaped.length === 0 ? "complete the demonstrated task" : escaped[0]!.toLowerCase() + escaped.slice(1);
}

function credentialError(): Error {
  return new Error("Setup cannot capture credentials. Credentials must be managed by the host.");
}
