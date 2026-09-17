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
      if (current?.status === "recording" && next !== null) {
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
    if (bridge === undefined || bridge === null || recording?.status !== "recording" || busy) {
      return;
    }
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await bridge.request("getRecording", { id: recording.id });
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
  }, [bridge, recording?.id, recording?.status, busy, pollAttempt]);

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
      const next = await bridge.request("startRecording", { url }, {
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

  if (bridge === undefined) {
    return <main className="setup-unavailable"><p>Connecting to Reiterate</p></main>;
  }

  if (bridge === null) {
    return <main className="setup-unavailable"><h1>Open agent setup from Reiterate</h1><p>This page needs the Reiterate host to securely create and test an agent.</p></main>;
  }

  return (
    <main className="agent-setup">
      <header className="setup-header">
        <div><p className="setup-product">Reiterate</p><h1>Set up your agent</h1></div>
        <button className="button button-quiet" type="button" ref={closeButtonRef} onClick={requestClose} disabled={busy}>Close setup</button>
      </header>
      <div className="setup-shell">
        <nav aria-label="Agent setup progress" className="setup-progress">
          {screens.map((item, index) => <div className={screen === item.id ? "progress-item current" : screens.findIndex((screenItem) => screenItem.id === screen) > index ? "progress-item complete" : "progress-item"} key={item.id}><span>{index + 1}</span>{item.label}</div>)}
        </nav>
        <section className={`setup-content${screen === "demonstrate" ? " setup-content-demonstrate" : ""}`} aria-busy={busy}>
          {connecting && <p className="setup-status" role="status">Connecting to Reiterate</p>}
          {!connecting && !connected && <button className="button button-quiet" type="button" onClick={() => setConnectionAttempt((current) => current + 1)}>Retry connection</button>}
          {(recordingError !== null || testStatusError !== null) && <div className="setup-error" role="alert"><span>{recordingError !== null ? "Could not refresh the demonstration." : "Could not refresh the test result."} {recordingError ?? testStatusError} Retrying automatically.</span><button className="button button-quiet" type="button" onClick={() => setPollAttempt((current) => current + 1)}>Retry status</button></div>}
          {error !== null && <div className="setup-error" role="alert"><span>{error}</span><button type="button" className="button button-quiet" onClick={() => setError(null)}>Dismiss</button></div>}
          {notice !== null && <p className="setup-notice" role="status">{notice}</p>}
          {screen === "describe" && <Describe name={name} url={url} goal={goal} busy={busy || !connected} onName={(value) => setDraftField(setName, value)} onUrl={(value) => setDraftField(setUrl, value)} onGoal={(value) => setDraftField(setGoal, value)} onContinue={() => void startRecording()} />}
          {screen === "demonstrate" && <Demonstrate recording={recording} steps={steps} liveViewUrl={liveViewUrl} busy={busy} onStop={() => void stopRecording()} onReview={continueToReview} onReset={() => void reset()} />}
          {screen === "review" && <Review name={name} url={url} goal={goal} onName={(value) => setDraftField(setName, value)} onGoal={(value) => setDraftField(setGoal, value)} steps={steps} inputs={inputs} busy={busy} onUpdateStep={updateStep} onRemoveStep={removeStep} onAddInput={addInput} onUpdateInput={updateInput} onRemoveInput={removeInput} onBack={() => setScreen("demonstrate")} onContinue={continueToTest} />}
          {screen === "test" && !scheduleSaved && <Test run={testRun} checked={checkedResult} canFinish={canFinish} canSchedule={canSchedule} scheduleAllowed={scheduleAllowed} dailySchedule={dailySchedule} cron={cron} scheduleValid={hasValidSchedule} busy={busy} onRun={() => void runTest()} onCheck={setCheckedResult} onDaily={setDailySchedule} onCron={setCron} onSchedule={() => void schedule()} onFinish={() => void close()} onBack={() => setScreen("review")} />}
          {scheduleSaved && <div className="setup-panel"><h2>Your agent is ready</h2><p>The daily schedule is saved. It will repeat the tested workflow.</p><div className="setup-actions"><button className="button button-primary" type="button" onClick={() => void close()} disabled={busy}>Open agent</button></div></div>}
        </section>
      </div>
      {confirmClose && <div className="close-confirmation" role="dialog" aria-modal="true" aria-labelledby="close-setup-title"><div className="close-confirmation-card" ref={closeDialogRef}><h2 id="close-setup-title">Leave setup?</h2><p>Changes in this setup have not been saved. Any agent you saved by running a test remains available.</p><div className="setup-actions"><button className="button button-quiet" type="button" onClick={() => setConfirmClose(false)} disabled={busy}>Keep editing</button><button className="button button-danger" type="button" onClick={() => void close()} disabled={busy}>Close setup</button></div></div></div>}
      <footer className="setup-footer">Public project: <a href="https://github.com/iter8-ai/workflow-use" target="_blank" rel="noreferrer">Source code</a><span aria-hidden="true">·</span><a href="https://github.com/iter8-ai/workflow-use/blob/main/LICENSE" target="_blank" rel="noreferrer">AGPL-3.0 license</a></footer>
    </main>
  );
}

function Describe(props: { name: string; url: string; goal: string; busy: boolean; onName(value: string): void; onUrl(value: string): void; onGoal(value: string): void; onContinue(): void }): JSX.Element {
  return <div className="setup-panel setup-panel-compact"><div><h2>Describe the job</h2><p>Start with the website and the result you want. You will demonstrate the task next.</p></div><p className="credential-warning">Do not enter logins, passwords, one-time codes, or API keys. Credential-required tasks cannot yet be taught.</p><label>Agent name<input aria-label="Agent name" value={props.name} onChange={(event) => props.onName(event.target.value)} autoComplete="off" /></label><label>Website address<input aria-label="Website address" value={props.url} onChange={(event) => props.onUrl(event.target.value)} placeholder="https://example.com" inputMode="url" autoComplete="off" /></label><label>What should the agent do?<textarea aria-label="What should the agent do?" value={props.goal} onChange={(event) => props.onGoal(event.target.value)} placeholder="For example: download the latest public annual report." /></label><div className="setup-actions"><button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy}>Continue to demonstration</button></div></div>;
}

