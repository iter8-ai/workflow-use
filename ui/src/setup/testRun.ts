import type { TestActivity, TestRun } from "./host";

/** `connectionLost` means a status read failed or the host could not read activity, not that the browser closed. */
export type WorkbenchRun = TestRun & { id: string; connectionLost?: boolean };

type ActivityItem = TestActivity["items"][number];

// FIRE: projects/web-agent/src/web_agent/adapters/computer.py uses WAIT_MS = 2000.
const WAIT_SECONDS_PER_ACTION = 2;

function isExecutedWait(item: ActivityItem): boolean {
  return item.kind === "action" && item.status === "executed" && item.text === "Wait";
}

export function groupActivityItems(items: ReadonlyArray<ActivityItem>, running: boolean): ActivityItem[] {
  const grouped: ActivityItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (!isExecutedWait(item)) {
      grouped.push(item);
      continue;
    }
    let end = index;
    while (end + 1 < items.length && isExecutedWait(items[end + 1]!)) end += 1;
    const count = end - index + 1;
    grouped.push({ ...item, text: `${running && end === items.length - 1 ? "Wait" : "Waited"} ${count * WAIT_SECONDS_PER_ACTION}s${running && end === items.length - 1 ? "…" : ""}` });
    index = end;
  }
  return grouped;
}

const pngImage = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

/** A short name for why a run stopped, from the host's failure kind. */
export function failureLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "stopped": return "Stopped by you";
    case "signin": return "Sign-in problem";
    case "google": return "Google sign-in needed";
    case "website": return "Website problem";
    case "steps": return "A step didn't work";
    case "result": return "Result problem";
    case "check": return "Completion check failed";
    case "service": return "Reiterate service problem";
    default: return "Cause unknown";
  }
}

export function safeFileUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null; }
  catch { return null; }
}

/**
 * Reads a run two seconds after the previous read settles, so at most one read is in flight, until a read reports
 * the run finished. The returned function stops reading; a read that settles after it is ignored.
 */
export function pollRun(read: () => Promise<TestRun>, onRead: (next: TestRun) => void, onError: (error: unknown) => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = (): void => {
    void read().then((next) => {
      if (!active) return;
      onRead(next);
      if (next.status === "running") timer = setTimeout(poll, 2_000);
    }, (error: unknown) => {
      if (!active) return;
      onError(error);
      timer = setTimeout(poll, 2_000);
    });
  };
  timer = setTimeout(poll, 2_000);
  return () => {
    active = false;
    clearTimeout(timer);
  };
}

/**
 * Applies a status reply to the run it was requested for. A reply for another run, or an activity revision older
 * than the one shown, is dropped, so a late reply cannot bring back a closed browser or an earlier run's screen.
 */
export function applyTestRunUpdate<R extends WorkbenchRun>(current: R | null, runId: string, next: TestRun): R | null {
  if (current === null || current.id !== runId) return current;
  const incoming = next.activity === undefined ? undefined : next.activity === null ? current.activity : next.activity;
  const activity = incoming && current.activity && incoming.revision < current.activity.revision ? current.activity : incoming;
  return {
    ...current,
    status: next.status,
    stopping: next.status === "running" && (next.stopping === true || current.stopping === true),
    error: next.error,
    failure: next.failure,
    stoppedAtStep: next.stoppedAtStep,
    confirmation: next.confirmation,
    files: next.files ?? [],
    screens: (next.screens ?? []).filter((item) => pngImage.test(item.image)).slice(-20),
    activity: activity && { ...activity, snapshot: activity.snapshot && pngImage.test(activity.snapshot.image) ? activity.snapshot : null },
    connectionLost: next.activity === null,
  };
}
