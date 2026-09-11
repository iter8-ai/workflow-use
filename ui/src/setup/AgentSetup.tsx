import { useEffect, useMemo, useRef, useState } from "react";
import { compileAgent, type SetupDraft, type SetupInput, type SetupStep } from "./compiler";
import { browserbaseLiveViewUrl, createHostBridge, type Recording, type TestRun } from "./host";
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
  const [bridge, setBridge] = useState<ReturnType<typeof createHostBridge> | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>("describe");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [steps, setSteps] = useState<SetupStep[]>([]);
  const [inputs, setInputs] = useState<SetupInput[]>([]);
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [agentId, setAgentId] = useState<string | null>(null);
  const [testRun, setTestRun] = useState<RunState | null>(null);
  const [checkedResult, setCheckedResult] = useState(false);
  const [dailySchedule, setDailySchedule] = useState(false);
  const [cron, setCron] = useState("0 9 * * *");
  const [scheduleAllowed, setScheduleAllowed] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

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
    void bridge.request("ready", {}).then((result) => {
      if (!active) {
        return;
      }
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
  }, [bridge]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    if (bridge === undefined || bridge === null || recording?.status !== "recording") {
      return;
    }
    let active = true;
    const refresh = () => {
      void bridge.request("getRecording", { id: recording.id }).then((next) => {
        if (!active) {
          return;
        }
        setRecording(next);
        setSteps(next.steps);
      }).catch((requestError: Error) => {
        if (active) {
          setError(requestError.message);
        }
      });
    };
    const interval = window.setInterval(refresh, 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [bridge, recording?.id, recording?.status]);

  useEffect(() => {
    if (bridge === undefined || bridge === null || testRun?.status !== "running" || agentId === null) {
      return;
    }
    let active = true;
    const refresh = () => {
      void bridge.request("getTestRun", { agentId, runId: testRun.id }).then((next) => {
        if (!active) {
          return;
        }
        setTestRun((current) => current === null ? null : {
          ...current,
          status: next.status,
          error: next.error,
          files: next.files ?? [],
        });
      }).catch((requestError: Error) => {
        if (active) {
          setError(requestError.message);
        }
      });
    };
    refresh();
    const interval = window.setInterval(refresh, 2_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [agentId, bridge, testRun?.id, testRun?.status]);

  function invalidateTest(): void {
    setRevision((current) => current + 1);
    setTestRun(null);
    setCheckedResult(false);
    setNotice("Changes require a new test.");
  }

  function setDraftField(setter: (value: string) => void, value: string): void {
    setter(value);
    invalidateTest();
  }

  async function startRecording(): Promise<void> {
    if (bridge === undefined || bridge === null) {
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
      setRecording(next);
      setSteps(next.steps);
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
      setRecording(next);
      setSteps(next.steps);
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
    setScreen("review");
  }

  function updateStep(id: string, updates: Partial<SetupStep>): void {
    setSteps((current) => current.map((step) => step.id === id ? { ...step, ...updates } : step));
    invalidateTest();
  }

  function removeStep(id: string): void {
    setSteps((current) => {
      const remaining = current.filter((step) => step.id !== id);
      const activeInputs = new Set(remaining.flatMap((step) => step.inputName === undefined ? [] : [step.inputName]));
      setInputs((currentInputs) => currentInputs.filter((input) => activeInputs.has(input.name)));
      return remaining;
    });
    invalidateTest();
  }

  function makeReusableInput(step: SetupStep): void {
    const inputName = uniqueInputName(inputs);
    const nextInput: SetupInput = {
      name: inputName,
      label: step.target ?? "Reusable value",
      type: "text",
      example: step.value ?? "",
    };
    setInputs((current) => [...current, nextInput]);
    updateStep(step.id, { inputName });
  }

  function useLiteralValue(step: SetupStep): void {
    const inputName = step.inputName;
    if (inputName === undefined) {
      return;
    }
    setInputs((current) => current.filter((input) => input.name !== inputName));
    updateStep(step.id, { inputName: undefined });
  }

  function updateInput(nameToUpdate: string, updates: Pick<Partial<SetupInput>, "label" | "type" | "example">): void {
    setInputs((current) => current.map((input) => input.name === nameToUpdate ? { ...input, ...updates } : input));
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
    if (bridge === undefined || bridge === null) {
      return;
    }
    setError(null);
    setNotice(null);
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
      const started = await bridge.request("testAgent", { agentId: saved.id, arguments: testValues });
      setTestRun({ id: started.id, status: "running", files: [], revision });
      setCheckedResult(false);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function schedule(): Promise<void> {
    if (bridge === undefined || bridge === null || agentId === null || testRun === null || !dailySchedule || !hasValidSchedule || !canSchedule) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bridge.request("scheduleAgent", {
        agentId,
        runId: testRun.id,
        arguments: testValues,
        cron: dailySchedule ? cron.trim() : "",
      });
      setNotice(dailySchedule ? "Daily schedule saved." : "Agent schedule saved.");
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  function reset(): void {
    if (bridge !== undefined && bridge !== null && recording?.status === "recording") {
      void bridge.request("cancelRecording", { id: recording.id }).catch(() => undefined);
    }
    setScreen("describe");
    setRecording(null);
    setSteps([]);
    setInputs([]);
    setTestValues({});
    setTestRun(null);
    setCheckedResult(false);
    setError(null);
    setNotice(null);
    setRevision((current) => current + 1);
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
        <button className="button button-quiet" type="button" onClick={() => void close()} disabled={busy}>Close setup</button>
      </header>
      <div className="setup-shell">
        <nav aria-label="Agent setup progress" className="setup-progress">
          {screens.map((item, index) => <div className={screen === item.id ? "progress-item current" : screens.findIndex((screenItem) => screenItem.id === screen) > index ? "progress-item complete" : "progress-item"} key={item.id}><span>{index + 1}</span>{item.label}</div>)}
        </nav>
        <section className="setup-content" aria-busy={busy}>
          {connecting && <p className="setup-status" role="status">Connecting to Reiterate</p>}
          {error !== null && <div className="setup-error" role="alert"><span>{error}</span><button type="button" className="button button-quiet" onClick={() => setError(null)}>Dismiss</button></div>}
          {notice !== null && <p className="setup-notice" role="status">{notice}</p>}
          {screen === "describe" && <Describe name={name} url={url} goal={goal} busy={busy || connecting} onName={(value) => setDraftField(setName, value)} onUrl={(value) => setDraftField(setUrl, value)} onGoal={(value) => setDraftField(setGoal, value)} onContinue={() => void startRecording()} />}
          {screen === "demonstrate" && <Demonstrate recording={recording} steps={steps} liveViewUrl={liveViewUrl} busy={busy} onStop={() => void stopRecording()} onReview={continueToReview} onReset={reset} />}
          {screen === "review" && <Review steps={steps} inputs={inputs} busy={busy} onUpdateStep={updateStep} onRemoveStep={removeStep} onMakeReusable={makeReusableInput} onUseLiteral={useLiteralValue} onUpdateInput={updateInput} onBack={() => setScreen("demonstrate")} onContinue={continueToTest} />}
          {screen === "test" && <Test inputs={inputs} values={testValues} run={testRun} checked={checkedResult} canSchedule={canSchedule} scheduleAllowed={scheduleAllowed} dailySchedule={dailySchedule} cron={cron} scheduleValid={hasValidSchedule} busy={busy} onValue={(inputName, value) => { setTestValues((current) => ({ ...current, [inputName]: value })); setTestRun(null); setCheckedResult(false); setNotice("Changes require a new test."); }} onRun={() => void runTest()} onCheck={setCheckedResult} onDaily={setDailySchedule} onCron={setCron} onSchedule={() => void schedule()} onBack={() => setScreen("review")} />}
        </section>
      </div>
      <footer className="setup-footer">Public project: <a href="https://github.com/iter8-ai/workflow-use" target="_blank" rel="noreferrer">Source code</a><span aria-hidden="true">·</span><a href="https://github.com/iter8-ai/workflow-use/blob/main/LICENSE" target="_blank" rel="noreferrer">AGPL-3.0 license</a></footer>
    </main>
  );
}

function Describe(props: { name: string; url: string; goal: string; busy: boolean; onName(value: string): void; onUrl(value: string): void; onGoal(value: string): void; onContinue(): void }): JSX.Element {
  return <div className="setup-panel"><div><h2>Describe the job</h2><p>Start with the website and the result you want. You will demonstrate the task in the next step.</p></div><p className="credential-warning">Do not enter logins, passwords, one-time codes, or API keys. Credential-required tasks cannot yet be taught.</p><label>Agent name<input aria-label="Agent name" value={props.name} onChange={(event) => props.onName(event.target.value)} autoComplete="off" /></label><label>Website address<input aria-label="Website address" value={props.url} onChange={(event) => props.onUrl(event.target.value)} placeholder="https://example.com" inputMode="url" autoComplete="off" /></label><label>What should the agent do?<textarea aria-label="What should the agent do?" value={props.goal} onChange={(event) => props.onGoal(event.target.value)} /></label><div className="setup-actions"><button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy}>Continue to demonstration</button></div></div>;
}

function Demonstrate(props: { recording: Recording | null; steps: SetupStep[]; liveViewUrl: string | null; busy: boolean; onStop(): void; onReview(): void; onReset(): void }): JSX.Element {
  const isRecording = props.recording?.status === "recording";
  return <div className="setup-panel demonstrate"><div><h2>Demonstrate the task</h2><p>Show each step you want the agent to follow. You can review and edit the steps afterwards.</p></div><p className="credential-warning">Do not enter logins, passwords, one-time codes, or API keys. Credential-required tasks cannot yet be taught.</p>{props.recording?.blockedReason !== null && props.recording?.blockedReason !== undefined && <div className="setup-error" role="alert">Cannot continue: {props.recording.blockedReason}</div>}{props.recording?.status === "expired" && <div className="setup-error" role="alert">Recording expired. Start a new demonstration.</div>}<div className="demonstration-grid"><div className="browser-frame">{props.liveViewUrl === null ? <p>Waiting for the virtual browser.</p> : <iframe title="Virtual browser" src={props.liveViewUrl} />}</div><aside className="captured-steps" aria-label="Captured demonstration steps"><h3>Captured steps</h3>{props.steps.length === 0 ? <p>Actions will appear here while you demonstrate.</p> : <ol>{props.steps.map((step) => <li key={step.id}>{step.description}</li>)}</ol>}</aside></div><div className="setup-actions"><button className="button button-quiet" type="button" onClick={props.onReset} disabled={props.busy}>Start over</button>{isRecording && <button className="button button-primary" type="button" onClick={props.onStop} disabled={props.busy}>Stop demonstration</button>}{props.recording?.status === "stopped" && <button className="button button-primary" type="button" onClick={props.onReview} disabled={props.busy}>Continue to review</button>}</div></div>;
}

function Review(props: { steps: SetupStep[]; inputs: SetupInput[]; busy: boolean; onUpdateStep(id: string, updates: Partial<SetupStep>): void; onRemoveStep(id: string): void; onMakeReusable(step: SetupStep): void; onUseLiteral(step: SetupStep): void; onUpdateInput(name: string, updates: Pick<Partial<SetupInput>, "label" | "type" | "example">): void; onBack(): void; onContinue(): void }): JSX.Element {
  return <div className="setup-panel"><div><h2>Review the draft</h2><p>Make the instructions clear. Choose which values people provide each time, and keep the rest as demonstrated.</p></div>{props.steps.map((step, index) => <article className="review-step" key={step.id}><div className="review-step-heading"><h3>Step {index + 1}</h3><button type="button" className="text-button" onClick={() => props.onRemoveStep(step.id)} disabled={props.busy}>Remove step</button></div><label>Description<textarea aria-label={`Step ${index + 1} description`} value={step.description} onChange={(event) => props.onUpdateStep(step.id, { description: event.target.value })} /></label><label>Expected outcome<textarea aria-label={`Step ${index + 1} expected outcome`} value={step.expectedOutcome ?? ""} onChange={(event) => props.onUpdateStep(step.id, { expectedOutcome: event.target.value || undefined })} /></label>{(step.type === "input" || step.type === "select_change") && <div className="input-choice">{step.inputName === undefined ? <button type="button" className="button button-quiet" onClick={() => props.onMakeReusable(step)} disabled={props.busy}>Choose a value each run</button> : <><p>Uses {inputLabel(step.inputName, props.inputs)} when the agent runs.</p><button type="button" className="button button-quiet" onClick={() => props.onUseLiteral(step)} disabled={props.busy}>Keep demonstrated value</button></>}</div>}</article>)}{props.inputs.map((input) => <article className="input-definition" key={input.name}><h3>Value for each run</h3><div className="input-grid"><label>What should we call this value?<input aria-label="What should we call this value?" value={input.label} onChange={(event) => props.onUpdateInput(input.name, { label: event.target.value })} /></label><label>Type<select aria-label="Input type" value={input.type} onChange={(event) => props.onUpdateInput(input.name, { type: event.target.value as SetupInput["type"] })}><option value="text">Text</option><option value="date">Date</option><option value="number">Number</option></select></label><label>Example value<input aria-label="Example value" value={input.example} onChange={(event) => props.onUpdateInput(input.name, { example: event.target.value })} /></label></div></article>)}<div className="setup-actions"><button className="button button-quiet" type="button" onClick={props.onBack} disabled={props.busy}>Back to demonstration</button><button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy}>Continue to test</button></div></div>;
}

function Test(props: { inputs: SetupInput[]; values: Record<string, string>; run: RunState | null; checked: boolean; canSchedule: boolean; scheduleAllowed: boolean; dailySchedule: boolean; cron: string; scheduleValid: boolean; busy: boolean; onValue(name: string, value: string): void; onRun(): void; onCheck(value: boolean): void; onDaily(value: boolean): void; onCron(value: string): void; onSchedule(): void; onBack(): void }): JSX.Element {
  const testFailed = props.run?.status === "failed";
  const testSucceeded = props.run?.status === "succeeded";
  return <div className="setup-panel"><div><h2>Test a fresh run</h2><p>Reiterate runs the saved draft in a new browser session. Check the output before scheduling it.</p></div>{props.inputs.map((input) => <label key={input.name}>{input.label}<input aria-label={input.label} type={input.type} value={props.values[input.name] ?? ""} onChange={(event) => props.onValue(input.name, event.target.value)} /></label>)}<div className="test-result" aria-live="polite">{props.run?.status === "running" && <p>Test is running.</p>}{testSucceeded && <><p>Test completed</p>{props.run?.files.map((file) => <a key={file.url} href={file.url} target="_blank" rel="noreferrer">{file.name}</a>)}</>}{testFailed && <p role="alert">{props.run?.error ?? "The test failed."}</p>}{props.run === null && <p>Run a test after each change.</p>}</div>{testSucceeded && <label className="result-check"><input aria-label="I checked the result" type="checkbox" checked={props.checked} onChange={(event) => props.onCheck(event.target.checked)} />I checked the result</label>}{props.scheduleAllowed && <div className="schedule-options"><p>Scheduled runs reuse these fixed test input values.</p><label className="result-check"><input aria-label="Schedule daily" type="checkbox" checked={props.dailySchedule} onChange={(event) => props.onDaily(event.target.checked)} />Schedule daily</label>{props.dailySchedule && <label>UTC cron expression<input aria-label="UTC cron expression" value={props.cron} onChange={(event) => props.onCron(event.target.value)} placeholder="0 9 * * *" />{!props.scheduleValid && <span className="field-hint">Enter a five-part UTC cron expression.</span>}</label>}</div>}<div className="setup-actions"><button className="button button-quiet" type="button" onClick={props.onBack} disabled={props.busy}>Back to review</button><button className="button button-primary" type="button" onClick={props.onRun} disabled={props.busy}>Run test</button>{props.scheduleAllowed && <button className="button button-primary" type="button" onClick={props.onSchedule} disabled={!props.canSchedule}>Schedule agent</button>}</div></div>;
}

function inputLabel(name: string, inputs: SetupInput[]): string {
  return inputs.find((input) => input.name === name)?.label || "this value";
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

function uniqueInputName(inputs: SetupInput[]): string {
  let counter = inputs.length + 1;
  while (inputs.some((input) => input.name === `input_${counter}`)) {
    counter += 1;
  }
  return `input_${counter}`;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Something went wrong. Retry to continue.";
}
