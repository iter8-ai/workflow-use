import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { TestActivity, TestRun } from "./host";
import { RunView } from "./RunView";
import { pollRun, type WorkbenchRun } from "./testRun";

const screen = "data:image/png;base64,iVBORw0KGgoAAAA=";

function activity(update: Partial<TestActivity> = {}): TestActivity {
  return { revision: 1, browser: "live", snapshot: { image: screen, sequence: 1 }, items: [{ sequence: 1, kind: "action", status: "executed", text: "Click" }], ...update };
}

function view(run: WorkbenchRun | null, update: Partial<Parameters<typeof RunView>[0]> = {}): string {
  return renderToStaticMarkup(<RunView name="Monthly statement" url="https://portal.example.com" run={run} loading={false} loadError={null} readError={null} closeError={null} closing={false} onRetry={() => undefined} onClose={() => undefined} {...update} />);
}

function buttons(html: string): string[] {
  return [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attributes, content]) => /aria-label="([^"]+)"/.exec(attributes!)?.[1] ?? content!.replace(/<[^>]+>/g, ""));
}

test("watches a running run with the setup browser and activity, and no control that changes it", () => {
  const html = view({ id: "run-1", status: "running", activity: activity() });
  assert.match(html, /Monthly statement/);
  assert.match(html, /aria-label="Agent browser"/);
  assert.match(html, /alt="Latest screen of the agent’s browser"/);
  assert.match(html, /role="log" aria-label="Agent activity"/);
  assert.match(html, /Click/);
  assert.match(html, /Working/);
  assert.doesNotMatch(html, /<iframe/);
  assert.deepEqual(buttons(html), ["Back to web agents", "Close run"]);
});

test("speaks of the run, never a test, while it runs or ends", () => {
  const runs: WorkbenchRun[] = [
    { id: "run-1", status: "running" },
    { id: "run-1", status: "running", activity: activity({ browser: "unknown" }) },
    { id: "run-1", status: "running", activity: activity(), connectionLost: true },
    { id: "run-1", status: "running", activity: activity({ browser: "closing" }) },
    { id: "run-1", status: "running", activity: activity({ browser: "closed" }) },
    { id: "run-1", status: "succeeded", activity: activity({ browser: "closed", snapshot: null }), screens: [] },
    { id: "run-1", status: "succeeded", screens: [{ image: screen }] },
    { id: "run-1", status: "failed", failure: { kind: "stopped", message: "You stopped the test." }, screens: [{ image: screen }] },
    { id: "run-1", status: "failed", failure: { kind: "service", message: "The test service is unavailable. Please try again later." }, screens: [] },
    { id: "run-1", status: "failed", failure: { kind: "unknown", message: "The test stopped, but its cause is unknown. Try again." }, screens: [] },
  ];
  // Text only: class names such as test-browser are shared with the setup's own test.
  for (const run of runs) assert.doesNotMatch(view(run).replace(/<[^>]+>/g, " "), /\btests?\b/i, JSON.stringify(run));
});

