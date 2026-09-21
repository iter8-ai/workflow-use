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

const credentialStem = String.raw`(?:password(?!less)s?|passcodes?|passphrases?|secret(?!santa)s?|(?:api)?token(?!ization|izer)s?|apikeys?|credentials?|auth|authenticat(?:e|es|ed|ing|ion|or|ors)|authoriz(?:e|es|ed|ing|ation|ations)|oauth2?|log(?:ged|ging)?(?:in|into|on)|logins?|logons?|sign(?:ed|ing)?(?:in|into|on)|signins?|signons?|onetime(?:passwords?|passcodes?|codes?)|(?:onetime)?(?:otp|totp)|mfa|2fa|verificationcodes?|recoverycodes?|backupcodes?|cvv|cvc|socialsecurity(?:number)?|ssn|creditcards?|cardnumbers?|username(?!generator)s?)`;
const directDigitCredentialPattern = new RegExp(String.raw`\b[\p{L}\p{N}]*${credentialStem}\p{N}+`, "iu");
const ownedCredentialPattern = new RegExp(String.raw`\b(?:my|your|our|account)${credentialStem}(?=[\p{L}\p{N}]*\p{N})[\p{L}\p{N}]+`, "iu");
const credentialIntentPatterns = [
  directDigitCredentialPattern,
  ownedCredentialPattern,
  /\b(?:passwords?|pass words?)(?!\p{L})/iu,
  /\bpasscodes?(?!\p{L})/iu,
  /\bpassphrases?(?!\p{L})/iu,
  /\bsecrets?(?!\p{L})/iu,
  /\b(?:api )?tokens?(?!\p{L})/iu,
  /\bapi ?keys?(?!\p{L})/iu,
  /\bcredentials?(?!\p{L})/iu,
  /\bauth(?!\p{L})/iu,
  /\bauthenticat(?:e|es|ed|ing|ion|or|ors)(?!\p{L})/iu,
  /\bauthoriz(?:e|es|ed|ing|ation|ations)(?!\p{L})/iu,
  /\boauth(?:2)?(?!\p{L})/iu,
  /\b(?:log(?:ged|ging)?\s*(?:in|into|on)|logins?|logons?)(?!\p{L})/iu,
  /\b(?:sign(?:ed|ing)?\s*(?:in|into|on)|signins?|signons?)(?!\p{L})/iu,
  /\b(?:one ?time) ?(?:passwords?|passcodes?|codes?)(?!\p{L})/iu,
  /\b(?:one time )?(?:otp|totp)(?!\p{L})/iu,
  /\b(?:mfa|m f a|2fa|2 fa|2 f a)(?!\p{L})/iu,
  /\bverification codes?(?!\p{L})/iu,
  /\brecovery codes?(?!\p{L})/iu,
  /\bbackup codes?(?!\p{L})/iu,
  /\b(?:cvv|cvc)(?!\p{L})/iu,
  /\bsocial security(?: number)?(?!\p{L})/iu,
  /\bssn(?!\p{L})/iu,
  /\bcredit cards?(?!\p{L})/iu,
  /\bcard numbers?(?!\p{L})/iu,
  /\buser ?names?(?!\p{L})/iu,
];
const pinIntentPattern = /\b(?:enter|provide|type|use|submit|verify) (?:(?:a|the|your) )?pin\b|\bpin (?:code|number|verification)\b|\bpersonal identification number\b|\b(?:my )?pin\s*(?:is|:)\s*\S+\b/i;
const possessivePinPattern = /\b(?:account|my|your|our) pin\b/i;
const pinActionIntentPattern = /\b(?:reset|set|change|update|copy|send|show|reveal|choose|insert|paste(?: in)?|fill(?: in)?) (?:(?:a|the|this|that|my|your|our) )?pin\b/i;
const pinDirectAssignmentPattern = /\bpin\s*[:=]\s*\S+/iu;
const pinAssignmentPattern = /\b(?:reset|set|change|update)\s+(?:your\s+)?pin\s+(?:to|as)\s+\S+|\bpin\s+(?:to|as)\s+(?:\p{N}{4,12}|(?=[\p{L}\p{N}]{4,12}\b)(?=[\p{L}\p{N}]*\p{N})[\p{L}\p{N}]{4,12})\b/iu;
const pinCodePattern = /\b[Pp][Ii][Nn]\s*(?:\p{N}{4,12}|(?=[A-Z0-9]{4,12}(?![A-Z0-9]))(?=[A-Z0-9]*\d)[A-Z0-9]+)\s*$/u;
const pinLeadingCodePattern = /(?:^|\s)pin\s+(?:\p{N}{4,12}|(?=[\p{L}\p{N}]{4,12}(?:\s|$))(?=[\p{L}\p{N}]*\p{N})[\p{L}\p{N}]{4,12})(?=\s|$)/iu;
const safePinClickActionPattern = /^(?:(?:click|please|then)\s+)?pin\s+(?:\p{L}{2,}\p{N}{1,4}(?:\s+(?:to|onto|on)\s+(?:the\s+)?dashboard)?|(?:19|20)\p{N}{2}\s+\p{L}+(?:\s+\p{L}+)*\s+(?:to|onto|on)\s+(?:the\s+)?dashboard)$/iu;
const safePinClickLabelPattern = /^(?:open|click|select|choose)\s+pin\s+(?:report|\p{L}{2,}\s?\p{N}{1,5})$/iu;
const safeMapPinActionPattern = /^(?:set|choose|place|drop) (?:(?:a|the|this|that|my|your|our) )?pin (?:(?:on|onto|for) (?:(?:the|this|that) )?map|(?:at|near) [\p{L}\p{N}]+(?: [\p{L}\p{N}]+)* (?:on|onto) (?:(?:the|this|that) )?map)$/iu;
const safePinContentPathPattern = /^pin\s+report\p{N}{1,4}$/iu;
const maximumPathDecodes = 4;
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
  if (draft.inputs.length > 0) {
    throw new Error("Form-entry tasks are not supported in this release. Remove input and select steps.");
  }

  const stepIds = new Set<string>();
  for (const step of draft.steps) {
    requireText(step.id, "Step id");
    requireText(step.description, `Description for step ${step.id}`);
    if (
      (containsSensitiveText(step.description, isSafePinClickText(step, step.description)) && !isRecorderHostDescription(step))
      || containsSensitiveText(optionalStepText(step.expectedOutcome) ?? "")
    ) {
      throw credentialError();
    }
    if (stepIds.has(step.id)) {
      throw new Error(`Step id ${step.id} is duplicated.`);
    }
    stepIds.add(step.id);

    validateStep(step);
    if (step.type === "input" || step.type === "select_change") {
      throw new Error("Form-entry tasks are not supported in this release. Remove input and select steps.");
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
  if (target !== undefined && containsSensitiveText(target, isSafePinClickText(step, target))) {
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
  if (
    containsSensitivePath(rawPathname(value))
    || containsSensitivePath(url.pathname)
  ) {
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

function containsSensitiveText(value: string, allowPinCode = false): boolean {
  const normalized = normalizeIntentText(value);
  const normalizedAssignment = normalizePinAssignmentText(value);
  const isMapPlacement = safeMapPinActionPattern.test(normalized)
    && normalized.match(/\bpin\b/gi)?.length === 1;
  return credentialIntentPatterns.some((pattern) => pattern.test(normalized))
    || pinIntentPattern.test(normalized)
    || (!isMapPlacement && (possessivePinPattern.test(normalized)
      || (!allowPinCode && pinActionIntentPattern.test(normalized))))
    || pinDirectAssignmentPattern.test(normalizedAssignment)
    || pinAssignmentPattern.test(normalized)
    || (!allowPinCode && (pinLeadingCodePattern.test(normalized) || pinCodePattern.test(normalized)));
}

function normalizePinAssignmentText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}|\p{Cf}/gu, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}:=]+/gu, " ")
    .trim();
}

function isSafePinClickText(step: SetupStep, value: string): boolean {
  if (step.type !== "click") {
    return false;
  }
  const normalized = normalizeIntentText(value);
  return safePinClickActionPattern.test(normalized) || safePinClickLabelPattern.test(normalized);
}

function containsSensitivePath(value: string): boolean {
  const decoded = decodedPathname(value);
  return containsSensitiveText(decoded, safePinContentPathPattern.test(normalizeIntentText(decoded)));
}

function isRecorderHostDescription(step: SetupStep): boolean {
  if (step.type !== "navigation" || step.url === null || step.url === undefined) {
    return false;
  }
  try {
    return step.description.toLowerCase() === `open ${new URL(step.url).host}`.toLowerCase();
  } catch {
    return false;
  }
}

function normalizeIntentText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}|\p{Cf}/gu, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
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

function rawPathname(value: string): string {
  const schemeEnd = value.indexOf("://");
  const remainder = value.slice(schemeEnd + 3);
  const relativePathStart = remainder.search(/[\\/]/);
  return relativePathStart === -1
    ? ""
    : remainder.slice(relativePathStart).split(/[?#]/, 1)[0]!.replace(/\\/g, "/");
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
