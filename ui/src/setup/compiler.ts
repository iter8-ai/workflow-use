export type SetupStep = {
  id: string;
  type: "navigation" | "click" | "input" | "credential" | "select_change" | "key_press" | "scroll" | "download" | "agent";
  description: string;
  target?: string | null;
  value?: string | null;
  url?: string | null;
  expectedOutcome?: string | null;
  inputName?: string;
  /** Short purpose of the run of steps this one belongs to, e.g. "Sign in". Set after the demonstration. */
  stage?: string | null;
};

export type StepGroup = { stage: string | null; steps: Array<{ step: SetupStep; index: number }> };

/** Consecutive steps that share a stage, in order. Steps keep their overall index. */
export function groupSteps(steps: SetupStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  steps.forEach((step, index) => {
    // An empty name still starts its own stage, so clearing the name while renaming does not merge stages.
    const stage = step.stage ?? null;
    const last = groups.at(-1);
    if (last !== undefined && (stage === null || stage === last.stage)) last.steps.push({ step, index });
    else groups.push({ stage, steps: [{ step, index }] });
  });
  return groups;
}

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
  doneWhen?: DoneWhen;
};

export type DoneWhen =
  | { kind: "file" }
  | { kind: "text"; value: string }
  | { kind: "described"; value: string }
  | { kind: "email"; address: string; channelId: string }
  | { kind: "clicked"; value: string };

export type DoneWhenOption = {
  label: string;
  strength?: "strong" | "medium" | "weak";
  why: string;
  recommended?: boolean;
  doneWhen?: DoneWhen;
  action?: "email" | "custom";
};

const emailValuePattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AgentStage = {
  type: "agent";
  prompt: string;
  step_limit: number;
};

type DownloadStage = {
  type: "download";
};

type ExpectTextStage = { type: "expect_text"; text: string };

type WorkflowStage = AgentStage | DownloadStage | ExpectTextStage;

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

export type DraftChange = { key: string; label: string; from: string; to: string };

export function draftChanges(draft: SetupDraft, live: SetupDraft): DraftChange[] {
  const changes: DraftChange[] = [];
  if (draft.url !== live.url) changes.push({ key: "url", label: "Website address", from: live.url, to: draft.url });
  if (draft.goal !== live.goal) changes.push({ key: "goal", label: "Goal", from: live.goal, to: draft.goal });
  const added = draft.steps.filter((step) => !live.steps.some((original) => original.id === step.id));
  const removed = live.steps.filter((step) => !draft.steps.some((current) => current.id === step.id));
  for (const step of added) changes.push({ key: `added:${step.id}`, label: "Step added", from: "", to: step.description });
  for (const step of removed) changes.push({ key: `removed:${step.id}`, label: "Step removed", from: step.description, to: "" });
  const currentOrder = draft.steps.filter((step) => live.steps.some((original) => original.id === step.id));
  const liveOrder = live.steps.filter((step) => draft.steps.some((current) => current.id === step.id));
  if (currentOrder.some((step, index) => step.id !== liveOrder[index]?.id)) {
    changes.push({ key: "steps", label: "Step order changed", from: liveOrder.map((step) => step.description).join(" → "), to: currentOrder.map((step) => step.description).join(" → ") });
  }
  draft.steps.forEach((step, index) => {
    const original = live.steps.find((item) => item.id === step.id);
    if (!original) return;
    if (step.description !== original.description) changes.push({ key: `step:${step.id}:description`, label: `Step ${index + 1} instruction`, from: original.description, to: step.description });
    if ((step.expectedOutcome ?? "") !== (original.expectedOutcome ?? "")) changes.push({ key: `step:${step.id}:outcome`, label: `Step ${index + 1} expected outcome`, from: original.expectedOutcome ?? "", to: step.expectedOutcome ?? "" });
  });
  return changes;
}

export function replaceStepsFrom(steps: SetupStep[], index: number, replacement: SetupStep[]): SetupStep[] {
  return [...steps.slice(0, index), ...replacement];
}

/**
 * Bring in the recorder's stages and clearer wording once they arrive, without undoing the user's edits:
 * a step whose description the user already changed keeps it, and removed steps stay removed.
 */