test("shows a failed run's cause, stopped step and final screen", () => {
  const html = view({ id: "run-1", status: "failed", failure: { kind: "steps", message: "The Export button was missing." }, stoppedAtStep: 3, screens: [{ image: screen }], activity: activity({ browser: "closed" }) });
  assert.match(html, /Run failed/);
  assert.match(html, /A step didn(&#x27;|'|’)t work/);
  assert.match(html, /The Export button was missing\./);
  assert.match(html, /Stopped at step 3/);
  assert.match(html, /Final screen/);
  assert.doesNotMatch(html, /Working/);
});

test("says a stopped run was stopped without claiming who stopped it", () => {
  const html = view({ id: "run-1", status: "failed", failure: { kind: "stopped", message: "You stopped the test." }, screens: [] });
  assert.match(html, /Run stopped/);
  assert.doesNotMatch(html, /You stopped|Stopped by you/);
});

test("links a successful run's files only when they are web addresses", () => {
  const html = view({ id: "run-1", status: "succeeded", confirmation: "Download started: statement.pdf", files: [{ name: "statement.pdf", url: "https://files.example.test/statement.pdf" }, { name: "evil", url: "javascript:alert(1)" }], screens: [] });
  assert.match(html, /Run completed/);
  assert.match(html, /Download started: statement\.pdf/);
  assert.match(html, /<a href="https:\/\/files\.example\.test\/statement\.pdf"[^>]*>statement\.pdf<\/a>/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(view({ id: "run-1", status: "succeeded", screens: [] }), /No result details were returned/);
});

test("explains a run that cannot be opened and offers to try again", () => {
  const html = view(null, { name: null, loadError: "This run no longer exists. It may have been deleted." });
  assert.match(html, /The run couldn(&#x27;|'|’)t be opened/);
  assert.match(html, /This run no longer exists/);
  assert.deepEqual(buttons(html), ["Back to web agents", "Close run", "Try again", "Back to web agents"]);
  assert.match(view(null, { name: null, loading: true }), /Opening the run/);
});

test("shows why the latest update could not be read while it reconnects", () => {
  const html = view({ id: "run-1", status: "running", activity: activity(), connectionLost: true }, { readError: "The request timed out. Retry to continue." });
  assert.match(html, /Reconnecting/);
  assert.match(html, /The latest update couldn(&#x27;|'|’)t be read: The request timed out\. Retry to continue\./);
  assert.doesNotMatch(view({ id: "run-1", status: "running", activity: activity() }), /couldn(&#x27;|'|’)t be read/);
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function deferred(): { promise: Promise<TestRun>; resolve(run: TestRun): void; reject(error: Error): void } {
  let resolve!: (run: TestRun) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<TestRun>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("reads one update at a time and stops once the run finishes", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const reads: ReturnType<typeof deferred>[] = [];
  const seen: TestRun[] = [];
  pollRun(() => { const read = deferred(); reads.push(read); return read.promise; }, (next) => seen.push(next), () => assert.fail("no read failed"));

  assert.equal(reads.length, 0, "the first update came with the run itself");
  mock.timers.tick(2_000);
  assert.equal(reads.length, 1);
  mock.timers.tick(10_000);
  assert.equal(reads.length, 1, "a slow read is never overlapped");
  reads[0]!.resolve({ status: "running" });
  await settle();
  mock.timers.tick(2_000);
  assert.equal(reads.length, 2);
  reads[1]!.resolve({ status: "succeeded" });
  await settle();
  mock.timers.tick(60_000);
  assert.equal(reads.length, 2);
  assert.deepEqual(seen.map((run) => run.status), ["running", "succeeded"]);
});

test("keeps reading after a failed read", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const reads: ReturnType<typeof deferred>[] = [];
  const errors: unknown[] = [];
  pollRun(() => { const read = deferred(); reads.push(read); return read.promise; }, () => undefined, (error) => errors.push(error));

  mock.timers.tick(2_000);
  reads[0]!.reject(new Error("The request timed out."));
  await settle();
  assert.equal(errors.length, 1);
  mock.timers.tick(2_000);
  assert.equal(reads.length, 2);
});

test("ignores a read that settles after the page stops watching", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const reads: ReturnType<typeof deferred>[] = [];
  const seen: unknown[] = [];
  const stop = pollRun(() => { const read = deferred(); reads.push(read); return read.promise; }, (next) => seen.push(next), (error) => seen.push(error));

  mock.timers.tick(2_000);
  stop();
  reads[0]!.resolve({ status: "running" });
  await settle();
  mock.timers.tick(60_000);
  assert.deepEqual(seen, []);
  assert.equal(reads.length, 1);

  const idle = pollRun(() => { const read = deferred(); reads.push(read); return read.promise; }, () => undefined, () => undefined);
  idle();
  mock.timers.tick(60_000);
  assert.equal(reads.length, 1, "stopping before the first read prevents it");
});
