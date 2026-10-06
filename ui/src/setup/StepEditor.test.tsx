import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { draftChanges, mergeDateSteps, type SetupDraft, type SetupStep } from "./compiler";
import { StepEditor, type StepEditorProps } from "./StepEditor";
import { combineDateSteps, moveStep, openQuestionCount, renameStageAt, revertStage, undoDateMerge } from "./stepList";

const openReports: SetupStep = { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: "The reports list is visible" };
const download: SetupStep = { id: "download", type: "click", description: "Download the statement", target: "Download statement" };

function editor(update: Partial<StepEditorProps> = {}): string {
  const ignore = (): void => undefined;
  return renderToStaticMarkup(<StepEditor steps={[openReports, download]} goal="Download the monthly statement." busy={false} credentialsAllowed savedCredentials={[]}
    onRequestOtp={ignore} onUpdateStep={ignore} onRemoveStep={ignore} onMergeSteps={ignore} onUndoMergedStep={ignore} onMoveStep={ignore} onRenameStage={ignore} onInsert={ignore} {...update} />);
}

function count(html: string, pattern: RegExp): number {
  return html.match(new RegExp(pattern.source, "g"))?.length ?? 0;
}

test("lists the instructions as one numbered list of compact rows", () => {
  const html = editor();
  assert.equal(count(html, /<ol start="1">/), 1);
  assert.equal(count(html, /<li class="review-step">/), 2);
  assert.match(html, /aria-label="Step 1 description"[^>]*>Open the reports section<\/textarea>/);
  assert.match(html, /aria-label="Step 2 description"[^>]*>Download the statement<\/textarea>/);
  assert.equal(count(html, /aria-label="Move step \d up"/), 2);
  assert.equal(count(html, /aria-label="Move step \d down"/), 2);
  assert.equal(count(html, /aria-label="Remove step \d"/), 2);
});

test("shows a set expected outcome and offers the rest behind Add expected outcome", () => {
  const html = editor();
  assert.match(html, /aria-label="Step 1 expected outcome"[^>]*>The reports list is visible<\/textarea>/);
  assert.doesNotMatch(html, /Step 2 expected outcome/);
  assert.equal(count(html, />Add expected outcome<\/button>/), 1);
  assert.equal(count(html, /The agent checks this before moving on/), 2 + 1);
});

test("keeps page navigation outside the editor and offers Insert step inside it", () => {
  const html = editor();
  assert.match(html, />Insert step<\/button>/);
  assert.doesNotMatch(html, /Continue to test|Back to demonstration|Test changes|Re-demonstrate/);
});

test("names a stage by the steps it covers", () => {
  const html = editor({ steps: [{ ...openReports, stage: "Open reports" }, { ...download, stage: "Download" }, { ...download, id: "download-2", stage: "Download" }] });
  assert.match(html, /aria-label="Stage name for step 1"[^>]*value="Open reports"/);
  assert.match(html, /aria-label="Stage name for steps 2–3"[^>]*value="Download"/);
  assert.match(html, /<ol start="2">/);
});

test("disables every control while the page is busy", () => {
  const html = editor({ busy: true, steps: [openReports, download, { id: "month", type: "input", description: "Enter the month", target: "Month", value: "09" }] });
  const controls = html.match(/<(?:textarea|input|select|button)\b[^>]*>/g) ?? [];
  assert.ok(controls.length > 8);
  for (const control of controls) assert.match(control, /disabled=""/, control);
});

test("counts open date and one-time code questions only when sign-in is handled", () => {
  const date: SetupStep = { id: "to", type: "date", description: "Enter the To date", target: "To", date: { value: "2026-09-06", format: "parts", rule: null } };
  const otp: SetupStep = { id: "otp", type: "credential", description: "Enter the saved one-time code in Code", target: "Code", value: "otp" };
  const base = { goal: "Download last month's statement.", savedCredentials: [] };
  assert.equal(openQuestionCount({ ...base, steps: [date, otp], credentialsAllowed: true }), 2);
  assert.equal(openQuestionCount({ ...base, steps: [date, otp], credentialsAllowed: false }), 1);
  assert.equal(openQuestionCount({ ...base, steps: [otp], credentialsAllowed: true, savedCredentials: ["otp"] }), 0);
  assert.match(editor({ steps: [date, otp] }), /2 questions to answer before testing/);
});

