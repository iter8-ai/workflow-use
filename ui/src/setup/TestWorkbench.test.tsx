import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { TestActivity } from "./host";
import { applyTestRunUpdate, groupActivityItems, type WorkbenchRun } from "./testRun";
import { ActivityLog, TestBrowser } from "./TestWorkbench";

const liveUrl = "https://www.browserbase.com/devtools-fullscreen/inspector.html?sessionId=s-1";
const firstScreen = "data:image/png;base64,iVBORw0KGgoAAAA=";
const nextScreen = "data:image/png;base64,iVBORw0KGgoBBBB=";

function activity(update: Partial<TestActivity> = {}): TestActivity {
  return { revision: 1, browser: "live", snapshot: { image: firstScreen, sequence: 1 }, items: [], ...update };
}

function running(update: Partial<WorkbenchRun> = {}): WorkbenchRun {
  return { id: "run-1", status: "running", screens: [], ...update };
}

function browser(run: WorkbenchRun | null, passed = false): string {
  return renderToStaticMarkup(<TestBrowser run={run} url="https://portal.example.test" passed={passed} />);
}

function rail(run: WorkbenchRun | null): string {
  return renderToStaticMarkup(<ActivityLog run={run} />);
}

function action(sequence: number, text: string, status: TestActivity["items"][number]["status"] = "executed"): TestActivity["items"][number] {
  return { sequence, kind: "action", status, text };
}

test("groups one running Wait action into a ticking entry", () => {
  assert.deepEqual(groupActivityItems([action(1, "Wait")], true), [action(1, "Wait 2s…")]);
});

test("finishes a Wait group when another activity follows it", () => {
  assert.deepEqual(groupActivityItems([action(1, "Wait"), action(2, "Wait"), action(3, "Wait"), action(4, "Click")], true), [
    action(1, "Waited 6s"),
    action(4, "Click"),
  ]);
});

test("keeps the newest running Wait group ticking", () => {
  assert.deepEqual(groupActivityItems([action(4, "Wait"), action(5, "Wait"), action(6, "Wait")], true), [action(4, "Wait 6s…")]);
  assert.deepEqual(groupActivityItems([action(4, "Wait"), action(5, "Wait"), action(6, "Wait")], false), [action(4, "Waited 6s")]);
});

test("does not group across a failed Wait action or non-Wait activity", () => {
  const items = [action(1, "Wait"), action(2, "Wait", "failed"), action(3, "Wait"), action(4, "Type")];
  assert.deepEqual(groupActivityItems(items, true), [action(1, "Waited 2s"), action(2, "Wait", "failed"), action(3, "Waited 2s"), action(4, "Type")]);
});

test("does not group across activity entries that the rail omits", () => {
  const hidden = { sequence: 2, kind: "unknown", status: "executed", text: "Hidden" } as unknown as TestActivity["items"][number];
  const html = rail(running({ activity: activity({ items: [action(1, "Wait"), hidden, action(3, "Wait")] }) }));
  assert.match(html, /Waited 2s/);
  assert.match(html, /Wait 2s…/);
  assert.doesNotMatch(html, /Wait 4s…/);
});

test("shows the latest screen of a live browser as a picture, never the provider's viewer", () => {
  const html = browser(running({ activity: activity(), liveViewUrl: liveUrl }));
  assert.match(html, new RegExp(`<img[^>]*src="${firstScreen.replace(/[+/]/g, "\\$&")}"`));
  assert.match(html, /Live · view only/);
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /browserbase/);
});

test("waits for the first screen while the browser starts", () => {
  for (const update of [{ browser: "starting" as const, snapshot: null }, { browser: "live" as const, snapshot: null }]) {
    const html = browser(running({ activity: activity(update) }));
    assert.match(html, /Opening the virtual browser/);
    assert.doesNotMatch(html, /<img/);
  }
});

