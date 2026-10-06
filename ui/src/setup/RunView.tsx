import { useEffect, useState } from "react";
import type { HostBridge, WatchedRun } from "./host";
import { applyTestRunUpdate, failureLabel, pollRun, safeFileUrl, type WorkbenchRun } from "./testRun";
import { ActivityLog, TestBrowser } from "./TestWorkbench";

type Target = Omit<WatchedRun, "run">;

/**
 * Watches one existing run of an agent, chosen by the host. The page only reads the run: it offers no action that
 * changes it, and closing it leaves the run going.
 */
export function RunScreen({ bridge }: { bridge: HostBridge }): JSX.Element {
  const [target, setTarget] = useState<Target | null>(null);
  const [run, setRun] = useState<WorkbenchRun | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void bridge.request("loadRun", {}).then(({ run: first, ...loaded }) => {
      if (!active) return;
      setTarget(loaded);
      setRun((current) => applyTestRunUpdate(current ?? { id: loaded.runId, status: first.status }, loaded.runId, first));
      setLoading(false);
    }, (error: unknown) => {
      if (!active) return;
      setLoadError(errorMessage(error));
      setLoading(false);
    });
    return () => { active = false; };
  }, [bridge, attempt]);

  useEffect(() => {
    if (target === null || run?.status !== "running") return;
    const { agentId, runId } = target;
    return pollRun(() => bridge.request("getTestRun", { agentId, runId }), (next) => {
      setReadError(null);
      setRun((current) => applyTestRunUpdate(current, runId, next));
    }, (error) => {
      // The run may still be going: say the connection was lost and keep reading.
      setReadError(errorMessage(error));
      setRun((current) => current?.id === runId ? { ...current, connectionLost: true } : current);
    });
  }, [bridge, target, run?.status]);

  const close = async (): Promise<void> => {
    setClosing(true);
    setCloseError(null);
    try { await bridge.request("close", {}); }
    catch (error) { setCloseError(errorMessage(error)); }
    finally { setClosing(false); }
  };

  return <RunView name={target?.name ?? null} url={target?.url ?? ""} run={run} loading={loading} loadError={loadError} readError={readError} closeError={closeError} closing={closing} onRetry={() => setAttempt((count) => count + 1)} onClose={() => void close()} />;
}

export function RunView(props: {
  name: string | null; url: string; run: WorkbenchRun | null; loading: boolean; loadError: string | null; readError: string | null; closeError: string | null; closing: boolean;
  onRetry(): void; onClose(): void;
}): JSX.Element {
  const [screenIndex, setScreenIndex] = useState<number | null>(null);
  const run = props.run;
  const succeeded = run?.status === "succeeded";
  const kind = run?.failure?.kind;
  const stopped = kind === "stopped";
  const status = run === null ? null : run.status === "running" ? "Running" : succeeded ? "Completed" : stopped ? "Stopped" : "Failed";
  // The host words some causes for its own test; those read wrong for a run, so only their label is shown.
  const message = run?.status === "failed" && kind !== "stopped" && kind !== "service" && kind !== "unknown" ? run.failure?.message || run.error : null;
  const files = (run?.files ?? []).flatMap((file) => { const url = safeFileUrl(file.url); return url ? [{ name: file.name, url }] : []; });
  const lastScreen = run?.screens?.at(-1);
  return <main className="agent-setup edit-agent run-agent">
    <header className="setup-header edit-header">
      <button className="icon-button" aria-label="Back to web agents" title="Back to web agents" disabled={props.closing} onClick={props.onClose}><RunIcon name="back" /></button>
      <div className="edit-heading"><div className="edit-title">
        <h1>{props.name ?? "Web agent run"}</h1>
        {status && <span className="edit-version">{status}</span>}
      </div></div>
      <button className="icon-button" aria-label="Close run" title="Close run" disabled={props.closing} onClick={props.onClose}><RunIcon name="close" /></button>
    </header>
    <section className="edit-layout" aria-busy={props.loading}>
      {props.closeError && <div className="edit-result edit-result-failed" role="alert">{props.closeError}</div>}
      {props.loadError !== null ? <section className="edit-card run-load-error" role="alert" aria-labelledby="run-load-title">
        <h2 id="run-load-title">The run couldn’t be opened</h2><p>{props.loadError}</p>
        <div className="edit-actions"><button className="button button-primary" disabled={props.loading} onClick={props.onRetry}>Try again</button><button className="button button-quiet" disabled={props.closing} onClick={props.onClose}>Back to web agents</button></div>
      </section>
      : run === null ? <p className="edit-status" role="status"><span className="edit-spinner" aria-hidden="true" />Opening the run…</p>
      : <section className="edit-test" aria-label="Agent run"><div className="workbench-grid">
        <TestBrowser subject="run" run={run} url={props.url} passed={succeeded} serviceFailure={kind === "service"} screenIndex={screenIndex} onSelectScreen={setScreenIndex} />
        <div className="edit-test-side">
          <aside className="test-rail" aria-label="Run activity"><header><h3>Agent activity</h3><span>{status}</span></header><ActivityLog subject="run" run={run} /></aside>
          <section className="edit-card run-result" aria-labelledby="run-result-title"><h2 id="run-result-title">Result</h2>
            {run.status === "running" ? <>
              <div className="edit-status" role="status"><span className="edit-spinner" aria-hidden="true" />{run.connectionLost ? "Reconnecting to the run…" : "The agent is working. The result appears here when it finishes."}</div>
              {props.readError && <p className="run-read-error">The latest update couldn’t be read: {props.readError}</p>}
              <p>Closing this page leaves the run going.</p>
            </> : <div className={`edit-result edit-result-${succeeded ? "succeeded" : stopped ? "stopped" : "failed"}`} role={succeeded || stopped ? "status" : "alert"}>
              <b>{succeeded ? "Run completed" : stopped ? "Run stopped" : "Run failed"}</b>
              {run.status === "failed" && !stopped && <b>{failureLabel(kind)}</b>}
              {stopped && <p>The run was stopped before it finished.</p>}
              {message && <p>{message}</p>}
              {run.stoppedAtStep != null && <p>Stopped at step {run.stoppedAtStep}</p>}
              {run.confirmation && <p>{run.confirmation}</p>}
              {files.length > 0 && <ul className="edit-files">{files.map((file) => <li key={file.url}><a href={file.url} target="_blank" rel="noreferrer">{file.name}</a></li>)}</ul>}
              {succeeded && !run.confirmation && files.length === 0 && !lastScreen && <p>The run finished. No result details were returned.</p>}
            </div>}
          </section>
        </div>
      </div></section>}
    </section>
  </main>;
}

function RunIcon({ name }: { name: "back" | "close" }): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none"><path d={name === "back" ? "M19 12H5m6-6-6 6 6 6" : "M6 6l12 12M18 6L6 18"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Something went wrong. Retry to continue.";
}
