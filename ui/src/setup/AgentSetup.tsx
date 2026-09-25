import { useEffect, useMemo, useRef, useState } from "react";
import { compileAgent, type SetupDraft, type SetupInput, type SetupStep } from "./compiler";
import { browserbaseLiveViewUrl, createHostBridge, type Recording, type RunArguments, type TestRun } from "./host";
import "./setup.css";

type Screen = "describe" | "demonstrate" | "review" | "test";

type RunState = {
  id: string;
  status: TestRun["status"];
  error?: string;
  files: Array<{ name: string; url: string }>;
  revision: number;
};

const screens: Array<{ id: Screen; label: string }> = [
  { id: "describe", label: "Describe" },
  { id: "demonstrate", label: "Demonstrate" },
  { id: "review", label: "Review" },
  { id: "test", label: "Test" },
];

export default function AgentSetup() {
  const recordingRef = useRef<Recording | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeDialogRef = useRef<HTMLDivElement>(null);
  const [bridge, setBridge] = useState<ReturnType<typeof createHostBridge> | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>("describe");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [privateLogin, setPrivateLogin] = useState(false);
  const [privateLoginAllowed, setPrivateLoginAllowed] = useState(false);
  const [goal, setGoal] = useState("");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [steps, setSteps] = useState<SetupStep[]>([]);
  const [inputs, setInputs] = useState<SetupInput[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [testRun, setTestRun] = useState<RunState | null>(null);
  const [checkedResult, setCheckedResult] = useState(false);
  const [dailySchedule, setDailySchedule] = useState(false);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [cron, setCron] = useState("0 9 * * *");
  const [scheduleAllowed, setScheduleAllowed] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [connected, setConnected] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [testStatusError, setTestStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);

  const draft = useMemo<SetupDraft>(() => ({ name, url, goal, steps, inputs }), [name, url, goal, steps, inputs]);
  const recordingId = recording?.id;
  const recordingStatus = recording?.status;
  const recordingExpiresAt = recording?.expiresAt;
  const liveViewUrl = browserbaseLiveViewUrl(recording?.liveViewUrl ?? null);
  const hasValidSchedule = isFivePartCron(cron);
  const canSchedule = scheduleAllowed
    && testRun?.status === "succeeded"
    && testRun.revision === revision
    && checkedResult
    && dailySchedule
    && hasValidSchedule
    && !busy;
  const canFinish = testRun?.status === "succeeded"
    && testRun.revision === revision
    && checkedResult
    && !dailySchedule
    && !busy;

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Set up web agent | Reiterate";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    if (!confirmClose) {
      return;
    }
    const dialog = closeDialogRef.current;
    const closeButton = closeButtonRef.current;
    const focusable = dialog === null ? [] : Array.from(dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
    focusable[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirmClose(false);
        return;
      }
      if (event.key !== "Tab" || focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      closeButton?.focus();
    };
  }, [confirmClose]);
  const hasAbandonableWork = (name.trim() !== "" || url.trim() !== "" || goal.trim() !== "" || recording !== null || steps.length > 0)
    && !canFinish
    && !scheduleSaved;

  useEffect(() => {
    const next = createHostBridge();
    setBridge(next);
    return () => {
      const current = recordingRef.current;
      if (current && ["recording", "awaiting_login", "verifying_login"].includes(current.status) && next !== null) {
        void next.request("cancelRecording", { id: current.id }).catch(() => undefined);
      }
      next?.destroy();
    };
  }, []);

  useEffect(() => {
    if (bridge === undefined) {
      return;
    }
    if (bridge === null) {
      setConnecting(false);
      return;
    }
    let active = true;
    setConnecting(true);
    setError(null);
    void bridge.request("ready", {}).then((result) => {
      if (!active) {
        return;
      }
      setConnected(true);
      setScheduleAllowed(result.schedule);
      setPrivateLoginAllowed(result.privateLogin === true);
      setConnecting(false);
    }).catch((requestError: Error) => {
      if (active) {
        setError(requestError.message);
        setConnecting(false);
      }
    });
    return () => {
      active = false;
    };
  }, [bridge, connectionAttempt]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    if (bridge === undefined || bridge === null || !recordingId || !recordingStatus || !["recording", "awaiting_login", "verifying_login"].includes(recordingStatus) || busy) {
      return;
    }
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await bridge.request("getRecording", { id: recordingId });
        if (!active) return;
        const safe = discardRecordedValues(next);
        setRecording(safe);
        setSteps(safe.steps);
        setRecordingError(null);
      } catch (requestError) {
        if (active) setRecordingError(errorMessage(requestError));
      } finally {
        pending = false;
      }
    };
    if (pollAttempt > 0) void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [bridge, recordingId, recordingStatus, busy, pollAttempt]);

  useEffect(() => {
    if (!recordingId || !recordingStatus || !recordingExpiresAt || !["awaiting_login", "verifying_login", "recording"].includes(recordingStatus)) return;
    const remaining = Date.parse(recordingExpiresAt) - Date.now();
    const timeout = window.setTimeout(() => {
      setRecording(current => current?.id === recordingId ? { ...current, status: "expired", liveViewUrl: null } : current);
      void bridge?.request("cancelRecording", { id: recordingId }).catch(() => undefined);
    }, Number.isFinite(remaining) ? Math.max(0, remaining) : 0);
    return () => window.clearTimeout(timeout);
  }, [recordingId, recordingStatus, recordingExpiresAt, bridge]);

  useEffect(() => {
    if (bridge === undefined || bridge === null || testRun?.status !== "running" || agentId === null) {
      return;
    }
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await bridge.request("getTestRun", { agentId, runId: testRun.id });
        if (!active) return;
        setTestStatusError(null);
        setTestRun((current) => current === null ? null : {
          ...current,
          status: next.status,
          error: next.error,
          files: next.files ?? [],
        });
      } catch (requestError) {
        if (active) setTestStatusError(errorMessage(requestError));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [agentId, bridge, testRun?.id, testRun?.status, pollAttempt]);

  function invalidateTest(): void {
    setRevision((current) => current + 1);
    setTestRun(null);
    setCheckedResult(false);
    if (testRun !== null) setNotice("Changes require a new test.");
  }

  function setDraftField(setter: (value: string) => void, value: string): void {
    setter(value);
    invalidateTest();
  }

  async function startRecording(): Promise<void> {
    if (bridge === undefined || bridge === null || !connected || busy) {
      return;
    }
    setError(null);
    setNotice(null);
    const urlError = startUrlError(url);
    if (urlError !== null) {
      setError(urlError);
      return;
    }
    if (name.trim() === "" || goal.trim() === "") {
      setError("Add an agent name and goal before starting the demonstration.");
      return;
    }
    setBusy(true);
    try {
      const next = await bridge.request("startRecording", { url, privateLogin: privateLogin && privateLoginAllowed }, {
        onLateResult: (result) => {
          if (isRecording(result)) {
            void bridge.request("cancelRecording", { id: result.id }).catch(() => undefined);
          }
        },
      });
      const safe = discardRecordedValues(next);
      setRecording(safe);
      setRecordingError(null);
      setSteps(safe.steps);
      setScreen("demonstrate");
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function stopRecording(): Promise<void> {
    if (bridge === undefined || bridge === null || recording === null) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.request("stopRecording", { id: recording.id });
      const safe = discardRecordedValues(next);
      setRecording(safe);
      setRecordingError(null);
      setSteps(safe.steps);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  function continueToReview(): void {
    if (recording?.status === "expired") {
      setError("Recording expired. Start a new demonstration to continue.");
      return;
    }
    if (recording?.blockedReason !== null && recording?.blockedReason !== undefined) {
      setError(`Cannot continue: ${recording.blockedReason}`);
      return;
    }
    if (recording?.status !== "stopped") {
      setError("Stop the demonstration before reviewing its steps.");
      return;
    }
    if (steps.length === 0) {
      setError("The demonstration did not capture any usable steps. Try again.");
      return;
    }
    setError(null);
    setScreen("review");
  }

  function updateStep(id: string, updates: Partial<SetupStep>): void {
    setSteps((current) => current.map((step) => step.id === id ? { ...step, ...updates } : step));
    invalidateTest();
  }

  function removeStep(id: string): void {
    setSteps((current) => current.filter((step) => step.id !== id));
    invalidateTest();
  }

  function addInput(): void {
    setInputs((current) => [...current, { name: "", label: "", type: "text", example: "" }]);
    invalidateTest();
  }

  function updateInput(index: number, updates: Partial<SetupInput>): void {
    setInputs((current) => current.map((input, currentIndex) => currentIndex === index ? { ...input, ...updates } : input));
    if (updates.name !== undefined) {
      const previousName = inputs[index]?.name;
      if (previousName !== undefined) {
        setSteps((current) => current.map((step) => step.inputName === previousName ? { ...step, inputName: updates.name } : step));
      }
    }
    invalidateTest();
  }

  function removeInput(index: number): void {
    const removedName = inputs[index]?.name;
    setInputs((current) => current.filter((_, currentIndex) => currentIndex !== index));
    if (removedName !== undefined) {
      setSteps((current) => current.map((step) => step.inputName === removedName ? { ...step, inputName: undefined } : step));
    }
    invalidateTest();
  }

  function continueToTest(): void {
    setError(null);
    try {
      compileAgent(draft);
      setScreen("test");
    } catch (compileError) {
      setError(errorMessage(compileError));
    }
  }

  async function runTest(): Promise<void> {
    if (bridge === undefined || bridge === null || busy || testRun?.status === "running") {
      return;
    }
    setError(null);
    setNotice(null);
    setTestRun(null);
    setCheckedResult(false);
    setTestStatusError(null);
    let config: ReturnType<typeof compileAgent>;
    try {
      config = compileAgent(draft);
    } catch (compileError) {
      setError(errorMessage(compileError));
      return;
    }
    setBusy(true);
    try {
      const saved = await bridge.request("saveAgent", { draft, config, agentId: agentId ?? undefined });
      setAgentId(saved.id);
      const started = await bridge.request("testAgent", { agentId: saved.id, arguments: exampleArguments(inputs) });
      setTestRun({ id: started.id, status: "running", files: [], revision });
      setCheckedResult(false);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function schedule(): Promise<void> {
    if (bridge === undefined || bridge === null) {
      return;
    }
    setError(null);
    if (agentId === null || testRun === null || !dailySchedule || !hasValidSchedule || !canSchedule) return;
    setBusy(true);
    try {
      await bridge.request("scheduleAgent", {
        agentId,
        runId: testRun.id,
        arguments: exampleArguments(inputs),
        cron: dailySchedule ? cron.trim() : "",
      });
      setScheduleSaved(true);
      setNotice(null);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function reset(): Promise<void> {
    if (bridge === undefined || bridge === null) return;
    setBusy(true);
    setError(null);
    try {
      if (recording !== null) await bridge.request("cancelRecording", { id: recording.id });
      setScreen("describe");
      setRecording(null);
      setRecordingError(null);
      setTestStatusError(null);
      setSteps([]);
      setInputs([]);
      setTestRun(null);
      setCheckedResult(false);
      setScheduleSaved(false);
      setNotice(null);
      setRevision((current) => current + 1);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function close(): Promise<void> {
    if (bridge === undefined || bridge === null) {
      return;
    }
    setBusy(true);
    try {
      await bridge.request("close", { agentId: agentId ?? undefined });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  function requestClose(): void {
    if (hasAbandonableWork) {
      setConfirmClose(true);
      return;
    }
    void close();
  }

  const currentIndex = scheduleSaved ? screens.length : screens.findIndex((item) => item.id === screen);
  const stageKey = scheduleSaved ? "done" : screen;
  const contentRef = useRef<HTMLElement>(null);
  const [shownIndex, setShownIndex] = useState(currentIndex);
  const [direction, setDirection] = useState<"forward" | "back" | "none">("none");
  if (shownIndex !== currentIndex) {
    setShownIndex(currentIndex);
    setDirection(currentIndex > shownIndex ? "forward" : "back");
  }

  useEffect(() => {
    if (direction === "none") return;
    const content = contentRef.current;
    if (content === null) return;
    content.scrollTop = 0;
    content.querySelector<HTMLElement>(".stage h2")?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per stage change
  }, [stageKey]);
  if (bridge === undefined) {
    return <main className="setup-unavailable"><p>Connecting to Reiterate</p></main>;
  }

  if (bridge === null) {
    return <main className="setup-unavailable"><h1>Open agent setup from Reiterate</h1><p>This page needs the Reiterate host to securely create and test an agent.</p></main>;
  }


  return (
    <main className="agent-setup">
      <header className="setup-header">
        <h1 className="setup-title">Set up your agent</h1>
        <nav aria-label="Agent setup progress" className="setup-progress">
          <ol>
            {screens.map((item, index) => {
              const state = index === currentIndex ? "current" : index < currentIndex ? "complete" : "upcoming";
              return <li className={`progress-item ${state}`} key={item.id} aria-current={state === "current" ? "step" : undefined}>
                <span className="progress-marker" aria-hidden="true" key={state}>{state === "complete" ? <CheckCircleIcon size={20} /> : index + 1}</span>
                <span className="progress-label">{item.label}{state === "complete" && <span className="visually-hidden"> (done)</span>}</span>
              </li>;
            })}
          </ol>
        </nav>
        <div className="setup-header-end"><button className="button button-text setup-close" type="button" ref={closeButtonRef} onClick={requestClose} disabled={busy}>Close setup</button></div>
      </header>
      <section ref={contentRef} className={`setup-content setup-content-${stageKey}`} aria-busy={busy}>
        {(connecting || (!connecting && !connected) || recordingError !== null || testStatusError !== null || error !== null || notice !== null) && <div className="setup-messages">
          {connecting && <p className="setup-status" role="status"><span className="spinner" aria-hidden="true" /><span>Connecting to Reiterate</span></p>}
          {!connecting && !connected && <div className="setup-actions"><button className="button button-quiet" type="button" onClick={() => setConnectionAttempt((current) => current + 1)}>Retry connection</button></div>}
          {(recordingError !== null || testStatusError !== null) && <div className="setup-error" role="alert"><span>{recordingError !== null ? "Could not refresh the demonstration." : "Could not refresh the test result."} {recordingError ?? testStatusError} Retrying automatically.</span><button className="button button-text button-small" type="button" onClick={() => setPollAttempt((current) => current + 1)}>Retry status</button></div>}
          {error !== null && <div className="setup-error" role="alert"><span>{error}</span><button type="button" className="button button-text button-small" onClick={() => setError(null)}>Dismiss</button></div>}
          {notice !== null && <p className="setup-notice" role="status">{notice}</p>}
        </div>}
        <div className={`stage stage-${direction}`} key={stageKey}>
          {screen === "describe" && <Describe privateLogin={privateLogin} privateLoginAllowed={privateLoginAllowed} onPrivateLogin={setPrivateLogin} name={name} url={url} goal={goal} busy={busy || !connected} onName={(value) => setDraftField(setName, value)} onUrl={(value) => setDraftField(setUrl, value)} onGoal={(value) => setDraftField(setGoal, value)} onContinue={() => void startRecording()} />}
          {screen === "demonstrate" && <Demonstrate privateLogin={privateLogin && privateLoginAllowed} startUrl={url} recording={recording} steps={steps} liveViewUrl={liveViewUrl} busy={busy} onStop={() => void stopRecording()} onReview={continueToReview} onReset={() => void reset()} />}
          {screen === "review" && <Review name={name} url={url} goal={goal} onName={(value) => setDraftField(setName, value)} onGoal={(value) => setDraftField(setGoal, value)} steps={steps} inputs={inputs} busy={busy} onUpdateStep={updateStep} onRemoveStep={removeStep} onAddInput={addInput} onUpdateInput={updateInput} onRemoveInput={removeInput} onBack={() => setScreen("demonstrate")} onContinue={continueToTest} />}
          {screen === "test" && !scheduleSaved && <Test run={testRun} checked={checkedResult} canFinish={canFinish} canSchedule={canSchedule} scheduleAllowed={scheduleAllowed} dailySchedule={dailySchedule} cron={cron} scheduleValid={hasValidSchedule} busy={busy} onRun={() => void runTest()} onCheck={setCheckedResult} onDaily={setDailySchedule} onCron={setCron} onSchedule={() => void schedule()} onFinish={() => void close()} onBack={() => setScreen("review")} />}
          {scheduleSaved && <div className="setup-panel setup-done">
            <div className="panel-body">
              <span className="setup-done-mark" aria-hidden="true"><CheckIcon size={24} /></span>
              <div className="panel-intro"><h2 tabIndex={-1}>Your agent is ready</h2><p>The daily schedule is saved. It will repeat the tested workflow at {scheduleTimeLabel(cron)} UTC.</p></div>
              <button className="button button-primary" type="button" onClick={() => void close()} disabled={busy}>Open agent</button>
            </div>
          </div>}
        </div>
      </section>
      {confirmClose && <div className="close-confirmation" role="dialog" aria-modal="true" aria-labelledby="close-setup-title" aria-describedby="close-setup-description"><div className="close-confirmation-card" ref={closeDialogRef}><h2 id="close-setup-title">Leave setup?</h2><p id="close-setup-description">Changes in this setup have not been saved. Any agent you saved by running a test remains available.</p><div className="setup-actions"><button className="button button-text" type="button" onClick={() => setConfirmClose(false)} disabled={busy}>Keep editing</button><button className="button button-primary" type="button" onClick={() => void close()} disabled={busy}>Close setup</button></div></div></div>}
    </main>
  );
}

/* Icons follow the MUI outlined set the Web agents page uses (CheckCircleOutlined, DangerousOutlined, InfoOutlined, RemoveCircleOutline, Add). */
function CheckIcon({ size = 16 }: { size?: number }): JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" /></svg>;
}

function CheckCircleIcon({ size = 20 }: { size?: number }): JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.59 7.58 10 14.17l-3.59-3.58L5 12l5 5 8-8zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8" /></svg>;
}

function DangerousIcon({ size = 20 }: { size?: number }): JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27zM19 14.9 14.9 19H9.1L5 14.9V9.1L9.1 5h5.8L19 9.1z" /><path d="M14.83 7.76 12 10.59 9.17 7.76 7.76 9.17 10.59 12l-2.83 2.83 1.41 1.41L12 13.41l2.83 2.83 1.41-1.41L13.41 12l2.83-2.83z" /></svg>;
}

function LockIcon({ size = 16 }: { size?: number }): JSX.Element {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2M9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9zm9 14H6V10h12zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2" /></svg>;
}

function FileIcon(): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 9h-4V3H9v6H5l7 7zM5 18v2h14v-2z" /></svg>;
}

function RemoveIcon(): JSX.Element {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 11v2h10v-2zm5-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8" /></svg>;
}

function AddIcon(): JSX.Element {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" /></svg>;
}

function CredentialNote({ privateLogin }: { privateLogin: boolean }): JSX.Element {
  return <p className="credential-note"><LockIcon /><span>Do not enter logins, passwords, one-time codes, or API keys. {privateLogin ? "Sign-in is handled privately in Reiterate before recording." : "Credential-required tasks cannot yet be taught."}</span></p>;
}

function Describe(props: { privateLogin: boolean; privateLoginAllowed: boolean; onPrivateLogin(value: boolean): void; name: string; url: string; goal: string; busy: boolean; onName(value: string): void; onUrl(value: string): void; onGoal(value: string): void; onContinue(): void }): JSX.Element {
  return <div className="setup-panel">
    <div className="panel-body">
      <div className="panel-intro"><h2 tabIndex={-1}>Describe the job</h2><p>Start with the website and the result you want. You will demonstrate the task next.</p></div>
      <div className="field-group">
        <label className="field-label">Agent name<input disabled={props.busy} aria-label="Agent name" value={props.name} onChange={(event) => props.onName(event.target.value)} placeholder="For example: Neteller transactions" autoComplete="off" /></label>
        <label className="field-label">Website address<input disabled={props.busy} aria-label="Website address" value={props.url} onChange={(event) => props.onUrl(event.target.value)} placeholder="https://example.com" inputMode="url" autoComplete="off" /></label>
        <label className="field-label">What should the agent do?<textarea disabled={props.busy} aria-label="What should the agent do?" value={props.goal} onChange={(event) => props.onGoal(event.target.value)} placeholder="For example: download transactions for the current month, using the date filter." /></label>
        {props.privateLoginAllowed && <div className="field">
          <label className="check"><input type="checkbox" disabled={props.busy} checked={props.privateLogin} onChange={event => props.onPrivateLogin(event.target.checked)} />This website requires sign-in</label>
          <p className="check-help">You sign in privately in Reiterate first. Credentials are never passed to the agent.</p>
        </div>}
      </div>
      <CredentialNote privateLogin={props.privateLogin} />
    </div>
    <div className="action-bar"><p className="setup-footer">Public project: <a href="https://github.com/iter8-ai/workflow-use" target="_blank" rel="noreferrer">Source code</a><a href="https://github.com/iter8-ai/workflow-use/blob/main/LICENSE" target="_blank" rel="noreferrer">AGPL-3.0 license</a></p><span className="actions-spacer" /><button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy}>Continue to demonstration</button></div>
  </div>;
}

function Demonstrate(props: { privateLogin: boolean; startUrl: string; recording: Recording | null; steps: SetupStep[]; liveViewUrl: string | null; busy: boolean; onStop(): void; onReview(): void; onReset(): void }): JSX.Element {
  const [stepsOpen, setStepsOpen] = useState(true);
  const listRef = useRef<HTMLElement>(null);
  const previousCount = useRef(props.steps.length);
  const isRecording = props.recording?.status === "recording";
  const pendingLogin = props.recording?.status === "awaiting_login" || props.recording?.status === "verifying_login";
  const expired = props.recording?.status === "expired";
  const blocked = props.recording?.blockedReason != null;
  const stopped = props.recording?.status === "stopped";
  const empty = stopped && props.steps.length === 0;
  const canReview = stopped && !blocked && !empty;
  const failed = expired || blocked || empty;
  const state = pendingLogin ? "Waiting for private sign-in" : expired ? "Demonstration expired" : blocked ? "Demonstration blocked" : isRecording ? "Recording in progress" : "Demonstration finished";
  const stateClass = isRecording && !blocked ? "recording-state-active" : canReview ? "recording-state-done" : failed ? "recording-state-failed" : "";
  const showBrowser = isRecording && !blocked;
  const failure = blocked ? `Cannot continue: ${props.recording?.blockedReason ?? ""} Start over to record a supported task.` : expired ? "Recording expired. Start a new demonstration." : empty ? "No usable steps were recorded. Start over and demonstrate the task before finishing." : null;

  // Follow new steps while recording, unless the user has scrolled up to read earlier ones.
  useEffect(() => {
    const list = listRef.current;
    const grew = previousCount.current > 0 && props.steps.length > previousCount.current;
    previousCount.current = props.steps.length;
    if (!isRecording || !grew || list === null) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 96;
    if (nearBottom) list.scrollTo({ top: list.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [props.steps.length, isRecording]);

  return <div className="setup-panel demonstrate">
    <h2 className="visually-hidden" tabIndex={-1}>Demonstrate the task</h2>
    <div className="demo-toolbar">
      <div className={`recording-state ${stateClass}`} role="status"><span aria-hidden="true" />{state}</div>
      <span className="browser-address" title={props.startUrl}>{displayAddress(props.startUrl)}</span>
      <span className="actions-spacer" />
      <button className="button button-text button-small steps-toggle" type="button" aria-expanded={stepsOpen} aria-controls="captured-steps" onClick={() => setStepsOpen((open) => !open)}>{stepsOpen ? "Hide steps" : `Show steps (${props.steps.length})`}</button>
      <span className="toolbar-divider" aria-hidden="true" />
      <button className="button button-quiet button-small" type="button" onClick={props.onReset} disabled={props.busy}>Start over</button>
      {isRecording && !blocked ? <button className="button button-primary button-small" type="button" onClick={props.onStop} disabled={props.busy}>Finish demonstration</button> : <button className="button button-primary button-small" type="button" onClick={props.onReview} disabled={props.busy || !canReview}>Continue to review</button>}
    </div>
    <div className={`demonstration-grid${stepsOpen ? "" : " steps-hidden"}`}>
      <div className="browser-frame">
        {showBrowser ? <LiveBrowser key={props.recording?.id} url={props.liveViewUrl} /> : <div className={`browser-placeholder${failure !== null ? " browser-placeholder-failed" : ""}`}>
          <span className="placeholder-icon" aria-hidden="true">{pendingLogin ? <LockIcon size={20} /> : canReview ? <CheckIcon size={20} /> : <DangerousIcon />}</span>
          {failure !== null ? <p role="alert">{failure}</p> : <p>{pendingLogin ? "Complete private sign-in in Reiterate. Recording is off while you sign in and verify the fresh session." : "Demonstration finished. Review the recorded steps to continue."}</p>}
        </div>}
      </div>
      <aside id="captured-steps" ref={listRef} className={`captured-steps${isRecording ? " captured-steps-live" : ""}`} aria-label="Captured demonstration steps" tabIndex={0} hidden={!stepsOpen}>
        <h3>Recorded steps <span className="step-count" aria-label={`${props.steps.length} steps`}>{props.steps.length}</span></h3>
        {props.steps.length === 0 ? <p>{isRecording ? "Actions will appear here while you demonstrate." : pendingLogin ? "Recording starts after you sign in." : "No steps were recorded."}</p> : <ol>{props.steps.map((step) => <li key={step.id}>{step.description}</li>)}</ol>}
        <div className="captured-steps-foot"><CredentialNote privateLogin={props.privateLogin} /></div>
      </aside>
    </div>
  </div>;
}

function LiveBrowser({ url }: { url: string | null }): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setSlow(false);
    const timeout = window.setTimeout(() => setSlow(true), 15_000);
    return () => window.clearTimeout(timeout);
  }, [url, attempt]);
  return <div className="live-browser">
    {url !== null && <button className="button button-quiet button-small browser-reload" type="button" onClick={() => setAttempt((current) => current + 1)}>Reload browser</button>}
    <div className="browser-viewport">
      {(!loaded || url === null) && <div className="browser-loading" role="status">
        {!slow && <span className="spinner" aria-hidden="true" />}
        <p>{slow ? url === null ? "The virtual browser is unavailable. Start over to open a new session." : "The browser frame is taking longer than expected. Reload the browser, or start over if the session is unavailable." : "Opening the virtual browser. This can take a few seconds."}</p>
      </div>}
      {url !== null && <iframe className={loaded ? "is-loaded" : undefined} key={attempt} title="Virtual browser" src={url} onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setSlow(true); }} />}
    </div>
  </div>;
}

function Review(props: { name: string; url: string; goal: string; onName(value: string): void; onGoal(value: string): void; steps: SetupStep[]; inputs: SetupInput[]; busy: boolean; onUpdateStep(id: string, updates: Partial<SetupStep>): void; onRemoveStep(id: string): void; onAddInput(): void; onUpdateInput(index: number, updates: Partial<SetupInput>): void; onRemoveInput(index: number): void; onBack(): void; onContinue(): void }): JSX.Element {
  return <div className="setup-panel">
    <div className="panel-body">
    <div className="panel-intro"><h2 tabIndex={-1}>Review the draft</h2><p>Make the instructions clear and choose each form value deliberately.</p></div>
    <section className="setup-section" aria-labelledby="review-details-heading">
      <div className="section-heading"><h3 id="review-details-heading">Agent details</h3></div>
      <div>
        <label className="detail-row"><span>Agent name</span><input value={props.name} onChange={(event) => props.onName(event.target.value)} disabled={props.busy} autoComplete="off" /></label>
        <label className="detail-row detail-row-top"><span>What should the agent do?</span><textarea value={props.goal} onChange={(event) => props.onGoal(event.target.value)} disabled={props.busy} /></label>
        <div className="detail-row detail-row-top">
          <label htmlFor="recorded-start-address">Recorded starting address</label>
          <div className="field"><input id="recorded-start-address" value={props.url} readOnly /><p className="field-help">Fixed by the demonstration. To change it, go back and start over.</p></div>
        </div>
      </div>
    </section>
    <section className="setup-section" aria-labelledby="review-steps-heading">
      <div className="section-heading"><div><h3 id="review-steps-heading">Steps</h3><p>The agent follows these in order. Describe what each step is for, not only where to click.</p></div></div>
      {props.steps.length === 0 ? <p className="empty-steps" role="status">No steps remain. Go back to the demonstration and start over to capture the task again.</p> : <ol className="review-steps">
        {props.steps.map((step, index) => <li className="review-step" key={step.id}>
          <span className="review-step-number" aria-hidden="true">{index + 1}</span>
          <div className="review-step-body">
            <div className="item-heading">
              <h4 className="visually-hidden">Step {index + 1}</h4>
              {step.type === "navigation" ? <p className="recorded-target">Recorded destination: {step.url ?? step.target ?? step.description}</p> : step.target != null ? <p className="recorded-target">Recorded target: {step.target}</p> : <span />}
              <button type="button" className="icon-button" onClick={() => props.onRemoveStep(step.id)} disabled={props.busy} aria-label={`Remove step ${index + 1}`} title="Remove step"><RemoveIcon /></button>
            </div>
            {step.type === "key_press" && step.value != null && <p className="recorded-target">Recorded key: {step.value}</p>}
            <div className="field-grid">
              <label className="field-label">Description<textarea aria-label={`Step ${index + 1} description`} value={step.description} onChange={(event) => props.onUpdateStep(step.id, { description: event.target.value })} disabled={props.busy} /></label>
              <label className="field-label">Expected outcome<textarea aria-label={`Step ${index + 1} expected outcome`} value={step.expectedOutcome ?? ""} onChange={(event) => props.onUpdateStep(step.id, { expectedOutcome: event.target.value || undefined })} disabled={props.busy} placeholder="Optional. For example: the reports list is visible." /></label>
            </div>
            {(step.type === "input" || step.type === "select_change") && <div className="value-source dense">
              <p>Recorded form values are discarded. Choose a fixed value or reusable input.</p>
              <label className="field-label">Value source<select aria-label={`Step ${index + 1} value source`} value={step.inputName ?? (step.value !== undefined && step.value !== null ? "__literal" : "")} onChange={(event) => event.target.value === "__literal" ? props.onUpdateStep(step.id, { value: "", inputName: undefined }) : event.target.value === "" ? props.onUpdateStep(step.id, { value: undefined, inputName: undefined }) : props.onUpdateStep(step.id, { value: undefined, inputName: event.target.value })} disabled={props.busy}><option value="">Choose a value</option><option value="__literal">Fixed value</option>{props.inputs.filter((input) => input.name !== "").map((input, inputIndex) => <option value={input.name} key={`${input.name}-${inputIndex}`}>{input.label || input.name}</option>)}</select></label>
              {step.inputName === undefined && step.value !== undefined && step.value !== null && <label className="field-label">Fixed value<input aria-label={`Step ${index + 1} fixed value`} value={step.value} onChange={(event) => props.onUpdateStep(step.id, { value: event.target.value })} disabled={props.busy} autoComplete="off" /></label>}
            </div>}
          </div>
        </li>)}
      </ol>}
    </section>
    <section className="setup-section" aria-labelledby="reusable-inputs-heading">
      <div className="section-heading"><div><h3 id="reusable-inputs-heading">Reusable inputs</h3><p>Values that change between runs, such as a month or account. Examples are used for the test and any schedule.</p></div></div>
      {props.inputs.length > 0 && <div className="variables-table dense" role="group" aria-label="Reusable inputs">
        <div className="variable-row variable-head" aria-hidden="true"><span>Label</span><span>Name</span><span>Type</span><span>Example</span><span /></div>
        {props.inputs.map((input, index) => <div className="variable-row" key={index}>
          <input aria-label={`Input ${index + 1} label`} value={input.label} onChange={(event) => props.onUpdateInput(index, { label: event.target.value })} disabled={props.busy} placeholder="Statement month" autoComplete="off" />
          <input aria-label={`Input ${index + 1} name`} value={input.name} onChange={(event) => props.onUpdateInput(index, { name: event.target.value })} disabled={props.busy} placeholder="statement_month" autoComplete="off" spellCheck={false} />
          <select aria-label={`Input ${index + 1} type`} value={input.type} onChange={(event) => props.onUpdateInput(index, { type: event.target.value as SetupInput["type"] })} disabled={props.busy}><option value="text">Text</option><option value="date">Date</option><option value="number">Number</option></select>
          <input aria-label={`Input ${index + 1} example`} type={input.type} value={input.example} onChange={(event) => props.onUpdateInput(index, { example: event.target.value })} disabled={props.busy} autoComplete="off" placeholder="Example" />
          <button type="button" className="icon-button" onClick={() => props.onRemoveInput(index)} disabled={props.busy} aria-label={`Remove input ${index + 1}`} title="Remove input"><RemoveIcon /></button>
        </div>)}
      </div>}
      <div className={props.inputs.length > 0 ? "variables-add" : ""}><button type="button" className="button button-primary button-small" onClick={props.onAddInput} disabled={props.busy}><AddIcon />Add reusable input</button></div>
    </section>
    </div>
    <div className="action-bar"><button className="button button-quiet" type="button" onClick={props.onBack} disabled={props.busy}>Back to demonstration</button><span className="actions-spacer" /><button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy || props.steps.length === 0}>Continue to test</button></div>
  </div>;
}

function Test(props: { run: RunState | null; checked: boolean; canFinish: boolean; canSchedule: boolean; scheduleAllowed: boolean; dailySchedule: boolean; cron: string; scheduleValid: boolean; busy: boolean; onRun(): void; onCheck(value: boolean): void; onDaily(value: boolean): void; onCron(value: string): void; onSchedule(): void; onFinish(): void; onBack(): void }): JSX.Element {
  const testRunning = props.run?.status === "running";
  const testFailed = props.run?.status === "failed";
  const testSucceeded = props.run?.status === "succeeded";
  const [minute, hour] = props.cron.split(" ");
  const dailyTime = props.scheduleValid ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : "";
  function changeTime(value: string): void {
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)) {
      props.onCron("");
      return;
    }
    const [hours, minutes] = value.split(":");
    props.onCron(`${Number(minutes)} ${Number(hours)} * * *`);
  }
  const resultClass = testSucceeded ? " test-result-succeeded" : testFailed ? " test-result-failed" : "";
  return <div className="setup-panel">
    <div className="panel-body">
    <div className="panel-intro"><h2 tabIndex={-1}>Test a fresh run</h2><p>Reiterate runs the saved draft in a new browser session. Check the output, then finish setup or choose a daily schedule.</p></div>
    <section className="setup-section" aria-label="Test result">
      <div className={`test-result${resultClass}`} aria-live="polite" key={props.run?.status ?? "idle"}>
        {props.run === null && <><p className="test-result-heading">Not tested yet</p><p>Run a test after each change.</p></>}
        {testRunning && <p className="test-result-heading"><span className="spinner" aria-hidden="true" />Test is running.</p>}
        {testSucceeded && <>
          <p className="test-result-heading"><CheckCircleIcon />Test completed</p>
          {props.run?.files.length === 0 ? <p>No files were returned. Check the result on the website before confirming. If you expected a download, review the instructions and test again.</p> : <ul className="test-files">{props.run?.files.map((file) => <li key={file.url}><a href={file.url} target="_blank" rel="noreferrer"><FileIcon />{file.name}</a></li>)}</ul>}
        </>}
        {testFailed && <><p className="test-result-heading"><DangerousIcon />Test failed</p><p role="alert">{props.run?.error ?? "The test failed."}</p></>}
      </div>
      {testSucceeded && <label className="check"><input aria-label="I checked the result" type="checkbox" checked={props.checked} onChange={(event) => props.onCheck(event.target.checked)} />I checked the result</label>}
    </section>
    {props.scheduleAllowed && <section className="setup-section" aria-labelledby="schedule-heading">
      <div className="section-heading"><div><h3 id="schedule-heading">Schedule</h3><p>Daily runs repeat the tested workflow. You can finish setup without a schedule.</p></div></div>
      <label className="check"><input aria-label="Schedule daily" type="checkbox" checked={props.dailySchedule} onChange={(event) => props.onDaily(event.target.checked)} />Schedule daily</label>
      {props.dailySchedule && <div>
        <label className="detail-row dense"><span>Time of day (UTC)</span><span className="field"><input type="time" aria-label="Time of day (UTC)" value={dailyTime} onChange={(event) => changeTime(event.target.value)} />{!props.scheduleValid && <span className="field-hint">Choose a time for the daily run.</span>}</span></label>
      </div>}
    </section>}
    </div>
    <div className="action-bar">
      <button className="button button-quiet" type="button" onClick={props.onBack} disabled={props.busy || testRunning}>Back to review</button>
      <span className="actions-spacer" />
      <button className={`button ${testSucceeded ? "button-quiet" : "button-primary"}`} type="button" onClick={props.onRun} disabled={props.busy || testRunning}>Run test</button>
      {testSucceeded && !props.dailySchedule && <button className="button button-primary" type="button" onClick={props.onFinish} disabled={!props.canFinish}>Finish setup</button>}
      {props.scheduleAllowed && props.dailySchedule && <button className="button button-primary" type="button" onClick={props.onSchedule} disabled={!props.canSchedule}>Schedule agent</button>}
    </div>
  </div>;
}

function displayAddress(value: string): string {
  try {
    const parsed = new URL(value);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return value;
  }
}

function scheduleTimeLabel(cron: string): string {
  const [minute, hour] = cron.trim().split(/\s+/);
  return `${(hour ?? "0").padStart(2, "0")}:${(minute ?? "0").padStart(2, "0")}`;
}

function startUrlError(value: string): string | null {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") {
      return "Enter a valid http(s) website address before starting.";
    }
    if (parsed.search !== "" || parsed.hash !== "") {
      return "Start from the website's main address. Remove anything after ? or #.";
    }
    return null;
  } catch {
    return "Enter a valid http(s) website address before starting.";
  }
}

function isFivePartCron(value: string): boolean {
  return value.trim().split(/\s+/).length === 5;
}

function isRecording(value: unknown): value is Recording {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";
}

function discardRecordedValues(recording: Recording): Recording {
  if (recording.status === "awaiting_login" || recording.status === "verifying_login") return { ...recording, liveViewUrl: null, steps: [] };
  return {
    ...recording,
    steps: recording.steps.map((step) => step.type === "input" || step.type === "select_change"
      ? { ...step, value: undefined, inputName: undefined }
      : step),
  };
}

function exampleArguments(inputs: SetupInput[]): RunArguments {
  return Object.fromEntries(inputs.map((input) => [input.name, input.type === "number" ? Number(input.example) : input.example]));
}


function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Something went wrong. Retry to continue.";
}