test("says the agent closed the browser once it is closing or closed, keeping the last screen", () => {
  assert.match(browser(running({ activity: activity({ browser: "closing" }) })), /Agent is closing the browser/);
  const html = browser(running({ activity: activity({ browser: "closed" }) }));
  assert.match(html, /Agent closed the browser/);
  assert.match(html, /Last screen/);
  assert.match(html, /<img[^>]*src="data:image\/png/);
});

test("reports an unexpected browser loss without claiming the browser closed", () => {
  const html = browser(running({ activity: activity({ browser: "unknown" }) }));
  assert.match(html, /Browser connection lost/);
  assert.doesNotMatch(html, /Reconnecting/);
  assert.doesNotMatch(html, /Agent closed the browser/);
  assert.doesNotMatch(html, /Agent is closing/);
});

test("reconnects after a failed status check and keeps the last screen labelled", () => {
  const html = browser({ ...running({ activity: activity() }), connectionLost: true });
  assert.match(html, /Browser connection lost/);
  assert.match(html, /Reconnecting/);
  assert.match(html, /Last screen/);
  assert.doesNotMatch(html, /Live · view only/);
});

test("has no live view without activity data, even when an older host sends a viewer address", () => {
  for (const run of [running({ liveViewUrl: liveUrl }), running({ activity: activity({ browser: "unavailable", snapshot: null }) })]) {
    const html = browser(run);
    assert.match(html, /No live view for this test/);
    assert.doesNotMatch(html, /<iframe/);
  }
});

// Older hosts still send each history screen's raw note; none of it may reach the page.
const privateNotes = [
  "**Private plan**\n\nI will try the admin password hunter2 from the context.",
  '{"status":"blocked","reason":"Context says token sk-live-canary","step":2,"confirmation":"https://www.browserbase.com/devtools?signed=canary"}',
  "Proposed computer actions: type. Safety checks: Enter password hunter2.",
];
const canaries = /Private plan|hunter2|sk-live-canary|signed=canary|browserbase|Safety check|admin password|"status"/;

test("keeps the final screen as evidence with a fixed label, never the agent's notes", () => {
  const screens = privateNotes.map((thought, index) => ({ image: index === 2 ? nextScreen : firstScreen, thought }));
  for (const status of ["failed", "succeeded"] as const) {
    const html = browser({ id: "run-1", status, activity: activity({ browser: "closed" }), screens }, status === "succeeded");
    assert.match(html, new RegExp(`<img[^>]*src="${nextScreen.replace(/[+/]/g, "\\$&")}"`));
    assert.match(html, /Final screen/);
    assert.match(html, /3 \/ 3/);
    assert.match(html, /Browser closed/);
    assert.doesNotMatch(html, canaries);
    assert.doesNotMatch(html, />More</);
  }
});

test("labels an earlier screen without the agent's notes while paging", () => {
  const screens = privateNotes.map((thought) => ({ image: firstScreen, thought }));
  const html = renderToStaticMarkup(<TestBrowser run={{ id: "run-1", status: "failed", screens }} url="https://portal.example.test" passed={false} screenIndex={0} />);
  assert.match(html, /Earlier screen/);
  assert.match(html, /1 \/ 3/);
  assert.match(html, /aria-label="Previous screen" disabled=""/);
  assert.doesNotMatch(html, canaries);
});

test("claims the agent closed the browser only when the browser state is closed", () => {
  for (const status of ["succeeded", "failed"] as const) {
    for (const state of ["closing", "unknown", "live"] as const) {
      const ended = browser({ id: "run-1", status, activity: activity({ browser: state, snapshot: null }), screens: [] });
      assert.doesNotMatch(ended, /Agent closed the browser|Browser closed/, `${status} ${state}`);
      assert.doesNotMatch(browser({ id: "run-1", status, activity: activity({ browser: state }), screens: [{ image: nextScreen }] }), /Browser closed/, `${status} ${state} with screens`);
    }
    let run: WorkbenchRun | null = running({ activity: activity({ revision: 4, browser: "closing" }) });
    run = applyTestRunUpdate(run, "run-1", { status, activity: null, screens: [] });
    assert.doesNotMatch(browser(run), /Agent closed the browser|Browser closed/, `${status} after an unreadable final feed`);
    assert.match(browser({ id: "run-1", status, activity: activity({ browser: "closed", snapshot: null }), screens: [] }), /Agent closed the browser/);
    assert.match(browser({ id: "run-1", status, activity: activity({ browser: "closed" }), screens: [{ image: nextScreen }] }), /Browser closed/);
  }
});

test("an ended run without history screens keeps its last live screen, or says the browser closed", () => {
  assert.match(browser({ id: "run-1", status: "succeeded", activity: activity({ browser: "closed" }), screens: [] }, true), /Last screen/);
  const html = browser({ id: "run-1", status: "succeeded", activity: activity({ browser: "closed", snapshot: null }), screens: [] }, true);
  assert.match(html, /Agent closed the browser/);
  assert.doesNotMatch(browser({ id: "run-1", status: "succeeded", activity: activity({ browser: "unknown", snapshot: null }), screens: [] }, true), /Agent closed the browser/);
});

test("ignores a delayed reply for an earlier run after a rerun", () => {
  const rerun = running({ id: "run-2" });
  assert.equal(applyTestRunUpdate(rerun, "run-1", { status: "running", activity: activity() }), rerun);
  assert.equal(applyTestRunUpdate(null, "run-1", { status: "running", activity: activity() }), null);
});

test("ignores an older revision so a stale reply cannot bring the browser back", () => {
  let run: WorkbenchRun | null = running({ activity: activity({ revision: 5, browser: "closed", snapshot: { image: nextScreen, sequence: 3 } }) });
  run = applyTestRunUpdate(run, "run-1", { status: "running", activity: activity({ revision: 4, browser: "live" }) });
  assert.equal(run?.activity?.browser, "closed");
  assert.equal(run?.activity?.snapshot?.image, nextScreen);
  assert.match(browser(run), /Agent closed the browser/);
});

test("accepts a newer revision, including a browser restart within the run", () => {
  let run: WorkbenchRun | null = running({ activity: activity({ revision: 2, browser: "unknown" }) });
  run = applyTestRunUpdate(run, "run-1", { status: "running", activity: activity({ revision: 3, browser: "starting", snapshot: null }) });
  assert.equal(run?.activity?.browser, "starting");
  assert.equal(run?.activity?.snapshot, null);
});

test("keeps the last activity when the host could not read it, and marks the connection lost", () => {
  let run: WorkbenchRun | null = running({ activity: activity({ revision: 2 }) });
  run = applyTestRunUpdate(run, "run-1", { status: "running", activity: null });
  assert.equal(run?.activity?.revision, 2);
  assert.equal(run?.connectionLost, true);
  run = applyTestRunUpdate(run, "run-1", { status: "running", activity: activity({ revision: 3 }) });
  assert.equal(run?.connectionLost, false);
});

test("keeps only PNG screenshots and the latest twenty", () => {
  const screens = [{ image: "https://tracker.example.test/pixel.png" }, ...Array.from({ length: 22 }, (_, index) => ({ image: `data:image/png;base64,AAAA${index + 1}` }))];
  const run = applyTestRunUpdate(running(), "run-1", { status: "running", screens });
  assert.equal(run?.screens?.length, 20);
  assert.equal(run?.screens?.[0]?.image, "data:image/png;base64,AAAA3");
});

test("drops a snapshot that is not a PNG picture", () => {
  const run = applyTestRunUpdate(running(), "run-1", { status: "running", activity: activity({ snapshot: { image: "https://tracker.example.test/pixel.png", sequence: 1 } }) });
  assert.equal(run?.activity?.snapshot, null);
});

test("lists what the agent did in order, with its outcome in words", () => {
  const html = rail(running({ activity: activity({ items: [
    { sequence: 1, kind: "lifecycle", status: "completed", text: "Browser opened" },
    { sequence: 2, kind: "stage", status: "started", text: "Agent stage" },
    { sequence: 3, kind: "action", status: "executed", text: "Click" },
    { sequence: 4, kind: "action", status: "blocked", text: "Type" },
  ] }) }));
  assert.ok(html.indexOf("Browser opened") < html.indexOf("Agent stage"));
  assert.ok(html.indexOf("Click") < html.indexOf("Type"));
  assert.match(html, /Blocked/);
  assert.match(html, /Working/);
});

test("stops showing progress once the run ends", () => {
  const html = rail({ id: "run-1", status: "failed", activity: activity({ items: [{ sequence: 7, kind: "stage", status: "failed", text: "Agent stage" }] }) });
  assert.match(html, /Failed/);
  assert.doesNotMatch(html, /Working/);
});

test("never shows the agent's raw notes in the activity rail", () => {
  const screens = privateNotes.map((thought) => ({ image: firstScreen, thought }));
  const html = rail({ id: "run-1", status: "succeeded", screens });
  assert.doesNotMatch(html, /Private plan/);
  assert.doesNotMatch(html, /admin password/);
});

test("explains each empty state: before a run, while starting, and without activity data", () => {
  assert.match(rail(null), /appears here while it tests your steps/);
  assert.match(rail(running({ activity: activity() })), /Working/);
  assert.match(rail(running()), /isn’t available for this test/);
  assert.match(rail({ id: "run-1", status: "succeeded", activity: activity() }), /No activity was recorded/);
});

test("omits activity of a kind or status the page does not know", () => {
  const items = [
    { sequence: 1, kind: "debug", status: "executed", text: "Raw payload" },
    { sequence: 2, kind: "action", status: "teleported", text: "Odd status" },
    { sequence: 3, kind: "action", status: "executed", text: "Scroll" },
  ] as unknown as TestActivity["items"];
  const html = rail(running({ activity: activity({ items }) }));
  assert.doesNotMatch(html, /Raw payload/);
  assert.doesNotMatch(html, /Odd status/);
  assert.match(html, /Scroll/);
});

test("says it is reconnecting instead of working while status checks fail", () => {
  const html = rail({ ...running({ activity: activity({ items: [{ sequence: 1, kind: "action", status: "executed", text: "Click" }] }) }), connectionLost: true });
  assert.match(html, /Click/);
  assert.match(html, /Reconnecting/);
  assert.doesNotMatch(html, /Working/);
});

test("says the activity may be incomplete when the final update could not be read", () => {
  let run: WorkbenchRun | null = running({ activity: activity({ revision: 3, items: [{ sequence: 1, kind: "action", status: "executed", text: "Click" }] }) });
  run = applyTestRunUpdate(run, "run-1", { status: "succeeded", activity: null, screens: [] });
  const html = rail(run);
  assert.match(html, /Click/);
  assert.match(html, /may be incomplete/);
  assert.doesNotMatch(rail({ id: "run-1", status: "succeeded", activity: activity({ revision: 4 }) }), /may be incomplete/);
});

test("names a watched run a run in the browser and activity notices", () => {
  const notices = [
    running({ liveViewUrl: liveUrl }),
    running({ activity: activity({ browser: "unknown" }) }),
    { ...running({ activity: activity() }), connectionLost: true },
    running({ activity: activity({ browser: "closing" }) }),
    running({ activity: activity({ browser: "closed" }) }),
    { id: "run-1", status: "succeeded" as const, activity: activity({ browser: "closed", snapshot: null }), screens: [] },
    { id: "run-1", status: "succeeded" as const, screens: [] },
    { id: "run-1", status: "failed" as const, failure: { kind: "stopped" as const, message: "" }, screens: [{ image: firstScreen }] },
  ];
  for (const run of notices) {
    const html = renderToStaticMarkup(<TestBrowser subject="run" run={run} url="https://portal.example.com" passed={run.status === "succeeded"} />);
    assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), /\btest\b/i, JSON.stringify(run));
  }
  assert.match(renderToStaticMarkup(<TestBrowser subject="run" run={running()} url="https://portal.example.test" passed={false} />), /No live view for this run/);
  assert.match(renderToStaticMarkup(<ActivityLog subject="run" run={running()} />), /isn’t available for this run/);
  assert.match(browser(running()), /No live view for this test/);
});
