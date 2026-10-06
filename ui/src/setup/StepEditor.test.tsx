import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { SetupStep } from "./compiler";
import { StepEditor, type StepEditorProps } from "./StepEditor";
import { combineDateSteps, moveStep, openQuestionCount, renameStageAt, undoDateMerge } from "./stepList";

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
