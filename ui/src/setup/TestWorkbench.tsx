import { useEffect, useRef } from "react";
import type { TestActivity } from "./host";
import { groupActivityItems, type WorkbenchRun } from "./testRun";

type BrowserView = "idle" | "unavailable" | "opening" | "live" | "closing" | "closed" | "lost" | "ended";

function browserView(run: WorkbenchRun | null): BrowserView {
  if (run === null) return "idle";
  if (run.status !== "running") return "ended";
  if (run.connectionLost) return "lost";
  switch (run.activity?.browser) {
    case undefined:
    case "unavailable": return "unavailable";
    case "starting": return "opening";
    case "live": return run.activity.snapshot ? "live" : "opening";
    case "closing": return "closing";
    case "closed": return "closed";
    case "unknown": return "lost";
  }
}

const barLabels: Record<BrowserView, string> = {
  idle: "Not started",
  unavailable: "No live view",
  opening: "Opening",
  live: "Live · view only",
  closing: "Closing",
  closed: "Browser closed",
  lost: "Connection lost",
  ended: "Browser closed",
};

/**
 * The agent's browser, drawn from the run's own screenshots. The provider's viewer is never embedded here, so its
 * disconnect page cannot appear when the browser closes or the connection drops.
 */
export function TestBrowser(props: { run: WorkbenchRun | null; url: string; passed: boolean; serviceFailure?: boolean; screenIndex?: number | null; onSelectScreen?(index: number): void }): JSX.Element {
  const view = browserView(props.run);
  const screens = props.run?.screens ?? [];
  const index = props.screenIndex == null ? screens.length - 1 : Math.min(props.screenIndex, screens.length - 1);
  const screen = screens[index];
  const snapshot = props.run?.activity?.snapshot?.image ?? null;
  // Only a confirmed closed browser may be called closed; "closing" or a lost state at the end stays as it was.
  const closed = props.run?.activity?.browser === "closed";
  return <section className="test-browser" aria-label="Agent browser">
    <div className="test-browser-bar"><span aria-hidden="true">● ● ●</span><div>{props.run ? props.url : "about:blank"}</div><b>{view === "ended" && !closed ? "Run finished" : barLabels[view]}</b></div>
    {view === "live" ? <div className="browser-snapshot"><img src={snapshot!} alt="Latest screen of the agent’s browser" /></div>
      : view === "ended" && screen ? <><img src={screen.image} alt="Agent browser screen" /><ScreenBar passed={props.passed} stopped={props.run?.failure?.kind === "stopped"} index={index} count={screens.length} onSelect={(next) => props.onSelectScreen?.(Math.max(0, Math.min(screens.length - 1, next)))} /></>
      : <BrowserNotice view={view} closed={closed} reconnecting={props.run?.connectionLost === true} lastScreen={snapshot} serviceFailure={props.serviceFailure === true} />}
  </section>;
}

/**
 * Pages through a finished run's screenshots. The labels are fixed: a screen's recorded note can hold the agent's
 * private reasoning, so it is never shown.
 */
function ScreenBar(props: { passed: boolean; stopped: boolean; index: number; count: number; onSelect(index: number): void }): JSX.Element {
  const final = props.index === props.count - 1;
  return <div className="test-caption">
    <span className={`caption-kind${final ? (props.passed ? " good" : props.stopped ? "" : " bad") : ""}`}>{final ? "Final screen" : "Earlier screen"}</span>
    <p className="caption-summary">{!final ? "A page the agent saw earlier in this run." : props.passed ? "The page when the test passed." : props.stopped ? "The page when you stopped the test." : "The page when the test stopped."}</p>
    <div className="caption-pager" role="group" aria-label="Screens">
      <button type="button" className="icon-button" aria-label="Previous screen" onClick={() => props.onSelect(props.index - 1)} disabled={props.index <= 0}><Chevron direction="left" /></button>
      <span>{props.index + 1} / {props.count}</span>
      <button type="button" className="icon-button" aria-label="Next screen" onClick={() => props.onSelect(props.index + 1)} disabled={final}><Chevron direction="right" /></button>
    </div>
  </div>;
}

