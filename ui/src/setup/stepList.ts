import { groupSteps, mergeDateSteps, openQuestions, type SetupStep } from "./compiler";

/** Open questions block testing: unanswered date rules, and one-time codes when Reiterate handles sign-in. */
export function openQuestionCount(props: { steps: SetupStep[]; goal: string; credentialsAllowed: boolean; savedCredentials: string[] }): number {
  const dates = openQuestions({ name: "", url: "https://example.test", goal: props.goal, steps: props.steps, inputs: [] }, new Date()).length;
  const otp = props.credentialsAllowed ? props.steps.filter((step) => step.type === "credential" && step.value === "otp" && !props.savedCredentials.includes("otp")).length : 0;
  return dates + otp;
}

export function combineDateSteps(steps: SetupStep[], ids: string[]): SetupStep[] {
  const selected = steps.filter((step) => ids.includes(step.id));
  if (selected.length < 2 || selected.length > 3) return steps;
  const first = steps.findIndex((step) => step.id === selected[0]?.id);
  if (first < 0 || selected.some((step, index) => steps[first + index]?.id !== step.id)) return steps;
  const merged = mergeDateSteps(selected, true)[0];
  if (merged?.type !== "date") return steps;
  return [...steps.slice(0, first), merged, ...steps.slice(first + selected.length)];
}

export function undoDateMerge(steps: SetupStep[], id: string): SetupStep[] {
  const index = steps.findIndex((step) => step.id === id);
  const merged = steps[index];
  if (index < 0 || merged?.type !== "date" || merged.parts === undefined) return steps;
  return [...steps.slice(0, index), ...merged.parts, ...steps.slice(index + 1)];
}

export function moveStep(steps: SetupStep[], index: number, delta: number): SetupStep[] {
  const next = [...steps]; const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  const moved = next[index]!, neighbour = next[target]!;
  // A step moved past the edge of its stage joins the stage it moved into.
  next[index] = neighbour; next[target] = moved.stage === neighbour.stage ? moved : { ...moved, stage: neighbour.stage };
  return next;
}

/** Rename the stage that starts at index: every following step with the same stage name. */
export function renameStageAt(steps: SetupStep[], index: number, name: string): SetupStep[] {
  const stage = steps[index]?.stage;
  let end = index;
  while (end < steps.length && steps[end]!.stage === stage) end += 1;
  return steps.map((step, i) => i >= index && i < end ? { ...step, stage: name } : step);
}

/** Restore the published stage names of the stage holding a step, keeping every other edit to its steps. */
export function revertStage(steps: SetupStep[], live: SetupStep[], id: string): SetupStep[] {
  const group = groupSteps(steps).find((item) => item.steps.some(({ step }) => step.id === id));
  return steps.map((step) => {
    const original = live.find((item) => item.id === step.id);
    return original && group?.steps.some((item) => item.step.id === step.id) ? { ...step, stage: original.stage } : step;
  });
}

export function credentialLabel(kind: string | null | undefined): string {
  return kind === "otp" ? "one-time code" : kind ?? "sign-in detail";
}
