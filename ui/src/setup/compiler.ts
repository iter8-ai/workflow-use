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

const inputNamePattern = /^[a-z][a-z0-9_]*$/;
const sensitivePattern = /password|passcode|secret|token|api[_ -]?key|credential|authorization|auth(?:entication)?|cvv|cvc|social security|ssn|credit card|card number|user ?name|one.?time|otp|totp|log ?in|sign ?in/i;
const rawReplayPattern = /\b(?:css|xpath|selector)\b|#[a-z][\w-]*(?:\s*[>+~]|\[)|\[[^\]]+\]|(?:^|\s)(?:x|y)\s*[:=]\s*\d+|^\s*\d+(?:px)?\s*,\s*\d+(?:px)?\s*$/i;
const supportedInputTypes = new Set<SetupInput["type"]>(["text", "date", "number"]);
const maximumNameLength = 150;
const maximumUrlLength = 2_048;
const maximumSteps = 200;
const maximumInputNameLength = 64;

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

  const stepIds = new Set<string>();
  const inputNames = new Set<string>();
  for (const input of draft.inputs) {
    requireText(input.name, "Input name");
    requireText(input.label, `Input label for ${input.name}`);
    requireText(input.example, `Input example for ${input.name}`);
    requireMaximumLength(input.name, maximumInputNameLength, "Input name");
    if (!supportedInputTypes.has(input.type)) {
      throw new Error(`Unsupported input type for ${input.name}. Use text, date, or number.`);
    }
    if (!inputNamePattern.test(input.name) || input.name.startsWith("__")) {
      throw new Error(`Input name ${input.name} must use safe lowercase letters, numbers, and underscores.`);
    }
    if (inputNames.has(input.name)) {
      throw new Error(`Input name ${input.name} is duplicated.`);
    }
    if (containsSensitiveText(input.name) || containsSensitiveText(input.label) || containsSensitiveText(input.example)) {
      throw credentialError();
    }
    inputNames.add(input.name);
  }

  const referencedInputs = new Set<string>();
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
      if (step.inputName === undefined) {
        throw new Error(`Step ${step.id} needs a named reusable input before creating the agent.`);
      }
      if (optionalStepText(step.value) !== undefined) {
        throw new Error(`Step ${step.id} must not include a demonstrated input value.`);
      }
    }
    if (step.inputName !== undefined) {
      if (step.type !== "input" && step.type !== "select_change") {
        throw new Error(`Reusable input ${step.inputName} can only be used on an input or select step.`);
      }
      if (!inputNames.has(step.inputName)) {
        throw new Error(`Step ${step.id} references ${step.inputName}, which is not a declared input.`);
      }
      referencedInputs.add(step.inputName);
    }
  }

  for (const inputName of inputNames) {
    if (!referencedInputs.has(inputName)) {
      throw new Error(`Declared input ${inputName} must be referenced by a demonstrated step.`);
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
  if (target !== undefined && containsSensitiveText(target)) {
    throw credentialError();
  }
  if (value !== undefined && isMaskedValue(value)) {
    throw credentialError();
  }
  if (looksLikeRawReplay(target) || looksLikeRawReplay(step.description)) {
    throw new Error(`Step ${step.id} must use a semantic target, not a selector or screen coordinates.`);
  }
}

function formatStep(step: SetupStep, index: number): string {
  const targetValue = optionalStepText(step.target);
  const literalValue = step.type === "input" || step.type === "select_change"
    ? undefined
    : optionalStepText(step.value);
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
  const intent = continuation(step.description, literalValueForContinuation(step));
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
  return sensitivePattern.test(value);
}

function isMaskedValue(value: string): boolean {
  return /^\s*(?:[•●◦*]{3,}|\[?redacted\]?)\s*$/i.test(value);
}

function optionalStepText(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function literalValueForContinuation(step: SetupStep): string | undefined {
  return step.type === "input" || step.type === "select_change" ? undefined : optionalStepText(step.value);
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