function Chevron(props: { direction: "left" | "right" }): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d={props.direction === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function BrowserNotice(props: { view: BrowserView; closed: boolean; reconnecting: boolean; lastScreen: string | null; serviceFailure: boolean }): JSX.Element {
  const [title, detail] = props.view === "idle" ? ["Run the test to watch the agent.", "The agent’s browser appears here while it works through your steps."]
    : props.view === "unavailable" ? ["No live view for this test", "The test keeps running. Its result appears here when it finishes."]
    : props.view === "opening" ? ["Opening the virtual browser.", "The first screen appears as soon as the website loads."]
    : props.view === "closing" ? ["Agent is closing the browser", "Reiterate is saving the result of this test."]
    : props.view === "closed" ? ["Agent closed the browser", "Reiterate is saving the result of this test."]
    : props.view === "lost" && props.reconnecting ? ["Browser connection lost", "Reconnecting. The test keeps running, and its result appears here when it finishes."]
    : props.view === "lost" ? ["Browser connection lost", "Its state is unknown. The test keeps running, and its result appears here when it finishes."]
    : props.serviceFailure ? ["The agent has not opened the website.", "Nothing ran in this browser."]
    : props.closed ? ["Agent closed the browser", "The test has finished."]
    : ["The test has finished", "No screen was kept from this run."];
  const working = props.view === "opening" || props.view === "closing" || props.view === "closed" || props.view === "lost";
  // The last screen stays behind the notice, dimmed and labelled, so it never passes for a live view.
  const lastScreen = props.view === "idle" || props.view === "opening" ? null : props.lastScreen;
  return <div className={`browser-notice${lastScreen ? " browser-notice-over-screen" : ""}`}>
    {lastScreen && <figure><img src={lastScreen} alt="Last screen of the agent’s browser" /><figcaption>Last screen</figcaption></figure>}
    <div className="browser-notice-card" role="status">
      {working && <span className="edit-spinner" aria-hidden="true" />}
      <b>{title}</b>
      <span>{detail}</span>
    </div>
  </div>;
}

const knownKinds = ["stage", "action", "lifecycle"] as const;
const statusLabels: Record<TestActivity["items"][number]["status"], string | null> = {
  started: null,
  executed: null,
  completed: null,
  blocked: "Blocked",
  rejected: "Rejected",
  failed: "Failed",
};

/**
 * What the agent did, as the web agent labels it: stages, browser actions and browser events, oldest first. The
 * agent's own notes are never shown here, and an entry of an unknown kind or status is left out.
 */
export function ActivityLog(props: { run: WorkbenchRun | null }): JSX.Element {
  const run = props.run;
  const running = run?.status === "running";
  const activityItems = run?.activity?.items ?? [];
  const groupedItems = groupActivityItems(activityItems, running).filter((item) => knownKinds.includes(item.kind) && Object.prototype.hasOwnProperty.call(statusLabels, item.status));
  // The feed keeps the latest 200 entries, so its length stops changing; follow the newest entry instead.
  const lastSequence = activityItems.at(-1)?.sequence;
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  // Follow new entries unless the user scrolled up to read earlier ones.
  useEffect(() => {
    const list = listRef.current;
    if (list !== null && followRef.current) list.scrollTop = list.scrollHeight;
  }, [lastSequence, running]);
  useEffect(() => { followRef.current = true; }, [run?.id]);
  const onScroll = (): void => {
    const list = listRef.current;
    if (list !== null) followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  };
  return <div className="activity-log" ref={listRef} onScroll={onScroll} tabIndex={0} role="log" aria-label="Agent activity">
    {run === null ? <p className="activity-empty">What the agent does appears here while it tests your steps.</p>
      : run.activity === undefined ? <p className="activity-empty">{running ? "Live activity isn’t available for this test. The result appears when it finishes." : "Live activity isn’t available for this test."}</p>
      : <ol className="activity-list">
        {groupedItems.map((item) => {
          const label = run.failure?.kind === "stopped" && item.kind === "lifecycle" && item.text === "Stopped by user" ? null : statusLabels[item.status];
          return <li key={item.sequence} className={`activity-item activity-${item.kind}${label ? " activity-problem" : ""}`}>
          <ActivityIcon kind={item.kind} />
          <span>{item.text}</span>
          {label && <em>{label}</em>}
        </li>; })}
        {running && <li className="activity-working"><span className="edit-spinner" aria-hidden="true" />{run.connectionLost ? "Reconnecting…" : "Working"}</li>}
        {!running && run.connectionLost && <li className="activity-empty">The last update couldn’t be read, so this list may be incomplete.</li>}
        {!running && !run.connectionLost && groupedItems.length === 0 && <li className="activity-empty">No activity was recorded for this run.</li>}
      </ol>}
  </div>;
}

function ActivityIcon(props: { kind: "stage" | "action" | "lifecycle" }): JSX.Element {
  const path = props.kind === "action" ? "M4 2.5l8 4.6-3.4 1 2 3.6-1.6.9-2-3.6L4.5 11.4z"
    : props.kind === "stage" ? "M4 13.5V2.5m0 1h7l-1.5 2.5L11 8.5H4"
    : "M2.5 4.5h11v8h-11zM2.5 7h11";
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