function Demonstrate(props: { recording: Recording | null; steps: SetupStep[]; liveViewUrl: string | null; busy: boolean; onStop(): void; onReview(): void; onReset(): void }): JSX.Element {
  const isRecording = props.recording?.status === "recording";
  const expired = props.recording?.status === "expired";
  const blocked = props.recording?.blockedReason != null;
  const stopped = props.recording?.status === "stopped";
  const empty = stopped && props.steps.length === 0;
  const canReview = stopped && !blocked && !empty;
  const state = expired ? "Demonstration expired" : blocked ? "Demonstration blocked" : isRecording ? "Recording in progress" : "Demonstration finished";
  const showBrowser = isRecording && !blocked;
  return <div className="setup-panel demonstrate">
    <div><h2>Demonstrate the task</h2><p>Show each step you want the agent to follow. You can review and edit the steps afterwards.</p></div>
    <p className="credential-warning">Do not enter logins, passwords, one-time codes, or API keys. Credential-required tasks cannot yet be taught.</p>
    {blocked && <div className="setup-error" role="alert">Cannot continue: {props.recording?.blockedReason} Start over to record a supported task.</div>}
    {expired && <div className="setup-error" role="alert">Recording expired. Start a new demonstration.</div>}
    {empty && !blocked && <div className="setup-error" role="alert">No usable steps were recorded. Start over and demonstrate the task before finishing.</div>}
    <div className={`recording-state ${isRecording && !blocked ? "recording-state-active" : ""}`} role="status"><span aria-hidden="true" />{state}</div>
    <div className="demonstration-grid">
      <div className="browser-frame">{showBrowser ? <LiveBrowser key={props.recording?.id} url={props.liveViewUrl} /> : <p>{canReview ? "Demonstration finished. Review the recorded steps to continue." : "This demonstration cannot be used. Start over to try again."}</p>}</div>
      <aside className="captured-steps" aria-label="Captured demonstration steps" tabIndex={0}>
        <h3>Recorded steps ({props.steps.length})</h3>
        {props.steps.length === 0 ? <p>{isRecording ? "Actions will appear here while you demonstrate." : "No steps were recorded."}</p> : <ol>{props.steps.map((step) => <li key={step.id}>{step.description}</li>)}</ol>}
      </aside>
    </div>
    <div className="setup-actions"><button className="button button-quiet" type="button" onClick={props.onReset} disabled={props.busy}>Start over</button>{isRecording && !blocked ? <button className="button button-primary" type="button" onClick={props.onStop} disabled={props.busy}>Finish demonstration</button> : <button className="button button-primary" type="button" onClick={props.onReview} disabled={props.busy || !canReview}>Continue to review</button>}</div>
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
    {url !== null && <div className="browser-toolbar"><button className="button button-quiet" type="button" onClick={() => setAttempt((current) => current + 1)}>Reload browser</button></div>}
    <div className="browser-viewport">
      {(!loaded || url === null) && <div className="browser-loading" role="status">
        <p>{slow ? url === null ? "The virtual browser is unavailable. Start over to open a new session." : "The browser frame is taking longer than expected. Reload the browser, or start over if the session is unavailable." : "Opening the virtual browser. This can take a few seconds."}</p>
      </div>}
      {url !== null && <iframe key={attempt} title="Virtual browser" src={url} onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setSlow(true); }} />}
    </div>
  </div>;
}