test("moves a step past its stage edge into the neighbouring stage and stops at the list edges", () => {
  const steps: SetupStep[] = [{ ...openReports, stage: "Open" }, { ...download, stage: "Get" }];
  assert.deepEqual(moveStep(steps, 1, -1).map((step) => [step.id, step.stage]), [["download", "Open"], ["open-reports", "Open"]]);
  assert.deepEqual(moveStep(steps, 0, 1).map((step) => [step.id, step.stage]), [["download", "Get"], ["open-reports", "Get"]]);
  assert.deepEqual(moveStep(steps, 0, -1), steps);
  assert.deepEqual(moveStep(steps, 1, 1), steps);
});

test("renames only the stage that starts at a step", () => {
  const steps: SetupStep[] = [{ ...openReports, stage: "A" }, { ...download, stage: "B" }, { ...download, id: "d2", stage: "B" }, { ...openReports, id: "o2", stage: "A" }];
  assert.deepEqual(renameStageAt(steps, 1, "Download").map((step) => step.stage), ["A", "Download", "Download", "A"]);
});

test("combines adjacent day, month and year fields into one date step and undoes it exactly", () => {
  const parts: SetupStep[] = [
    { id: "day", type: "input", description: "Enter the day", target: "day", value: "06" },
    { id: "month", type: "input", description: "Enter the month", target: "month", value: "09" },
    { id: "year", type: "input", description: "Enter the year", target: "year", value: "2026" },
  ];
  const steps = [openReports, ...parts, download];
  const combined = combineDateSteps(steps, parts.map((step) => step.id));
  assert.equal(combined.length, 3);
  assert.equal(combined[1]!.type, "date");
  assert.deepEqual(undoDateMerge(combined, combined[1]!.id), steps);
  assert.equal(combineDateSteps(steps, ["day", "year"]), steps);
});

test("keeps an untouched merged date undoable when another step moves and reverts", () => {
  const parts: SetupStep[] = [
    { id: "day", type: "input", description: "Enter the day", target: "day", value: "06", stage: "A" },
    { id: "month", type: "input", description: "Enter the month", target: "month", value: "09", stage: "A" },
    { id: "year", type: "input", description: "Enter the year", target: "year", value: "2026", stage: "A" },
  ];
  const merged = mergeDateSteps(parts)[0]!;
  const ordinary = { ...download, stage: "B" };
  const moved = moveStep([merged, ordinary], 1, -1);
  const reverted = revertStage(moved, [merged, ordinary], ordinary.id);
  assert.equal(reverted[1], merged);
  assert.match(editor({ steps: reverted }), />Undo<\/button>/);
  assert.deepEqual(undoDateMerge(reverted, merged.id), [reverted[0], ...parts]);
});

test("stage changes preserve a merged date's Undo, recorded parts and private marker", () => {
  const parts: SetupStep[] = [
    { id: "day", type: "input", description: "Enter the day", target: "day", value: "06", stage: "A", expectedOutcome: "Date is set" },
    { id: "month", type: "input", description: "Enter the month", target: "month", value: "09", stage: "A" },
    { id: "year", type: "input", description: "Enter the year", target: "year", value: "2026", stage: "A" },
  ];
  const merged = mergeDateSteps(parts)[0]!;
  const ordinary = { ...download, stage: "B" };
  const renamed = renameStageAt([merged, ordinary], 0, "Renamed")[0]!;
  const restored = revertStage([renamed, ordinary], [merged, ordinary], merged.id)[0]!;
  const movedDown = moveStep([merged, ordinary], 0, 1)[1]!;
  const movedUp = moveStep([{ ...ordinary, stage: "A" }, movedDown], 1, -1)[0]!;
  for (const date of [renamed, restored, movedDown, movedUp]) {
    assert.equal(date.uiMerged, true);
    assert.equal(date.expectedOutcome, "Date is set");
    assert.equal(date.parts, merged.parts);
    assert.match(editor({ steps: [date] }), />Undo<\/button>/);
    assert.deepEqual(undoDateMerge([date], date.id), parts);
    assert.equal(JSON.parse(JSON.stringify(date)).uiMerged, undefined);
  }
  assert.equal(renameStageAt([merged], 0, "A")[0], merged);
  assert.equal(revertStage([merged], [merged], merged.id)[0], merged);
  assert.equal(moveStep([merged, { ...ordinary, stage: "A" }], 0, 1)[1], merged);
});