export function applyOrganizedSteps(current: SetupStep[], recorded: SetupStep[], organized: SetupStep[]): SetupStep[] {
  const before = new Map(recorded.map((step) => [step.id, step]));
  const after = new Map(organized.map((step) => [step.id, step]));
  return current.map((step) => {
    const was = before.get(step.id);
    const next = after.get(step.id);
    if (was === undefined || next === undefined) return step;
    return { ...step, stage: next.stage ?? step.stage, description: step.description === was.description ? next.description : step.description };
  });
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
const maximumStageLength = 60;
const maximumUrlLength = 2_048;
const maximumSteps = 200;

export function compileAgent(draft: SetupDraft): CompiledAgent {
  validateDraft(draft);

  const task = `Complete ${escapeLiteral(draft.name)}: ${escapeLiteral(draft.goal)}`;
  // Stage titles are headings only; step numbers stay global because the agent reports the step it stopped at.
  // An unnamed stage after a named one gets a neutral heading, so its steps do not read as part of the one before.
  const instructions = groupSteps(draft.steps).flatMap((group, position) => [
    ...(group.stage?.trim() ? [`${escapeLiteral(group.stage.trim())}:`] : position > 0 && group.stage !== null ? ["Then:"] : []),
    ...group.steps.map(({ step, index }) => formatStep(step, index)),
  ]).join("\n");
  const prompt = [
    "Use the current, live browser screen to complete this task.",
    "Ground every action in what is visible. Do not replay CSS selectors, DOM locators, or recorded coordinates.",
    `Start at ${escapeLiteral(draft.url)}.`,
    task,
    "Demonstrated intent:",
    instructions,
    ...(draft.doneWhen?.kind === "described" ? [
      `Success criterion (written by the user): ${escapeLiteral(draft.doneWhen.value.trim())}`,
      'Return status completed only when this criterion is visibly met on the current screen, and put the on-screen evidence you relied on in confirmation (short, factual). If you finished the steps but the criterion is not met, return status failed with reason starting exactly "Success criterion not met: " followed by what you saw instead, and step null.',
    ] : []),
  ].join("\n\n");

  return {
    url: draft.url,
    prompt: task,
    options: { version: 1, engine: "computer" },
    stages: [
      { type: "agent", prompt, step_limit: 64 },
      ...(draft.doneWhen?.kind === "text"
        ? [{ type: "expect_text" as const, text: draft.doneWhen.value.trim() }]
        : draft.doneWhen === undefined || draft.doneWhen.kind === "file" ? [{ type: "download" as const }] : []),
    ],
    parameters: {},
  };
}

function validateDraft(draft: SetupDraft): void {
  requireText(draft.name, "Agent name");
  requireMaximumLength(draft.name, maximumNameLength, "Agent name");
  requireText(draft.goal, "Agent goal");
  rejectCredentialDisclosure(draft.name, draft.goal, draft.doneWhen?.kind === "text" || draft.doneWhen?.kind === "described" ? draft.doneWhen.value : undefined);
  validateUrl(draft.url, "Setup URL");
  if (draft.doneWhen?.kind === "text" && (draft.doneWhen.value.trim().length === 0 || draft.doneWhen.value.trim().length > 200)) {
    throw new Error("Done-when text must be 1 to 200 characters.");
  }

  if (draft.doneWhen?.kind === "described" && (draft.doneWhen.value.trim().length === 0 || draft.doneWhen.value.trim().length > 300)) {
    throw new Error("Success criterion must be 1 to 300 characters.");
  }

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
    rejectCredentialDisclosure(step.description, step.expectedOutcome, step.target, step.value, step.stage);
    if ((step.stage?.length ?? 0) > maximumStageLength) {
      throw new Error(`Stage name for step ${step.id} must be at most ${maximumStageLength} characters.`);
    }
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

/** Candidate checks ordered by the strength of evidence in the finished run. */
export function doneWhenOptions(
  steps: SetupStep[],
  lastRun: { confirmation?: string | null; failureKind?: string | null; files?: Array<{ name: string; url: string }> } | null,
  doneWhen: DoneWhen,
): DoneWhenOption[] {
  const options: DoneWhenOption[] = [];
  const emailStepIndex = findUnambiguousEmailStep(steps);
  const sendsEmail = emailStepIndex !== null;
  if (doneWhen.kind === "email") {
    options.push({ label: `The export arrives at ${doneWhen.address}`, strength: "strong", why: "Reiterate saves the attached file in File library.", recommended: true, doneWhen });
  } else if (sendsEmail) {
    options.push({ label: "Send the export to Reiterate instead", strength: "strong", why: "Reiterate saves the attached file in File library, so workflows can use it.", recommended: true, action: "email" });
  }
  const confirmation = lastRun?.confirmation?.trim();
  if (confirmation && doneWhen.kind !== "described") {
    const colon = confirmation.indexOf(":");
    const stable = colon > 0 && /\b(?:\d{4}|\d{1,2}\s+[A-Z][a-z]+|[\w.+-]+@[\w.-]+|[\w.-]+\.(?:csv|xlsx?|pdf|zip))\b/i.test(confirmation.slice(colon + 1))
      ? confirmation.slice(0, colon).trim() : null;
    if (stable) options.push({ label: `“${stable}” appears on the page`, strength: "strong", why: "The changing date, file name, or address is left out.", recommended: options.length === 0, doneWhen: { kind: "text", value: stable } });
    options.push({ label: `“${confirmation}” appears on the page`, strength: stable || options.length > 0 ? "medium" : "strong", why: "The website showed this confirmation at the end of the test.", recommended: options.length === 0, doneWhen: { kind: "text", value: confirmation } });
  }
  if (confirmation) options.push({ label: `“${confirmation}” is shown (checked by the agent)`, strength: "medium", why: "The agent judges it in context, so small wording changes still pass.", doneWhen: { kind: "described", value: confirmation } });
  const last = steps.at(-1);
  if (last?.type === "click" && last.target) options.push({ label: `The agent clicks “${last.target}”`, strength: "weak", why: "This proves the click, but not the website result.", doneWhen: { kind: "clicked", value: last.target } });
  const downloadsInDemonstration = steps.some((step) => step.type === "download");
  options.push({ label: "A file is downloaded in the browser", strength: "strong", why: downloadsInDemonstration ? "Your demonstration downloaded a file, and Reiterate saves it." : "Reiterate saves the downloaded file.", recommended: downloadsInDemonstration && !options.some((option) => option.recommended), doneWhen: { kind: "file" } });
  options.push({ label: "Describe what success looks like", strength: "medium", why: "Write it in your own words; the agent checks it on the screen at the end of each run.", action: "custom" });
  return options.filter((option, index) => options.findIndex((candidate) => candidate.label === option.label) === index);
}

/** Rewrite only an explicit export recipient followed by an email-send action. */
export function findUnambiguousEmailStep(steps: SetupStep[]): number | null {
  const emailStepIndexes = steps.reduce<number[]>((indexes, step, index) => {
    if (step.type === "input" && emailValuePattern.test(step.value ?? "")) indexes.push(index);
    return indexes;
  }, []);
  if (emailStepIndexes.length !== 1) return null;
  const emailStepIndex = emailStepIndexes[0]!;
  const emailStep = steps[emailStepIndex]!;
  if (!/\b(?:export\s+(?:email|recipient)|(?:send|email)\s+(?:the\s+)?export\s+to)\b/i.test(`${emailStep.description} ${emailStep.target ?? ""}`)) return null;
  return steps.slice(emailStepIndex + 1).some((step) => step.type === "click" && /\b(?:send|email)\s+(?:the\s+)?(?:export|email)\b/i.test(`${step.description} ${step.target ?? ""}`))
    ? emailStepIndex
    : null;
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
  if (looksLikeRawReplay(target) || looksLikeRawReplay(step.description) || looksLikeRawReplay(step.stage)) {
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
  // A click's value is how many times it was clicked in a row, not text to keep out of the instruction.
  const intent = continuation(step.description, step.type === "click" ? undefined : optionalStepText(step.value));
  if (step.type === "navigation") {
    return `Navigate to ${escapeLiteral(step.url ?? step.target ?? step.description)} to ${intent}.`;
  }
  if (step.type === "click") {
    const times = clickCount(step);
    const repeat = times > 1 && !/\b\d+\s+times\b/i.test(step.description) ? ` Click it ${times} times in a row.` : "";
    // A description that already names the click ("Click Reports in the menu") is the clearest instruction.
    // The control's recorded label stays as a hint, because a reworded description may name it differently.
    if (/^click\b/i.test(step.description.trim())) {
      const label = target !== undefined && target.length <= 60 && !step.description.toLowerCase().includes((step.target ?? "").toLowerCase())
        ? ` Its recorded label was ${quoted(step.target ?? "")}.` : "";
      return `${sentence(description)}${label}${repeat}`;
    }
    return target === undefined ? `Complete this action: ${description}.${repeat}` : `Click ${target} to ${intent}.${repeat}`;
  }
  if (step.type === "download") {
    // The browser's download bar is not on the screenshot. The engine reports each download in a
    // "Download started: <file>" message and keeps the file, so the agent only has to not click again.
    // The demonstration's file name usually carries a date, so it identifies the kind of file, not the exact name.
    const file = value === undefined ? "" : ` In the demonstration the file was ${quoted(step.value ?? "")}; the name may differ.`;
    return `${description}: the previous action starts a file download. Reiterate keeps the file; the screen does not show it, and a "Download started" message confirms it. Do not start the download again.${file}`;
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
    const options = multipleChoices(step.value ?? "");
    return options === null
      ? `${description}: in ${field}, choose exactly ${quoted(step.value ?? "")}.`
      : `${description}: in ${field}, select exactly these options and no others: ${options.map(quoted).join(", ")}.`;
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

/** Multi-select values are recorded as a JSON array of option labels. */
function multipleChoices(value: string): string[] | null {
  if (!value.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function clickCount(step: SetupStep): number {
  const count = Number(step.value);
  return Number.isInteger(count) && count > 1 && count <= 50 ? count : 1;
}

function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
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
