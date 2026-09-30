export type SetupStep = {
  id: string;
  type: "navigation" | "click" | "input" | "credential" | "select_change" | "key_press" | "scroll" | "agent";
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

/** Sign-in values the host stores encrypted as agent parameters; setup never sees them. */
export const credentialKinds = ["username", "password", "otp"] as const;
export type CredentialKind = (typeof credentialKinds)[number];

export function requiredCredentials(steps: SetupStep[]): CredentialKind[] {
  return credentialKinds.filter((kind) => steps.some((step) => step.type === "credential" && step.value === kind));
}

// A credential word followed by an assigned value, or directly by a token containing a
// digit or symbol (e.g. "password correct-horse-9", "code 482913"). Sign-in wording
// ("Enter the password and log in") and $placeholders stay allowed.
const credentialDisclosurePattern = new RegExp(
  [
    String.raw`\b(?:user ?name|password|passcode|passphrase|pin|otp|token|api[ -]?key|secret`,
    String.raw`|(?:verification|security|access|auth(?:entication)?|one[- ]time|2fa|mfa|sms) code)s?\b\s*`,
    // An assigned value ("password: x", "code sent to me: 482913", "username is jane") ...
    String.raw`(?:[^.\n:=]{0,40}[:=]\s*\S{3,}|(?:\bis\b|\bwas\b)\s*\S{3,}`,
    // ... or a value containing a digit or symbol, excluding $placeholders.
    String.raw`|(?:(?:of|with)\s+)?(?!\$)(?=[^\s,;)]*?[\d@#%&*+_/\\-])[^\s,;)]{4,})`,
  ].join(""),
  "iu",
);
// Field labels whose typed value is a secret and must use a saved sign-in field.
const secretFieldPattern = /pass.?(?:word|code|phrase)|\bpin\b|api.?key|\bauth\b|credential|jwt|secret|token|one.?time|\botp\b|verification.?code|2fa|mfa|security.?answer|cvv|cvc|card.?number/iu;
// A one-time code a few words after its label ("code sent to me 482913").
const codeNearbyPattern = /\b(?:otp|passcode|(?:verification|security|access|auth(?:entication)?|one[- ]time|2fa|mfa|sms) code)s?\b[^.\n]{0,40}?\b\d{4,8}\b/iu;
const rawReplayPattern = /\b(?:css|xpath|selector)\b|#[a-z][\w-]*(?:\s*[>+~]|\[)|\[[^\]]+\]|(?:^|\s)(?:x|y)\s*[:=]\s*\d+|^\s*\d+(?:px)?\s*,\s*\d+(?:px)?\s*$/i;
const maximumNameLength = 150;
const maximumUrlLength = 2_048;
const maximumSteps = 200;

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
  rejectCredentialDisclosure(draft.name, draft.goal);
  validateUrl(draft.url, "Setup URL");

  if (draft.steps.length === 0) {
    throw new Error("Add at least one demonstrated step before creating the agent.");
  }
  if (draft.steps.length > maximumSteps) {
    throw new Error(`A setup can contain at most ${maximumSteps} demonstrated steps.`);
  }
  if (draft.inputs.length > 0) {
    throw new Error("Reusable inputs are not supported in this release.");
  }

  const stepIds = new Set<string>();
  for (const step of draft.steps) {
    requireText(step.id, "Step id");
    requireText(step.description, `Description for step ${step.id}`);
    rejectCredentialDisclosure(step.description, step.expectedOutcome, step.target, step.value);
    if (stepIds.has(step.id)) {
      throw new Error(`Step id ${step.id} is duplicated.`);
    }
    stepIds.add(step.id);

    validateStep(step);
    if (step.type === "select_change" && optionalStepText(step.value) === undefined) {
      throw new Error(`Step ${step.id} does not say which option to choose. Enter the option or remove the step.`);
    }
    if (step.type === "input" && (step.value === null || step.value === undefined)) {
      throw new Error(`Step ${step.id} does not say what to type (the recorded text was too long). Enter the text or remove the step.`);
    }
    if (step.type === "input" && step.value && secretFieldPattern.test(step.target ?? "")) {
      throw new Error(`Step ${step.id} types into ${step.target}. Mark it as a saved sign-in field instead of typing the value.`);
    }
    if (step.inputName !== undefined) {
      throw new Error("Reusable inputs are not supported in this release.");
    }
  }
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
  if (step.type === "credential" && !credentialKinds.includes(value as CredentialKind)) {
    throw new Error(`Step ${step.id} must be a saved username, password, or one-time code.`);
  }
  if (value !== undefined && isMaskedValue(value)) {
    throw new Error(`Step ${step.id} contains a hidden value. Remove it and demonstrate the step again.`);
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
  const value = literalValue === undefined ? undefined : escapeLiteral(literalValue);
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
  if (step.type === "credential") {
    // The engine replaces the placeholder with the stored value while typing.
    const field = target ?? "the sign-in field";
    return `${description}: type exactly $${step.value} into ${field}. It is replaced with the saved ${step.value} while typing.`;
  }
  // Form values are fixed text the agent repeats on every run.
  const field = target ?? "the field";
  if (step.type === "input") {
    return !step.value
      ? `${description}: clear ${field} so it is empty.`
      : `${description}: replace any text in ${field} with exactly ${quoted(step.value ?? "")}.`;
  }
  if (step.type === "select_change") {
    return `${description}: in ${field}, choose exactly ${quoted(step.value ?? "")}.`;
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
  // Check the path as written (new URL() drops "../" segments) and after each decoding pass.
  // Browsers read "\" as "/" in http(s) URLs, so normalize it before splitting off the host.
  let path = value.replace(/\\/g, "/").replace(/^[a-z]+:\/\/[^/]*/i, "").split(/[?#]/, 1)[0] ?? "";
  for (let pass = 0; pass < 4; pass += 1) {
    rejectCredentialDisclosure(path.replace(/[\\/]/g, " "));
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new Error(`${label} has an invalid path.`);
    }
    if (decoded === path) return;
    path = decoded;
  }
  throw new Error(`${label} has an invalid path.`);
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

function rejectCredentialDisclosure(...texts: Array<string | null | undefined>): void {
  if (texts.some((text) => text !== null && text !== undefined && (credentialDisclosurePattern.test(text) || codeNearbyPattern.test(text)))) {
    throw new Error("Remove sign-in details from the instructions. Reiterate asks for them separately and stores them encrypted.");
  }
}

function isMaskedValue(value: string): boolean {
  return /^\s*(?:[•●◦*]{3,}|\[?redacted\]?)\s*$/i.test(value);
}

function optionalStepText(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function looksLikeRawReplay(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && rawReplayPattern.test(value);
}

function escapeLiteral(value: string): string {
  return value.replace(/\{/g, "{{").replace(/\}/g, "}}");
}

function quoted(value: string): string {
  return escapeLiteral(JSON.stringify(value));
}

function continuation(description: string, literalValue: string | undefined): string {
  const withoutLiteral = literalValue === undefined || literalValue === ""
    ? description
    : description.split(literalValue).join("the supplied value");
  const escaped = escapeLiteral(withoutLiteral.trim());
  return escaped.length === 0 ? "complete the demonstrated task" : escaped[0]!.toLowerCase() + escaped.slice(1);
}