const staged = (steps: SetupStep[]): SetupDraft => ({ name: "Statement", url: "https://portal.example.test", goal: "Download the statement.", steps, inputs: [] });

test("tracks a single-step stage rename as one change and reverts it to a clean draft", () => {
  const live = staged([{ ...openReports, stage: "Open reports" }, { ...download, stage: "Download" }]);
  assert.deepEqual(draftChanges(live, live), []);
  const renamed = { ...live, steps: renameStageAt(live.steps, 1, "Download the statement") };
  assert.deepEqual(draftChanges(renamed, live), [{ key: "step:download:stage", label: "Step 2 stage name", from: "Download", to: "Download the statement" }]);
  const reverted = { ...renamed, steps: revertStage(renamed.steps, live.steps, "download") };
  assert.deepEqual(draftChanges(reverted, live), []);
  assert.deepEqual(reverted.steps, live.steps);
});

test("reverts a multi-step stage rename as one change and keeps other edits to its steps", () => {
  const live = staged([{ ...openReports, stage: "Open" }, { ...download, stage: "Get" }, { ...download, id: "d2", stage: "Get" }]);
  const edited = renameStageAt(live.steps, 1, "Download").map((step) => step.id === "d2" ? { ...step, description: "Save the statement", expectedOutcome: "The file is saved" } : step);
  assert.deepEqual(draftChanges({ ...live, steps: edited }, live).map(({ key, label }) => [key, label]), [
    ["step:d2:description", "Step 3 instruction"],
    ["step:d2:outcome", "Step 3 expected outcome"],
    ["step:download:stage", "Steps 2–3 stage name"],
  ]);
  const reverted = revertStage(edited, live.steps, "download");
  assert.deepEqual(reverted.map((step) => step.stage), ["Open", "Get", "Get"]);
  assert.deepEqual(draftChanges({ ...live, steps: reverted }, live).map(({ key }) => key), ["step:d2:description", "step:d2:outcome"]);
});

test("keeps stage changes apart for same-name neighbouring stages", () => {
  const live = staged([{ ...openReports, stage: "Sign in" }, { ...download, stage: "Download" }, { ...openReports, id: "o2", stage: "Sign in" }]);
  const third = renameStageAt(live.steps, 2, "Log in");
  assert.deepEqual(draftChanges({ ...live, steps: third }, live).map(({ key, from, to }) => [key, from, to]), [["step:o2:stage", "Sign in", "Log in"]]);
  assert.deepEqual(revertStage(third, live.steps, "o2"), live.steps);
  const joined = renameStageAt(live.steps, 1, "Sign in");
  assert.deepEqual(draftChanges({ ...live, steps: joined }, live).map(({ key, label, from, to }) => [key, label, from, to]), [["step:download:stage", "Step 2 stage name", "Download", "Sign in"]]);
  assert.deepEqual(revertStage(joined, live.steps, "download"), live.steps);
});

test("keeps reorder, insertion and removal changes next to a stage change", () => {
  const live = staged([{ ...openReports, stage: "Open" }, { ...download, stage: "Get" }, { ...download, id: "d2", stage: "Get" }]);
  const moved = moveStep(live.steps, 1, -1);
  assert.deepEqual(draftChanges({ ...live, steps: moved }, live).map(({ key }) => key), ["steps", "step:download:stage"]);
  const steps = [...renameStageAt(moved, 2, "Save").filter((step) => step.id !== "open-reports"), { id: "new", type: "agent" as const, description: "Close the dialog" }];
  assert.deepEqual(draftChanges({ ...live, steps }, live).map(({ key }) => key), ["added:new", "removed:open-reports", "step:download:stage", "step:d2:stage"]);
  const reverted = revertStage(steps, live.steps, "d2");
  assert.deepEqual(draftChanges({ ...live, steps: reverted }, live).map(({ key }) => key), ["added:new", "removed:open-reports", "step:download:stage"]);
});
