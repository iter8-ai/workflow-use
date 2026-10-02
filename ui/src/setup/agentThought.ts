// A finished test sends one free-text `thought` per screenshot. The web agent
// writes it in a few fixed shapes (fire web_agent/adapters/computer.py `_thought`
// and `_task_outcome`, domain/model.py `computer_action_thought`):
//   "Proposed computer actions: click, type."  (+ " Safety checks: …")
//   "**Title**\n\nreasoning summary" blocks, joined by "\n"
//   the final turn's JSON task outcome, alone or after its reasoning
//   "Replayed recorded workflow step."  (deterministic replay)
// Anything else stays plain text.

export const actionLabels = {
  click: "Click",
  double_click: "Double-click",
  move: "Move pointer",
  drag: "Drag",
  scroll: "Scroll",
  type: "Type",
  keypress: "Press keys",
  wait: "Wait",
  screenshot: "Look at the page",
  unknown: "Other action",
} as const;

export type AgentAction = keyof typeof actionLabels;

export const outcomeLabels = {
  completed: "Finished",
  completed_nothing_to_export: "Nothing to export",
  blocked: "Blocked",
  failed: "Failed",
} as const;

export type OutcomeStatus = keyof typeof outcomeLabels;

export type AgentOutcome = { status: OutcomeStatus; reason: string; step: number | null; confirmation: string | null };
export type ReasoningNote = { title: string | null; body: string };

export type AgentThought =
  | { kind: "outcome"; outcome: AgentOutcome; reasoning: ReasoningNote[] }
  | { kind: "reasoning"; reasoning: ReasoningNote[] }
  | { kind: "actions"; actions: AgentAction[]; safetyChecks: string | null }
  | { kind: "replay" }
  | { kind: "text"; text: string }
  | { kind: "empty" };

const actionsPrefix = "Proposed computer actions:";

export function parseAgentThought(raw: string): AgentThought {
  const text = raw.trim();
  if (text === "") return { kind: "empty" };
  if (text === "Replayed recorded workflow step.") return { kind: "replay" };
  if (text.startsWith(actionsPrefix)) {
    const [list = "", safety = ""] = text.slice(actionsPrefix.length).split(" Safety checks:");
    const actions = list.replace(/\.$/, "").split(",").map((item) => item.trim()).filter(Boolean).map(toAction);
    return actions.length > 0 ? { kind: "actions", actions, safetyChecks: safety.trim() || null } : { kind: "empty" };
  }
  // The outcome is the turn's last message: try each line-leading "{" from the end.
  for (let index = text.lastIndexOf("{"); index >= 0; index = index === 0 ? -1 : text.lastIndexOf("{", index - 1)) {
    if (index > 0 && text[index - 1] !== "\n") continue;
    const outcome = parseOutcome(text.slice(index));
    if (outcome) return { kind: "outcome", outcome, reasoning: parseReasoning(text.slice(0, index)) };
  }
  const reasoning = parseReasoning(text);
  return reasoning.some((note) => note.title !== null) ? { kind: "reasoning", reasoning } : { kind: "text", text };
}

function has<T extends object>(labels: T, key: string): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(labels, key);
}

function toAction(value: string): AgentAction {
  return has(actionLabels, value) ? value : "unknown";
}

function parseOutcome(value: string): AgentOutcome | null {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { status, reason, step, confirmation } = parsed as Record<string, unknown>;
  if (typeof status !== "string" || !has(outcomeLabels, status) || typeof reason !== "string") return null;
  return {
    status,
    reason: reason.trim(),
    step: typeof step === "number" && Number.isInteger(step) && step >= 1 ? step : null,
    confirmation: typeof confirmation === "string" && confirmation.trim() !== "" ? confirmation.trim() : null,
  };
}

function parseReasoning(value: string): ReasoningNote[] {
  const notes: ReasoningNote[] = [];
  for (const line of value.split("\n").map((item) => item.trim()).filter(Boolean)) {
    const heading = /^\*\*(.+)\*\*$/.exec(line);
    if (heading) { notes.push({ title: heading[1]!.trim(), body: "" }); continue; }
    if (notes.length === 0) notes.push({ title: null, body: "" });
    const note = notes[notes.length - 1]!;
    note.body = `${note.body} ${line.replace(/\*\*/g, "")}`.trim();
  }
  return notes;
}
