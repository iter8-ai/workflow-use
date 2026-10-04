import type { TestRun } from "./host";

/** A test run as the create and edit pages show it. `connectionLost` is set when the last status check failed. */
export type WorkbenchRun = TestRun & { id: string; connectionLost?: boolean };

const pngImage = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

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