function Review(props: { name: string; url: string; goal: string; onName(value: string): void; onGoal(value: string): void; steps: SetupStep[]; inputs: SetupInput[]; busy: boolean; onUpdateStep(id: string, updates: Partial<SetupStep>): void; onRemoveStep(id: string): void; onAddInput(): void; onUpdateInput(index: number, updates: Partial<SetupInput>): void; onRemoveInput(index: number): void; onBack(): void; onContinue(): void }): JSX.Element {
  return <div className="setup-panel">
    <div><h2>Review the draft</h2><p>Make the instructions clear and choose each form value deliberately.</p></div>
    <label>Agent name<input value={props.name} onChange={(event) => props.onName(event.target.value)} disabled={props.busy} autoComplete="off" /></label>
    <label>What should the agent do?<textarea value={props.goal} onChange={(event) => props.onGoal(event.target.value)} disabled={props.busy} /></label>
    <label>Recorded starting address<input value={props.url} readOnly /></label>
    <p>The starting address and recorded targets stay fixed. To change them, go back to the demonstration and start over.</p>
    <section aria-labelledby="reusable-inputs-heading">
      <div className="review-step-heading"><div><h3 id="reusable-inputs-heading">Reusable inputs</h3><p>Examples are used for the test and any schedule.</p></div><button type="button" className="button button-quiet" onClick={props.onAddInput} disabled={props.busy}>Add reusable input</button></div>
      {props.inputs.map((input, index) => <article className="review-step" key={index}>
        <div className="review-step-heading"><h3>Input {index + 1}</h3><button type="button" className="text-button" onClick={() => props.onRemoveInput(index)} disabled={props.busy}>Remove input</button></div>
        <label>Name<input aria-label={`Input ${index + 1} name`} value={input.name} onChange={(event) => props.onUpdateInput(index, { name: event.target.value })} disabled={props.busy} autoComplete="off" /></label>
        <label>Label<input aria-label={`Input ${index + 1} label`} value={input.label} onChange={(event) => props.onUpdateInput(index, { label: event.target.value })} disabled={props.busy} autoComplete="off" /></label>
        <label>Type<select aria-label={`Input ${index + 1} type`} value={input.type} onChange={(event) => props.onUpdateInput(index, { type: event.target.value as SetupInput["type"] })} disabled={props.busy}><option value="text">Text</option><option value="date">Date</option><option value="number">Number</option></select></label>
        <label>Example<input aria-label={`Input ${index + 1} example`} type={input.type} value={input.example} onChange={(event) => props.onUpdateInput(index, { example: event.target.value })} disabled={props.busy} autoComplete="off" /></label>
      </article>)}
    </section>
    {props.steps.length === 0 && <p role="status">No steps remain. Go back to the demonstration and start over to capture the task again.</p>}
    {props.steps.map((step, index) => <article className="review-step" key={step.id}>
      <div className="review-step-heading"><h3>Step {index + 1}</h3><button type="button" className="text-button" onClick={() => props.onRemoveStep(step.id)} disabled={props.busy}>Remove step</button></div>
      {step.type === "navigation" ? <p className="recorded-target">Recorded destination: {step.url ?? step.target ?? step.description}</p> : step.target != null && <p className="recorded-target">Recorded target: {step.target}</p>}
      {step.type === "key_press" && step.value != null && <p className="recorded-target">Recorded key: {step.value}</p>}
      <label>Description<textarea aria-label={`Step ${index + 1} description`} value={step.description} onChange={(event) => props.onUpdateStep(step.id, { description: event.target.value })} disabled={props.busy} /></label>
      <label>Expected outcome<textarea aria-label={`Step ${index + 1} expected outcome`} value={step.expectedOutcome ?? ""} onChange={(event) => props.onUpdateStep(step.id, { expectedOutcome: event.target.value || undefined })} disabled={props.busy} /></label>
      {(step.type === "input" || step.type === "select_change") && <>
        <p className="credential-warning">Recorded form values are discarded. Choose a fixed value or reusable input.</p>
        <label>Value source<select aria-label={`Step ${index + 1} value source`} value={step.inputName ?? (step.value !== undefined && step.value !== null ? "__literal" : "")} onChange={(event) => event.target.value === "__literal" ? props.onUpdateStep(step.id, { value: "", inputName: undefined }) : event.target.value === "" ? props.onUpdateStep(step.id, { value: undefined, inputName: undefined }) : props.onUpdateStep(step.id, { value: undefined, inputName: event.target.value })} disabled={props.busy}><option value="">Choose a value</option><option value="__literal">Fixed value</option>{props.inputs.filter((input) => input.name !== "").map((input, inputIndex) => <option value={input.name} key={`${input.name}-${inputIndex}`}>{input.label || input.name}</option>)}</select></label>
        {step.inputName === undefined && step.value !== undefined && step.value !== null && <label>Fixed value<input aria-label={`Step ${index + 1} fixed value`} value={step.value} onChange={(event) => props.onUpdateStep(step.id, { value: event.target.value })} disabled={props.busy} autoComplete="off" /></label>}
      </>}
    </article>)}
    <div className="setup-actions"><button className="button button-quiet" type="button" onClick={props.onBack} disabled={props.busy}>Back to demonstration</button><button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy || props.steps.length === 0}>Continue to test</button></div>
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
  return <div className="setup-panel"><div><h2>Test a fresh run</h2><p>Reiterate runs the saved draft in a new browser session. Check the output, then finish setup or choose a daily schedule.</p></div><div className="test-result" aria-live="polite">{props.run?.status === "running" && <p>Test is running.</p>}{testSucceeded && <><p>Test completed</p>{props.run?.files.length === 0 && <p>No files were returned. Check the result on the website before confirming. If you expected a download, review the instructions and test again.</p>}{props.run?.files.map((file) => <a key={file.url} href={file.url} target="_blank" rel="noreferrer">{file.name}</a>)}</>}{testFailed && <p role="alert">{props.run?.error ?? "The test failed."}</p>}{props.run === null && <p>Run a test after each change.</p>}</div>{testSucceeded && <label className="result-check"><input aria-label="I checked the result" type="checkbox" checked={props.checked} onChange={(event) => props.onCheck(event.target.checked)} />I checked the result</label>}{props.scheduleAllowed && <div className="schedule-options"><p>Daily runs repeat the tested workflow. You can finish setup without a schedule.</p><label className="result-check"><input aria-label="Schedule daily" type="checkbox" checked={props.dailySchedule} onChange={(event) => props.onDaily(event.target.checked)} />Schedule daily</label>{props.dailySchedule && <label>Time of day (UTC)<input type="time" aria-label="Time of day (UTC)" value={dailyTime} onChange={(event) => changeTime(event.target.value)} />{!props.scheduleValid && <span className="field-hint">Choose a time for the daily run.</span>}</label>}</div>}<div className="setup-actions"><button className="button button-quiet" type="button" onClick={props.onBack} disabled={props.busy || testRunning}>Back to review</button><button className={`button ${testSucceeded ? "button-quiet" : "button-primary"}`} type="button" onClick={props.onRun} disabled={props.busy || testRunning}>Run test</button>{testSucceeded && !props.dailySchedule && <button className="button button-primary" type="button" onClick={props.onFinish} disabled={!props.canFinish}>Finish setup</button>}{props.scheduleAllowed && props.dailySchedule && <button className="button button-primary" type="button" onClick={props.onSchedule} disabled={!props.canSchedule}>Schedule agent</button>}</div></div>;
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
