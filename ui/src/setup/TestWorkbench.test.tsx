import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { TestActivity } from "./host";
import { applyTestRunUpdate, type WorkbenchRun } from "./testRun";
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

test("keeps the final screen as evidence after the run ends", () => {
  const html = browser({ id: "run-1", status: "failed", activity: activity({ browser: "closed" }), screens: [{ image: nextScreen, thought: '{"status":"blocked","reason":"The login was rejected.","step":2,"confirmation":null}' }] });
  assert.match(html, new RegExp(`<img[^>]*src="${nextScreen.replace(/[+/]/g, "\\$&")}"`));
  assert.match(html, /Browser closed/);
  assert.match(html, /The login was rejected\./);
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
  const screens = [{ image: "https://tracker.example.test/pixel.png", thought: "" }, ...Array.from({ length: 22 }, (_, index) => ({ image: firstScreen, thought: `Screen ${index + 1}` }))];
  const run = applyTestRunUpdate(running(), "run-1", { status: "running", screens });
  assert.equal(run?.screens?.length, 20);
  assert.equal(run?.screens?.[0]?.thought, "Screen 3");
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
  const html = rail({ id: "run-1", status: "succeeded", screens: [{ image: firstScreen, thought: "**Private plan**\n\nI will try the admin password." }] });
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
