import { useEffect, useMemo, useRef, useState } from "react";
import { compileAgent, doneWhenOptions, draftChanges, findUnambiguousEmailStep, replaceStepsFrom, requiredCredentials, type CredentialKind, type DoneWhen, type SetupDraft, type SetupStep } from "./compiler";
import { browserbaseLiveViewUrl, createHostBridge, HostRequestTimeoutError, type EditAgent as EditAgentData, type HostBridge, type Recording, type TestRun } from "./host";
import { AgentScreenBar } from "./AgentScreenBar";
import { parseAgentThought } from "./agentThought";
import { HelpTip } from "./HelpTip";
import "./setup.css";

type Screen = "describe" | "demonstrate" | "review" | "test" | "schedule";

type RunState = {
  id: string;
  status: TestRun["status"];
  error?: string;
  files: Array<{ name: string; url: string }>;
  liveViewUrl: string | null;
  revision: number;
  failure?: TestRun["failure"];
  stoppedAtStep?: number | null;
  confirmation?: string | null;
  screens?: Array<{ image: string; thought: string }>;
  startedAt: string;
};

// Entering sign-in details or choosing a schedule in the host dialog can take a while.
const interactiveRequestTimeoutMs = 10 * 60_000;
const signInNote = "If the website needs a sign-in, sign in during the demonstration. Reiterate saves the username and password you type there, encrypted, for this agent's runs. They never appear in the steps or the agent's instructions.";

const screens: Array<{ id: Screen; label: string }> = [
  { id: "describe", label: "Describe" },
  { id: "demonstrate", label: "Demonstrate" },
  { id: "review", label: "Review" },
  { id: "test", label: "Test" },
  { id: "schedule", label: "Schedule" },
];

export default function AgentSetup() {
  const recordingRef = useRef<Recording | null>(null);
  const selectedScheduleRef = useRef<{ runId: string; cron: string } | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeDialogRef = useRef<HTMLDivElement>(null);
  const [bridge, setBridge] = useState<ReturnType<typeof createHostBridge> | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>("describe");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [goal, setGoal] = useState("");
  const [recording, setRecording] = useState<Recording | null>(null);
  const [steps, setSteps] = useState<SetupStep[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [testRun, setTestRun] = useState<RunState | null>(null);
  const [doneWhen, setDoneWhen] = useState<DoneWhen>({ kind: "file" });
  const [emailStatus, setEmailStatus] = useState<"waiting" | "routed" | "rejected" | "no_documents" | "timeout" | null>(null);
  const [emailFrom, setEmailFrom] = useState<string | null>(null);
  const [emailFiles, setEmailFiles] = useState<Array<{ name: string; url: string }>>([]);
  const [scheduleSaved, setScheduleSaved] = useState(false);
  const [scheduleRecovery, setScheduleRecovery] = useState(false);
  const [scheduleAllowed, setScheduleAllowed] = useState(false);
  const [dailyTime, setDailyTime] = useState("09:00");
  const [cron, setCron] = useState(() => localTimeToUtcCron("09:00"));
  const [emailRoutesAllowed, setEmailRoutesAllowed] = useState(false);
  const [chooseScheduleAllowed, setChooseScheduleAllowed] = useState(false);
  const [credentialsAllowed, setCredentialsAllowed] = useState(false);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [connecting, setConnecting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);

  const draft = useMemo<SetupDraft>(() => ({ name, url, goal, steps, inputs: [], doneWhen }), [name, url, goal, steps, doneWhen]);
  const liveViewUrl = browserbaseLiveViewUrl(recording?.liveViewUrl ?? null);
  const canContinue = testRun?.status === "succeeded" && (doneWhen.kind !== "email" || emailStatus === "routed") && testRun.revision === revision && !busy;

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
    void bridge.request("ready", {}).then((result) => {
      if (!active) {
        return;
      }
      setScheduleAllowed(result.schedule === true);
      setEmailRoutesAllowed(result.emailRoutes === true);
      setChooseScheduleAllowed(result.chooseSchedule === true);
      setCredentialsAllowed(result.credentials === true);
      setMode(result.mode ?? "create");
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
          liveViewUrl: next.status === "running" ? browserbaseLiveViewUrl(next.liveViewUrl ?? null) : null,
          failure: next.failure,
          stoppedAtStep: next.stoppedAtStep,
          confirmation: next.confirmation,
          screens: (next.screens ?? []).filter((screen) => /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(screen.image)).slice(-20),
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

  useEffect(() => {
    if (bridge === undefined || bridge === null || testRun?.status !== "succeeded" || doneWhen.kind !== "email") return;
    let active = true;
    const deadline = Date.now() + 180_000;
    let timeout: number;
    const deadlineTimer = window.setTimeout(() => { active = false; window.clearTimeout(timeout); setEmailStatus("timeout"); }, 180_000);
    const poll = () => {
      if (!active) return;
      if (Date.now() >= deadline) { setEmailStatus("timeout"); return; }
      void bridge.request("getEmailArrival", { channelId: doneWhen.channelId, since: testRun.startedAt }).then((result) => {
        if (!active) return;
        if (Date.now() >= deadline) return;
        setEmailStatus(result.status);
        if (result.status !== "waiting") window.clearTimeout(deadlineTimer);
        setEmailFrom(result.from ?? null);
        setEmailFiles(result.files ?? []);
        if (result.status === "waiting") timeout = window.setTimeout(poll, 5_000);
      }).catch(() => { if (active) timeout = window.setTimeout(poll, 5_000); });
    };
    setEmailStatus("waiting");
    poll();
    return () => { active = false; window.clearTimeout(timeout); window.clearTimeout(deadlineTimer); };
  }, [bridge, doneWhen, testRun?.id, testRun?.status, testRun?.startedAt]);

  function invalidateTest(): void {
    selectedScheduleRef.current = null;
    setRevision((current) => current + 1);
    // Nothing to invalidate before the first test; the notice would only confuse on the Describe step.
    if (testRun !== null) setNotice("Changes require a new test.");
    setTestRun(null);
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
    const startUrl = withScheme(url);
    const urlError = startUrlError(startUrl);
    if (urlError !== null) {
      setError(urlError);
      return;
    }
    setUrl(startUrl);
    if (name.trim() === "" || goal.trim() === "") {
      setError("Add an agent name and goal before starting the demonstration.");
      return;
    }
    setBusy(true);
    try {
      const next = await bridge.request("startRecording", { url: startUrl }, {
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
    setSteps((current) => current.filter((step) => step.id !== id));
    invalidateTest();
  }

  function continueToTest(): void {
    setError(null);
    try {
      // Done when is edited on Test; validate it when saving/running, so users can return to correct it.
      compileAgent({ ...draft, doneWhen: { kind: "file" } });
      if (!credentialsAllowed && requiredCredentials(steps).length > 0) {
        throw new Error("This Reiterate page is out of date and cannot save sign-in details. Reload Reiterate and set up the agent again.");
      }
      setScreen("test");
    } catch (compileError) {
      setError(errorMessage(compileError));
    }
  }

  async function saveCredentials(kinds: CredentialKind[], replace: boolean): Promise<boolean> {
    if (bridge === undefined || bridge === null) {
      return false;
    }
    if (kinds.length === 0) {
      return true;
    }
    // The host prompts only for values it does not already hold for this website.
    const result = await bridge.request("requestCredentials", { kinds, replace }, { timeoutMs: interactiveRequestTimeoutMs });
    return kinds.every((kind) => result.saved.includes(kind));
  }

  async function changeCredentials(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      if (await saveCredentials(requiredCredentials(steps), true)) {
        invalidateTest();
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(nextDoneWhen: DoneWhen = doneWhen, nextSteps = steps, nextRevision = revision): Promise<void> {
    if (bridge === undefined || bridge === null) {
      return;
    }
    setError(null);
    setNotice(null);
    let config: ReturnType<typeof compileAgent>;
    try {
      config = compileAgent({ ...draft, steps: nextSteps, doneWhen: nextDoneWhen });
    } catch (compileError) {
      setError(errorMessage(compileError));
      return;
    }
    setBusy(true);
    try {
      if (!(await saveCredentials(requiredCredentials(nextSteps), false))) {
        setError("Add the missing sign-in details to test this agent.");
        return;
      }
      const saved = await bridge.request("saveAgent", { draft: { ...draft, steps: nextSteps, doneWhen: nextDoneWhen }, config, agentId: agentId ?? undefined });
      // A lost schedule reply may leave the host scheduled. Keep that run/cron until save succeeds.
      setTestRun(null);
      setEmailStatus(null);
      setEmailFrom(null);
      setEmailFiles([]);
      selectedScheduleRef.current = null;
      setAgentId(saved.id);
      const startedAt = new Date().toISOString();
      const started = await bridge.request("testAgent", { agentId: saved.id, arguments: {} });
      setTestRun({ id: started.id, status: "running", files: [], liveViewUrl: null, revision: nextRevision, screens: [], startedAt });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function chooseEmailDoneWhen(): Promise<void> {
    if (!emailRoutesAllowed || bridge === undefined || bridge === null) return;
    const emailStepIndex = findUnambiguousEmailStep(steps);
    if (emailStepIndex === null) {
      setError("No unambiguous export email step was found. Review the steps and try again.");
      return;
    }
    setBusy(true);
    try {
      const route = await bridge.request("createEmailRoute", { name });
      const nextDoneWhen: DoneWhen = { kind: "email", address: route.address, channelId: route.channelId };
      const nextSteps = steps.map((step, index) => index === emailStepIndex
        ? { ...step, value: route.address, description: step.description.replace(step.value ?? "", route.address),
          expectedOutcome: step.expectedOutcome ? step.expectedOutcome.split(step.value!).join(route.address) : step.expectedOutcome } : step);
      setSteps(nextSteps);
      setDoneWhen(nextDoneWhen);
      invalidateTest();
      await runTest(nextDoneWhen, nextSteps, revision + 1);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function allowEmailSender(): Promise<void> {
    if (bridge === undefined || bridge === null || doneWhen.kind !== "email" || emailFrom === null) return;
    setBusy(true);
    try { await bridge.request("allowEmailSender", { channelId: doneWhen.channelId, sender: emailFrom }); await runTest(); }
    catch (requestError) { setError(errorMessage(requestError)); }
    finally { setBusy(false); }
  }

  function editTestStep(id: string, description: string): void {
    setSteps((current) => current.map((step): SetupStep => {
      if (step.id !== id) return step;
      if (step.type === "click") {
        return { ...step, description, target: /^Click .+/.test(description) ? description.slice(6) : null };
      }
      if (step.type === "credential") {
        return { ...step, description, target: null, url: null };
      }
      return { ...step, type: "agent", description, target: null, value: null, url: null };
    }));
    setRevision((current) => current + 1);
    setNotice("Changes require a new test.");
  }

  function chooseDoneWhen(value: DoneWhen): void {
    const unchanged = value.kind === "file" && doneWhen.kind === "file"
      || (value.kind === "text" || value.kind === "described") && value.kind === doneWhen.kind && value.value.trim() === doneWhen.value.trim()
      || value.kind === "clicked" && doneWhen.kind === "clicked" && value.value === doneWhen.value
      || value.kind === "email" && doneWhen.kind === "email" && value.address === doneWhen.address && value.channelId === doneWhen.channelId;
    if (unchanged) return;
    setDoneWhen(value);
    invalidateTest();
  }

  async function schedule(): Promise<void> {
    if (bridge === undefined || bridge === null) {
      return;
    }
    setError(null);
    if (agentId === null || testRun === null || !canContinue) return;
    if (!chooseScheduleAllowed) { setCron(""); setScreen("schedule"); return; }
    setBusy(true);
    try {
      const selected = selectedScheduleRef.current?.runId === testRun.id
        ? selectedScheduleRef.current
        : await bridge.request("chooseSchedule", { cron }, { timeoutMs: interactiveRequestTimeoutMs });
      if (selected === null) return;
      // A save can succeed without a reply. Retry the host's idempotent request for this run.
      selectedScheduleRef.current = { runId: testRun.id, cron: selected.cron.trim() };
      if (selected.cron.trim() !== "") await bridge.request("scheduleAgent", {
        agentId,
        runId: testRun.id,
        arguments: {},
        cron: selected.cron.trim(),
      });
      setScheduleSaved(true);
      setScheduleRecovery(false);
      setScreen("schedule");
      setCron(selected.cron);
      setNotice(null);
    } catch (requestError) {
      if (requestError instanceof HostRequestTimeoutError && selectedScheduleRef.current !== null) setScheduleRecovery(true);
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function saveInlineSchedule(): Promise<void> {
    if (bridge === undefined || bridge === null || agentId === null || testRun === null || !canContinue) return;
    setBusy(true);
    setError(null);
    try {
      if (cron.trim()) await bridge.request("scheduleAgent", { agentId, runId: testRun.id, arguments: {}, cron: cron.trim() });
      setScheduleSaved(true);
      setScheduleRecovery(false);
    } catch (requestError) {
      if (requestError instanceof HostRequestTimeoutError) setScheduleRecovery(true);
      setError(errorMessage(requestError));
    }
    finally { setBusy(false); }
  }

  async function reset(): Promise<void> {
    if (bridge === undefined || bridge === null) return;
    setBusy(true);
    setError(null);
    try {
      if (recording !== null) await bridge.request("cancelRecording", { id: recording.id });
      setScreen("describe");
      setRecording(null);
      setSteps([]);
      setDoneWhen({ kind: "file" });
      setEmailStatus(null);
      setEmailFrom(null);
      setEmailFiles([]);
      setTestRun(null);
      selectedScheduleRef.current = null;
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

  if (mode === "edit") return <EditScreen bridge={bridge} />;

  return (
    <main className={`agent-setup${screen === "demonstrate" ? " agent-setup-demonstrating" : screen === "test" ? " agent-setup-testing" : ""}`}>
      <header className="setup-header setup-topbar">
        <button className="icon-button setup-nav" type="button" onClick={requestClose} disabled={busy} aria-label="Back to web agents" title="Back to web agents"><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M19 12H5M11 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        <h1 className="visually-hidden">Set up your agent</h1>
        <nav aria-label="Agent setup progress" className="setup-progress">
          {screens.map((item, index) => <div className={screen === item.id ? "progress-item current" : screens.findIndex((screenItem) => screenItem.id === screen) > index ? "progress-item complete" : "progress-item"} key={item.id}><span>{index + 1}</span>{item.label}</div>)}
        </nav>
        <button className="icon-button setup-nav setup-close" type="button" ref={closeButtonRef} onClick={requestClose} disabled={busy} aria-label="Close setup" title="Close setup"><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></button>
      </header>
      <div className="setup-shell">

        <section className="setup-content" aria-busy={busy}>
          {connecting && <p className="setup-status" role="status">Connecting to Reiterate</p>}
          {error !== null && <div className="setup-error" role="alert"><span>{error}</span><button type="button" className="button button-quiet" onClick={() => setError(null)}>Dismiss</button></div>}
          {notice !== null && <p className="setup-notice" role="status">{notice}</p>}
          {screen === "describe" && <Describe name={name} url={url} goal={goal} busy={busy || connecting} onName={(value) => setDraftField(setName, value)} onUrl={(value) => setDraftField(setUrl, value)} onGoal={(value) => setDraftField(setGoal, value)} onContinue={() => void startRecording()} />}
          {screen === "demonstrate" && <Demonstrate recording={recording} steps={steps} liveViewUrl={liveViewUrl} busy={busy} onStop={() => void stopRecording()} onReview={continueToReview} onReset={() => void reset()} />}
          {screen === "review" && <Review steps={steps} busy={busy} onUpdateStep={updateStep} onRemoveStep={removeStep} onBack={() => setScreen("demonstrate")} onContinue={continueToTest} />}
          {screen === "test" && <Test steps={steps} url={url} scheduleRecovery={scheduleRecovery} emailRoutesAllowed={emailRoutesAllowed} textAllowed={chooseScheduleAllowed} doneWhen={doneWhen} emailStatus={emailStatus} emailFrom={emailFrom} emailFiles={emailFiles} canContinue={canContinue} onDoneWhen={chooseDoneWhen} onChooseEmail={() => void chooseEmailDoneWhen()} onAllowEmail={() => void allowEmailSender()} onChangeCredentials={() => void changeCredentials()} run={testRun} busy={busy} onRun={() => void runTest()} onSchedule={() => void schedule()} onBack={() => setScreen("review")} onEditStep={editTestStep} />}
          {screen === "schedule" && !scheduleSaved && <div className="setup-panel"><div className="stage-title"><h2>Schedule</h2><p>Your test passed. Scheduled runs repeat the tested steps.</p></div><p>Finish setup to run manually, or choose a daily schedule.</p>{scheduleAllowed && <><label className="result-check"><input type="checkbox" aria-label="Schedule daily" checked={cron !== ""} disabled={busy || scheduleRecovery} onChange={(event) => setCron(event.target.checked ? localTimeToUtcCron(dailyTime) : "")} />Schedule daily</label>{cron !== "" && <label>Time of day<input type="time" aria-label="Time of day" value={dailyTime} disabled={busy || scheduleRecovery} onChange={(event) => { setDailyTime(event.target.value); if (event.target.value) setCron(localTimeToUtcCron(event.target.value)); }} /><span className="field-note">Your local time. The schedule is stored in UTC.</span></label>}</>}<div className="setup-actions"><button className="button button-quiet" type="button" onClick={() => setScreen("test")} disabled={busy || scheduleRecovery}>Back to test</button><button className="button button-primary" type="button" onClick={() => void saveInlineSchedule()} disabled={!canContinue || busy || (cron !== "" && dailyTime === "")}>{cron.trim() ? "Schedule agent" : "Finish setup"}</button></div></div>}
          {scheduleSaved && <div className="setup-panel"><div className="stage-title"><h2>Your agent is ready</h2><p>{cron.trim() ? "The schedule is saved. It will repeat the tested workflow." : "Run this agent manually whenever you need it."}</p></div><div className="setup-actions"><button className="button button-primary" type="button" onClick={() => void close()} disabled={busy}>Open agent</button></div></div>}
        </section>
      </div>
      {confirmClose && <div className="close-confirmation" role="dialog" aria-modal="true" aria-labelledby="close-setup-title"><div className="close-confirmation-card" ref={closeDialogRef}><h2 id="close-setup-title">Leave setup?</h2><p>Changes in this setup have not been saved. Any agent you saved by running a test remains available.</p><div className="setup-actions"><button className="button button-quiet" type="button" onClick={() => setConfirmClose(false)} disabled={busy}>Keep editing</button><button className="button button-danger" type="button" onClick={() => void close()} disabled={busy}>Close setup</button></div></div></div>}
    </main>
  );
}

function EditScreen({ bridge }: { bridge: HostBridge }): JSX.Element {
  const [agent, setAgent] = useState<EditAgentData | null>(null);
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [stages, setStages] = useState<unknown[]>([]);
  const [stageLimitInputs, setStageLimitInputs] = useState<Record<number, string>>({});
  const [stageLimitErrors, setStageLimitErrors] = useState<Record<number, boolean>>({});
  const [testRun, setTestRun] = useState<TestRun & { id: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [fromStep, setFromStep] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ updatedBy: string | null; updatedAt: string | null } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [operation, setOperation] = useState<"test" | "publish" | null>(null);
  const [renameSaved, setRenameSaved] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const recordingRef = useRef<Recording | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const insertedStepRef = useRef<HTMLTextAreaElement>(null);
  const [insertedStepId, setInsertedStepId] = useState<string | null>(null);
  const dialogOpen = publishOpen || conflict !== null || confirmClose;

  const load = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const loaded = await bridge.request("loadAgent", {});
      setAgent(loaded);
      setRenameError(null); setRenameSaved(false);
      setDraft({ name: loaded.name, url: loaded.url, goal: loaded.goal, steps: loaded.steps ?? [], inputs: [] });
      setStages(loaded.stages);
      setStageLimitInputs({}); setStageLimitErrors({});
      setTestRun(null); setChecked(false); setConflict(null); setPublishOpen(false);
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setBusy(false); }
  };
  // load is intentionally called once for the host-bound agent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (recording?.status !== "recording") return;
    const timer = window.setInterval(() => void bridge.request("getRecording", { id: recording.id }).then(setRecording).catch((e) => setError(errorMessage(e))), 1500);
    return () => window.clearInterval(timer);
  }, [bridge, recording?.id, recording?.status]);
  useEffect(() => {
    if (testRun?.status !== "running" || agent === null) return;
    let active = true;
    const poll = () => void bridge.request("getTestRun", { agentId: agent.agentId, runId: testRun.id }).then((next) => { if (active) setTestRun((current) => current === null ? null : { ...current, ...next }); }).catch((e) => setError(errorMessage(e)));
    poll(); const timer = window.setInterval(poll, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [agent, bridge, testRun?.id, testRun?.status]);
  useEffect(() => { recordingRef.current = recording; }, [recording]);
  useEffect(() => () => { const current = recordingRef.current; if (current?.status === "recording") void bridge.request("cancelRecording", { id: current.id }).catch(() => undefined); }, [bridge]);
  useEffect(() => {
    if (!dialogOpen) return;
    const trigger = dialogTriggerRef.current;
    modalRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => { trigger?.focus(); };
  }, [dialogOpen]);
  useEffect(() => {
    if (!dialogOpen) return;
    const dialog = modalRef.current;
    if (busy) dialog?.focus();
    else if (document.activeElement === dialog || !dialog?.contains(document.activeElement)) dialog?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) { setPublishOpen(false); setConflict(null); setConfirmClose(false); }
      } else if (event.key === "Tab") {
        const controls = Array.from(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
        const first = controls[0], last = controls[controls.length - 1];
        if (controls.length === 0) { event.preventDefault(); dialog?.focus(); }
        else if (!dialog?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); };
  }, [dialogOpen, busy, conflict]);
  useEffect(() => { insertedStepRef.current?.focus(); }, [insertedStepId]);

  if (agent === null || draft === null) return <main className="setup-unavailable edit-agent edit-loading">{error ? <div role="alert"><p>{error}</p><button className="button button-primary" onClick={() => void load()}>Retry</button></div> : <p className="edit-status" role="status"><span className="edit-spinner" aria-hidden="true" />Loading agent…</p>}</main>;
  const live: SetupDraft = { name: agent.name, url: agent.url, goal: agent.goal, steps: agent.steps ?? [], inputs: [] };
  const raw = agent.steps === null || agent.steps.length === 0;
  const changes = [...draftChanges(draft, live), ...(raw ? rawStageChanges(stages, agent.stages) : [])];
  const changed = changes.length > 0;
  const succeeded = testRun?.status === "succeeded";
  const recordingActive = recording?.status === "recording";
  const readOnly = agent.internal || busy || recordingActive || testRun?.status === "running";
  const canPublish = !agent.internal && changed && checked && succeeded && !recordingActive;
  const publishHelp = agent.internal ? "Managed by Operations. Publishing changes is disabled." : !changed ? "Make a change to publish." : !succeeded ? "Test your changes before publishing." : !checked ? "Confirm you checked the result." : "Ready to publish your changes.";
  const selectedFromStep = Math.min(fromStep, Math.max(0, draft.steps.length - 1));
  const resetTest = (): void => { setTestRun(null); setChecked(false); setNotice(null); setError(null); };
  const update = (next: Partial<SetupDraft>): void => { setDraft((current) => current === null ? current : { ...current, ...next }); resetTest(); };
  const updateStage = (index: number, next: Record<string, unknown>): void => { setStages((current) => current.map((stage, i) => i === index && isObject(stage) ? { ...stage, ...next } : stage)); resetTest(); };
  const rename = async (value: string): Promise<void> => {
    const name = value.trim();
    setDraft((current) => current === null ? current : { ...current, name });
    setRenameError(null);
    if (name === agent.name.trim() || renaming) return;
    if (!name) { setRenameError("Enter an agent name."); return; }
    setRenaming(true); setRenameSaved(false);
    try {
      await bridge.request("renameAgent", { name });
      // A rename creates no version, so a passed draft test stays valid.
      setAgent((current) => current === null ? current : { ...current, name });
      setRenameSaved(true);
    } catch (e) { setRenameError(errorMessage(e)); }
    finally { setRenaming(false); }
  };
  const test = async (): Promise<void> => {
    if (raw) {
      const errors = Object.fromEntries(Object.entries(stageLimitInputs).map(([index, value]) => [index, !validStepLimit(value)]));
      setStageLimitErrors(errors);
      if (Object.values(errors).some(Boolean)) return;
    }
    const emptyStep = raw ? -1 : draft.steps.findIndex((step) => !step.description.trim());
    if (emptyStep !== -1) { setError(`Add an instruction for step ${emptyStep + 1} before testing.`); return; }
    setBusy(true); setOperation("test"); setError(null); setTestRun(null); setChecked(false);
    try {
      const config = raw ? { url: draft.url, prompt: "", options: { version: 1, engine: "computer" }, stages, parameters: {} } : compileAgent(draft);
      await bridge.request("saveDraft", { draft, config });
      const started = await bridge.request("testAgent", { agentId: agent.agentId, arguments: {} });
      setTestRun({ id: started.id, status: "running" }); setChecked(false);
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); setOperation(null); }
  };
  const publish = async (overwrite: boolean): Promise<void> => {
    setBusy(true); setOperation("publish"); setError(null);
    try {
      const result = await bridge.request("publishDraft", { overwrite });
      if ("conflict" in result) { setPublishOpen(false); setConflict(result.conflict); } else {
        setPublishOpen(false); setConflict(null);
        await load();
        setNotice(`Published v${result.version}.${agent.schedule ? " Scheduled runs use it from the next run." : ""}`);
      }
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); setOperation(null); }
  };
  const startRecording = async (): Promise<void> => {
    setBusy(true); setError(null); setNotice(null); setTestRun(null); setChecked(false);
    try {
      if (recording !== null) await bridge.request("cancelRecording", { id: recording.id });
      setRecording(await bridge.request("startRecording", { url: draft.url }));
    }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const stopRecording = async (): Promise<void> => {
    if (recording === null) return;
    setBusy(true);
    try { const stopped = await bridge.request("stopRecording", { id: recording.id }); setRecording(stopped); if (stopped.steps.length > 0) update({ steps: replaceStepsFrom(draft.steps, selectedFromStep, stopped.steps) }); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const revert = (key: string): void => {
    if (raw && key === "stages") { setStages(agent.stages); setStageLimitInputs({}); setStageLimitErrors({}); resetTest(); return; }
    if (key === "url" || key === "goal") update({ [key]: live[key] });
    else if (key === "steps") {
      const ordered = live.steps.flatMap((step) => draft.steps.filter((item) => item.id === step.id));
      let index = 0;
      update({ steps: draft.steps.map((step) => live.steps.some((item) => item.id === step.id) ? ordered[index++]! : step) });
    }
    else if (key.startsWith("added:")) update({ steps: draft.steps.filter((step) => step.id !== key.slice(6)) });
    else if (key.startsWith("removed:")) {
      const index = live.steps.findIndex((step) => step.id === key.slice(8));
      const next = live.steps.slice(index + 1).find((step) => draft.steps.some((item) => item.id === step.id));
      const insertAt = next ? draft.steps.findIndex((step) => step.id === next.id) : draft.steps.length;
      update({ steps: [...draft.steps.slice(0, insertAt), live.steps[index]!, ...draft.steps.slice(insertAt)] });
    }
    else { const [, id, field] = key.split(":"); const original = live.steps.find((step) => step.id === id); update({ steps: draft.steps.map((step) => step.id === id ? { ...step, [field === "outcome" ? "expectedOutcome" : "description"]: original?.[field === "outcome" ? "expectedOutcome" : "description"] } : step) }); }
  };

  const close = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { await bridge.request("close", { agentId: agent.agentId }); setConfirmClose(false); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const requestClose = (trigger: HTMLElement): void => {
    if (changed || draft.name.trim() !== agent.name.trim() || renaming || busy || testRun?.status === "running" || recordingActive) {
      dialogTriggerRef.current = trigger; setConfirmClose(true);
    } else void close();
  };
  const insertStep = (): void => {
    const id = `inserted-${Date.now()}`;
    setInsertedStepId(id);
    update({ steps: [...draft.steps, { id, type: "agent", description: "" }] });
  };

  return <main className="agent-setup edit-agent">
    <header className="setup-header edit-header">
      <button className="icon-button" aria-label="Back to web agents" title="Back to web agents" disabled={dialogOpen} onClick={(e) => requestClose(e.currentTarget)}><EditIcon name="back" /></button>
      <div className="edit-heading">
        <h1 className="visually-hidden">Edit web agent</h1>
        <div className="edit-title">
          <label className="edit-name"><span>Agent name</span><input value={draft.name} size={Math.max(12, draft.name.length)} disabled={agent.internal || renaming || busy} aria-invalid={renameError !== null} aria-describedby={renameError ? "rename-error" : undefined}
            onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setRenameSaved(false); setNotice(null); }}
            onBlur={(e) => void rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === "Escape") { e.preventDefault(); setDraft({ ...draft, name: agent.name }); setRenameError(null); setRenameSaved(false); }
            }} /></label>
          <span className="edit-rename-status" role="status">{renaming ? "Saving…" : renameSaved ? "Saved" : ""}</span>
          <span className="edit-version">Live v{agent.version}</span>
          {agent.schedule && <span className="edit-schedule">{agent.schedule}{agent.nextRunAt ? ` · next run ${formatConflictDate(agent.nextRunAt)}` : ""}</span>}
        </div>
        {renameError && <p id="rename-error" className="edit-rename-error" role="alert">{renameError}</p>}
      </div>
      <button className="icon-button" aria-label="Close edit page" title="Close edit page" disabled={dialogOpen} onClick={(e) => requestClose(e.currentTarget)}><EditIcon name="close" /></button>
    </header>
    <section className="edit-layout" aria-busy={busy}>
      {agent.internal && <p className="edit-notice"><b>Read-only internal agent</b><br />Managed by Operations. Publishing changes is disabled.</p>}
      {error && <div className="edit-result edit-result-failed" role="alert">{error}</div>}
      {notice && <p className="edit-result edit-result-succeeded" role="status">{notice}</p>}
      <div className="edit-grid"><div className="edit-main">
        <section className="edit-card"><h2>Details</h2>
          <label>Website address<input aria-label="Website address" value={draft.url} disabled={readOnly} onChange={(e) => update({ url: e.target.value })} /></label>
          <label>Goal{raw && <span className="field-note">Describes the agent. Change its actions in Advanced instructions.</span>}<textarea aria-label="What should the agent do?" value={draft.goal} disabled={readOnly} onChange={(e) => update({ goal: e.target.value })} /></label>
        </section>
        {raw ? <section className="edit-card"><h2>Advanced instructions</h2>
          {stages.map((stage, index) => { const item = isObject(stage) ? stage : null; return item?.type === "agent" ? <div className="raw-stage" key={index}>
            <label>Agent instructions<textarea aria-label="Agent stage prompt" value={String(item.prompt ?? "")} disabled={readOnly} onChange={(e) => updateStage(index, { prompt: e.target.value })} /></label>
            <label>Maximum actions<input aria-label="Maximum actions" type="text" inputMode="numeric" value={stageLimitInputs[index] ?? String(item.step_limit ?? 1)} disabled={readOnly} aria-invalid={stageLimitErrors[index] ?? false} aria-describedby={stageLimitErrors[index] ? `stage-limit-error-${index}` : undefined}
              onChange={(e) => {
                const value = e.target.value;
                setStageLimitInputs((current) => ({ ...current, [index]: value }));
                setStageLimitErrors((current) => ({ ...current, [index]: false }));
                if (validStepLimit(value)) updateStage(index, { step_limit: Number(value) });
                else resetTest();
              }}
              onBlur={(e) => setStageLimitErrors((current) => ({ ...current, [index]: !validStepLimit(e.target.value) }))} />
              {stageLimitErrors[index] && <span id={`stage-limit-error-${index}`} className="edit-rename-error" role="alert">Enter a whole number of 1 or more.</span>}
              <span className="field-note">The agent stops after this many browser actions.</span></label>
          </div> : <div className="raw-preserved" key={index}><span>{preservedStageLabel(item)}</span><span className="raw-unchanged">Kept as is</span></div>; })}
        </section> : <section className="edit-card"><h2>Steps</h2>
          <div className="edit-steps">{draft.steps.map((step, index) => <div className="edit-step" key={step.id}>
            <b>{index + 1}</b>
            <div>
              <label><span className="edit-field-label">Instruction</span><textarea ref={step.id === insertedStepId ? insertedStepRef : undefined} rows={1} placeholder="Describe the action" aria-label={`Step ${index + 1} description`} value={step.description} disabled={readOnly} onChange={(e) => update({ steps: draft.steps.map((item) => item.id === step.id ? { ...item, description: e.target.value } : item) })} /></label>
              <label><span className="edit-field-label">Expected outcome (optional)</span><textarea rows={1} placeholder="What should happen?" aria-label={`Step ${index + 1} expected outcome`} value={step.expectedOutcome ?? ""} disabled={readOnly} onChange={(e) => update({ steps: draft.steps.map((item) => item.id === step.id ? { ...item, expectedOutcome: e.target.value } : item) })} /></label>
            </div>
            <div className="edit-step-controls">
              <button className="icon-button" aria-label={`Move step ${index + 1} up`} title={`Move step ${index + 1} up`} disabled={readOnly || index === 0} onClick={() => update({ steps: moveStep(draft.steps, index, -1) })}><EditIcon name="up" /></button>
              <button className="icon-button" aria-label={`Move step ${index + 1} down`} title={`Move step ${index + 1} down`} disabled={readOnly || index === draft.steps.length - 1} onClick={() => update({ steps: moveStep(draft.steps, index, 1) })}><EditIcon name="down" /></button>
              <button className="icon-button" aria-label={`Remove step ${index + 1}`} title={`Remove step ${index + 1}`} disabled={readOnly} onClick={() => update({ steps: draft.steps.filter((item) => item.id !== step.id) })}><EditIcon name="close" /></button>
            </div>
          </div>)}</div>
          <div className="redemo-controls">
            <div className="edit-actions"><button className="button button-quiet" disabled={readOnly} onClick={insertStep}>Insert step</button><label>Re-demonstrate from step<select aria-label="Re-demonstrate from step" value={selectedFromStep} disabled={readOnly || draft.steps.length === 0} onChange={(e) => setFromStep(Number(e.target.value))}>{draft.steps.map((_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>
              <button className="button button-quiet" disabled={readOnly} onClick={() => void startRecording()}>Re-demonstrate</button>
              {recordingActive && <button className="button button-primary" disabled={busy} onClick={() => void stopRecording()}>Finish re-demonstration</button>}
            </div>
            <p>Replaces step {selectedFromStep + 1} and every later step with a new demonstration.</p>
          </div>
          {recording?.blockedReason && <p className="edit-result edit-result-failed" role="alert">Cannot continue: {recording.blockedReason}</p>}
          {recording?.status === "expired" && <p className="edit-result edit-result-failed" role="alert">Demonstration expired. Re-demonstrate again.</p>}
          {recordingActive && <div className="browser-frame edit-recording">{browserbaseLiveViewUrl(recording.liveViewUrl) ? <iframe title="Virtual browser" src={browserbaseLiveViewUrl(recording.liveViewUrl)!} allow="clipboard-read; clipboard-write" /> : <p>Opening the virtual browser.</p>}</div>}
        </section>}
        <section className="edit-card"><h2>Test &amp; publish</h2><p>Timers continue using the live version until you publish.</p>
          {testRun?.status === "running" && <div className="edit-status" role="status"><span className="edit-spinner" aria-hidden="true" />Test is running.{testRun.liveViewUrl && <a href={testRun.liveViewUrl} target="_blank" rel="noreferrer">Watch the test</a>}</div>}
          {testRun?.status === "failed" && <div className="edit-result edit-result-failed" role="alert"><b>Test failed</b><p>{testRun.failure?.message ?? testRun.error}</p></div>}
          {succeeded && <div className="edit-result edit-result-succeeded" role="status"><b>Test completed</b>{testRun.files && testRun.files.length > 0 && <ul className="edit-files">{testRun.files.map((file) => <li key={file.url}><a href={file.url} target="_blank" rel="noreferrer">{file.name}</a></li>)}</ul>}</div>}
          <div className="edit-actions">
            <button className={`button ${succeeded ? "button-quiet" : "button-primary"}`} aria-busy={operation === "test"} disabled={busy || agent.internal || testRun?.status === "running" || recordingActive} onClick={() => void test()}>{operation === "test" ? "Starting test…" : testRun?.status === "failed" ? "Run test again" : succeeded ? "Test again" : "Test changes"}</button>
            {succeeded && <label className="result-check"><input aria-label="I checked the result" type="checkbox" checked={checked} disabled={readOnly} onChange={(e) => setChecked(e.target.checked)} /> I checked the result</label>}
            <button className={`button ${succeeded ? "button-primary" : "button-quiet"}`} aria-describedby="edit-publish-help" aria-busy={operation === "publish"} disabled={!canPublish || busy} onClick={(e) => { dialogTriggerRef.current = e.currentTarget; setPublishOpen(true); }}>{operation === "publish" ? "Publishing…" : "Publish changes"}</button>
          </div>
          <p id="edit-publish-help">{publishHelp}</p>
        </section>
      </div><aside className="edit-rail"><section className="edit-card"><h2>Changes</h2>
        {changes.length === 0 ? <p>No changes yet.</p> : changes.map((change) => <div className="change-item" key={change.key}><b>{change.label}</b><span>{change.from || "Empty"} → {change.to || "Empty"}</span><button className="text-button" aria-label={`Revert ${change.label}`} disabled={readOnly} onClick={() => revert(change.key)}>Revert</button></div>)}
      </section></aside></div>
    </section>
    {confirmClose && <div className="close-confirmation" role="dialog" aria-modal="true" aria-labelledby="close-edit-title" aria-describedby="close-edit-description"><div className="close-confirmation-card" ref={modalRef} tabIndex={-1}>
      <h2 id="close-edit-title">Discard your changes?</h2><p id="close-edit-description">Your unpublished changes and any active test or re-demonstration will be left behind.</p>
      <div className="edit-actions"><button className="button button-quiet" onClick={() => setConfirmClose(false)} disabled={busy}>Keep editing</button><button className="button button-danger" onClick={() => void close()} disabled={busy}>Discard changes</button></div>
    </div></div>}
    {publishOpen && <div className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="publish-edit-title" aria-describedby="publish-edit-description"><div className="edit-modal-card" ref={modalRef} tabIndex={-1}>
      <h2 id="publish-edit-title">Publish changes?</h2><p id="publish-edit-description">Publish {changes.length} {changes.length === 1 ? "change" : "changes"} to this agent.</p>
      {agent.schedule && <p className="edit-notice">Timers will use v{agent.version + 1} at the next run time.</p>}
      <div className="edit-actions"><button className="button button-quiet" disabled={busy} onClick={() => setPublishOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy} aria-busy={operation === "publish"} onClick={() => void publish(false)}>{operation === "publish" ? "Publishing…" : "Publish"}</button></div>
    </div></div>}
    {conflict && <div className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="conflict-edit-title" aria-describedby="conflict-edit-description"><div className="edit-modal-card conflict-modal" ref={modalRef} tabIndex={-1}>
      <h2 id="conflict-edit-title">This agent changed while you were editing</h2>
      <div id="conflict-edit-description"><p>{conflict.updatedBy ?? "An unknown user"} saved it at {conflict.updatedAt ? formatConflictDate(conflict.updatedAt) : "an unknown time"}.</p><p>Reloading their version or publishing yours discards the other version's changes permanently.</p></div>
      <div className="edit-actions"><button className="button button-quiet" disabled={busy} onClick={() => setConflict(null)}>Cancel</button><button className="button button-quiet" disabled={busy} onClick={() => void load()}>Reload their version</button><button className="button button-danger" disabled={busy} aria-busy={operation === "publish"} onClick={() => void publish(true)}>{operation === "publish" ? "Publishing…" : "Publish mine anyway"}</button></div>
    </div></div>}
  </main>;
}

function validStepLimit(value: string): boolean { return value.trim() !== "" && Number.isInteger(Number(value)) && Number(value) >= 1; }

function EditIcon({ name }: { name: "back" | "up" | "down" | "close" }): JSX.Element {
  const path = { back: "M19 12H5m6-6-6 6 6 6", up: "M12 19V5m-6 6 6-6 6 6", down: "M12 5v14m-6-6 6 6 6-6", close: "M6 6l12 12M18 6L6 18" }[name];
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none"><path d={path} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function moveStep(steps: SetupStep[], index: number, delta: number): SetupStep[] { const next = [...steps]; const target = index + delta; if (target < 0 || target >= next.length) return next; [next[index], next[target]] = [next[target]!, next[index]!]; return next; }
function rawStageChanges(current: unknown[], live: unknown[]): Array<{ key: string; label: string; from: string; to: string }> { return JSON.stringify(current) === JSON.stringify(live) ? [] : [{ key: "stages", label: "Agent stages", from: "Live instructions", to: "Edited instructions" }]; }
function preservedStageLabel(stage: Record<string, unknown> | null): string {
  switch (stage?.type) {
    case "download": return "Download stage";
    case "sleep": return `Sleep stage · ${Number(stage.sleep_ms ?? 10000) / 1000} s`;
    case "reload": return "Reload stage";
    default: return "Preserved stage";
  }
}
function formatConflictDate(value: string): string { const date = new Date(value); return `${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}.${date.getFullYear()} at ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; }

function Describe(props: { name: string; url: string; goal: string; busy: boolean; onName(value: string): void; onUrl(value: string): void; onGoal(value: string): void; onContinue(): void }): JSX.Element {
  return <div className="setup-panel setup-panel-compact"><div className="stage-title"><h2>Describe the job</h2><p>Start with the website and the result you want. You will demonstrate the task next.</p></div><p className="credential-warning">{signInNote}</p><label>Agent name<input aria-label="Agent name" value={props.name} onChange={(event) => props.onName(event.target.value)} autoComplete="off" /></label><label>Website address<input aria-label="Website address" value={props.url} onChange={(event) => props.onUrl(event.target.value)} placeholder="https://example.com" inputMode="url" autoComplete="off" /></label><label>What should the agent do?<textarea aria-label="What should the agent do?" value={props.goal} onChange={(event) => props.onGoal(event.target.value)} placeholder="For example: download the monthly statement for the selected month." /></label><div className="setup-actions"><button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy}>Continue to demonstration</button></div></div>;
}

function Demonstrate(props: { recording: Recording | null; steps: SetupStep[]; liveViewUrl: string | null; busy: boolean; onStop(): void; onReview(): void; onReset(): void }): JSX.Element {
  const stepsRef = useRef<HTMLDivElement>(null);
  const isRecording = props.recording?.status === "recording";
  const state = props.recording?.status === "expired" ? "Demonstration expired" : isRecording ? "Recording in progress" : "Demonstration finished";
  const browserMessage = isRecording
    ? "Opening the virtual browser."
    : props.recording?.status === "stopped"
      ? "Demonstration finished. Review the recorded steps to continue."
      : "The virtual browser is unavailable for this demonstration.";

  // Follow new steps while recording, unless the user scrolled up to read earlier ones. Whether to follow is
  // decided from the user's own scrolling, so a large batch of new steps does not stop the follow.
  const followRef = useRef(true);
  useEffect(() => {
    const list = stepsRef.current;
    if (list === null || !isRecording || !followRef.current) return;
    list.scrollTop = list.scrollHeight;
  }, [props.steps.length, isRecording]);
  const onStepsScroll = (): void => {
    const list = stepsRef.current;
    if (list !== null) followRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  };

  return (
    <div className="setup-panel demonstrate">
      <div className="demonstrate-heading">
        <div className="stage-title">
          <h2>Demonstrate the task</h2>
          <p>Show each step you want the agent to follow. You can review and edit the steps afterwards.</p>
        </div>
        <div className={`recording-state ${isRecording ? "recording-state-active" : ""}`} role="status"><span aria-hidden="true" />{state}</div>
      </div>
      <p className="credential-warning">{signInNote}</p>
      {props.recording?.blockedReason !== null && props.recording?.blockedReason !== undefined && <div className="setup-error" role="alert">Cannot continue: {props.recording.blockedReason}</div>}
      {props.recording?.status === "expired" && <div className="setup-error" role="alert">Recording expired. Start a new demonstration.</div>}
      <div className="demonstration-grid">
        <div className="browser-frame">
          {props.liveViewUrl === null
            ? <p>{browserMessage}</p>
            // Clipboard access must be delegated explicitly or paste does nothing in the remote browser.
            : <iframe title="Virtual browser" src={props.liveViewUrl} allow="clipboard-read; clipboard-write" />}
        </div>
        <aside className="captured-steps" aria-label="Captured demonstration steps">
          <h3>Recorded steps <span className="captured-steps-count">{props.steps.length}</span></h3>
          <div className="captured-steps-list" ref={stepsRef} onScroll={onStepsScroll} tabIndex={0} aria-label="Recorded steps list">
            {props.steps.length === 0 ? <p>Actions will appear here while you demonstrate.</p> : <ol>{props.steps.map((step) => <li key={step.id}>{step.description}</li>)}</ol>}
          </div>
        </aside>
      </div>
      <div className="setup-actions">
        <button className="button button-quiet" type="button" onClick={props.onReset} disabled={props.busy}>Start over</button>
        {isRecording && <button className="button button-primary" type="button" onClick={props.onStop} disabled={props.busy}>Finish demonstration</button>}
        {props.recording?.status === "stopped" && <button className="button button-primary" type="button" onClick={props.onReview} disabled={props.busy}>Continue to review</button>}
      </div>
    </div>
  );
}

function Review(props: { steps: SetupStep[]; busy: boolean; onUpdateStep(id: string, updates: Partial<SetupStep>): void; onRemoveStep(id: string): void; onBack(): void; onContinue(): void }): JSX.Element {
  function setFieldKind(step: SetupStep, kind: CredentialKind | ""): void {
    const field = step.target ?? "the field";
    // Switching to a sign-in field drops the typed value; it is saved separately in Reiterate.
    props.onUpdateStep(step.id, kind === ""
      ? { type: "input", value: "", description: `Fill in ${field}` }
      : { type: "credential", value: kind, description: `Enter the saved ${credentialLabel(kind)} in ${field}` });
  }
  return (
    <div className="setup-panel">
      <div className="stage-title">
        <h2>Review the draft</h2>
        <p>Make each instruction clear. Typed text and choices are repeated on every run; sign-in fields use details you save in Reiterate.</p>
      </div>
      <div className="review-list">
        <div className="review-columns" aria-hidden="true">
          <span>#</span>
          <span>Instruction</span>
          <span>Expected outcome <em>optional</em></span>
        </div>
        <ol>
          {props.steps.map((step, index) => {
            const typedField = step.type === "input" || step.type === "credential";
            return (
              <li className="review-step" key={step.id}>
                <span className="review-step-number">{index + 1}</span>
                <textarea rows={1} aria-label={`Step ${index + 1} description`} value={step.description} onChange={(event) => props.onUpdateStep(step.id, { description: event.target.value })} />
                <textarea rows={1} aria-label={`Step ${index + 1} expected outcome`} placeholder="Add what should be visible" value={step.expectedOutcome ?? ""} onChange={(event) => props.onUpdateStep(step.id, { expectedOutcome: event.target.value || undefined })} />
                <button type="button" className="icon-button" aria-label={`Remove step ${index + 1}`} title="Remove step" onClick={() => props.onRemoveStep(step.id)} disabled={props.busy}>
                  <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                </button>
                {(typedField || step.type === "select_change") && (
                  <div className="review-step-note">
                    {typedField && (
                      <label className="review-step-kind">
                        Field
                        <select aria-label={`Step ${index + 1} field type`} value={step.type === "credential" ? step.value ?? "" : ""} onChange={(event) => setFieldKind(step, event.target.value as CredentialKind | "")}>
                          <option value="">Text</option>
                          <option value="username">Saved username</option>
                          <option value="password">Saved password</option>
                          <option value="otp">Saved one-time code</option>
                        </select>
                      </label>
                    )}
                    {step.type !== "credential" && (
                      <label className="review-step-value">
                        {step.type === "select_change" ? "Choose" : "Type"}
                        {step.type === "select_change"
                          ? <input aria-label={`Step ${index + 1} option`} value={step.value ?? ""} placeholder="Option to choose" onChange={(event) => props.onUpdateStep(step.id, choiceUpdate(step, event.target.value))} autoComplete="off" />
                          : <textarea rows={1} aria-label={`Step ${index + 1} text`} value={step.value ?? ""} placeholder="Leave empty to clear the field" onChange={(event) => props.onUpdateStep(step.id, { value: event.target.value })} />}
                      </label>
                    )}
                    {step.type === "credential" && <span>Uses the {credentialLabel(step.value)} from your demonstration, stored encrypted; never part of these instructions.</span>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <div className="setup-actions">
        <button className="button button-quiet" type="button" onClick={props.onBack} disabled={props.busy}>Back to demonstration</button>
        <button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy}>Continue to test</button>
      </div>
    </div>
  );
}

function Test(props: {
  steps: SetupStep[]; url: string; scheduleRecovery: boolean; emailRoutesAllowed: boolean; textAllowed: boolean; doneWhen: DoneWhen;
  onDoneWhen(value: DoneWhen): void; onChooseEmail(): void; onAllowEmail(): void; onChangeCredentials(): void; run: RunState | null; busy: boolean; emailStatus: "waiting" | "routed" | "rejected" | "no_documents" | "timeout" | null; emailFrom: string | null; emailFiles: Array<{ name: string; url: string }>; canContinue: boolean;
  onRun(): void; onSchedule(): void; onBack(): void; onEditStep(id: string, description: string): void;
}): JSX.Element {
  const [screenIndex, setScreenIndex] = useState<number | null>(null);
  const [customText, setCustomText] = useState(props.doneWhen.kind === "described" ? props.doneWhen.value : "");
  const rowsRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDetailsElement>(null);
  const emailRun = props.doneWhen.kind === "email" && props.run?.status === "succeeded";
  const emailProblem = emailRun && ["rejected", "no_documents", "timeout"].includes(props.emailStatus ?? "");
  const failed = props.run?.status === "failed" || emailProblem;
  const passed = props.run?.status === "succeeded" && (!emailRun || props.emailStatus === "routed");
  const running = props.run?.status === "running";
  const locked = props.busy || running || props.scheduleRecovery;
  const stopped = props.run?.stoppedAtStep && Number.isInteger(props.run.stoppedAtStep) && props.run.stoppedAtStep > 0 && props.run.stoppedAtStep <= props.steps.length ? props.run.stoppedAtStep - 1 : null;
  const failureMessage = props.run?.failure?.message ?? props.run?.error;
  const criterionNotMet = props.run?.status === "failed" && failureMessage?.startsWith("Success criterion not met: ");
  const kind = criterionNotMet ? "check" : props.run?.failure?.kind;
  const failedStep = (kind === "steps" || kind === "signin" || kind === "website" || kind === "unknown") && stopped !== null;
  const completedSteps = props.run?.status === "succeeded" || kind === "result" || kind === "check";
  const options = doneWhenOptions(props.steps, props.run ? { confirmation: props.run.confirmation, failureKind: kind, files: props.run.files } : null, props.doneWhen)
    .filter((option) => (option.action !== "email" || props.emailRoutesAllowed) && (props.textAllowed || option.doneWhen?.kind !== "text"));
  const screens = props.run?.screens ?? [];
  const currentIndex = screenIndex === null ? screens.length - 1 : Math.min(screenIndex, screens.length - 1);
  const currentScreen = screens[currentIndex];
  const currentThought = useMemo(() => parseAgentThought(currentScreen?.thought ?? ""), [currentScreen?.thought]);
  const files = props.doneWhen.kind === "email" ? props.emailFiles : props.run?.files ?? [];
  const statusText = props.emailStatus === "rejected" && emailRun ? `The export arrived from ${props.emailFrom ?? "an external sender"}`
    : props.emailStatus === "no_documents" && emailRun ? "The email arrived without a file"
    : props.emailStatus === "timeout" && emailRun ? "The export email didn’t arrive"
    : props.emailStatus === "routed" && emailRun ? "The export arrived in Reiterate"
    : kind === "service" ? "Reiterate couldn’t run the test"
    : kind === "signin" ? "The website didn’t accept the sign-in"
    : kind === "steps" && stopped !== null ? `Stuck at step ${stopped + 1}`
    : kind === "result" ? "Every step ran, but no file was downloaded"
    : criterionNotMet ? "The success criterion wasn’t met"
    : kind === "check" ? "The website result wasn’t confirmed"
    : failed ? "The test stopped" : passed ? "The agent completed every step"
    : emailRun ? "Waiting for the export email" : running ? "Test is running" : "Not tested yet";
  const serviceFailure = kind === "service";
  const statusDetail = serviceFailure ? (stopped !== null
      ? `Reiterate’s AI service stopped responding at step ${stopped + 1}. Run the test again in a few minutes. Your steps do not need changing.`
      : "The agent stopped before it opened the website because Reiterate’s AI service didn’t respond. None of your steps were tried. Run the test again in a few minutes. Your steps do not need changing.")
    : emailRun && props.emailStatus === "rejected" ? `New Reiterate addresses only accept email from you. Allow ${props.emailFrom ?? "this sender"}, then run the test again.`
    : emailRun && props.emailStatus === "no_documents" ? "The email arrived without a file. Check the export settings and run the test again."
    : emailRun && props.emailStatus === "timeout" ? "The email didn’t arrive within three minutes. Check the export settings and run the test again."
    : emailRun && props.emailStatus === "waiting" ? `Waiting for the export at ${props.doneWhen.kind === "email" ? props.doneWhen.address : "Reiterate"}.`
    : criterionNotMet ? failureMessage!.slice("Success criterion not met: ".length)
    : kind === "steps" ? "The steps before it worked. Rewrite the highlighted step below, then run the test again."
    : kind === "signin" ? "Check the saved sign-in details, then run the test again."
    : kind === "result" ? "Choose how Reiterate knows the run worked under Done when."
    : passed && props.doneWhen.kind === "described" && props.run?.confirmation ? `Agent saw: ${props.run.confirmation}`
    : props.run?.status === "succeeded" && !emailRun && files.length === 0 ? "Reiterate doesn’t keep a file from this run, so workflows can’t use its output."
    : running ? "Watch the browser while the agent works through your steps."
    : props.run?.failure?.message ?? (failed ? props.run?.error : props.run?.confirmation) ?? "";
  useEffect(() => { setScreenIndex(null); }, [props.run?.id]);
  useEffect(() => {
    if (running) return;
    if (props.run?.id && optionsRef.current) optionsRef.current.open = kind === "result" || kind === "check";
    const target = failedStep ? rowsRef.current?.querySelectorAll<HTMLElement>(".test-step")[stopped!] : kind === "result" || kind === "check" ? rowsRef.current?.querySelector<HTMLElement>(".done-when") : null;
    const list = rowsRef.current;
    if (list && target) list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - 16;
    else if (list && completedSteps) list.scrollTop = list.scrollHeight;
  }, [props.run?.id, running, failedStep, stopped, kind, completedSteps]);
  const choose = (option: typeof options[number]): void => {
    if (option.action === "email") return props.onChooseEmail();
    if (option.action === "custom") { if (customText.trim()) props.onDoneWhen({ kind: "described", value: customText.trim() }); return; }
    if (option.doneWhen) props.onDoneWhen(option.doneWhen);
  };
  return <div className="setup-workbench">
    <div className="stage-title stage-title-inline"><h2>Verify agent can follow the process</h2><HelpTip label="How the test works">Reiterate runs your steps in a new browser. Watch it work, and if it stops, fix the step in the list.</HelpTip></div>
    <div className="workbench-grid">
      <section className="test-browser" aria-label="Agent browser">
        <div className="test-browser-bar"><span aria-hidden="true">● ● ●</span><div>{props.run ? props.url : "about:blank"}</div><b>{running ? "Live · view only" : props.run ? "Finished run" : "Not started"}</b></div>
        {running ? <WatchOnlyBrowser url={props.run?.liveViewUrl ?? null} /> : currentScreen ? <><img src={currentScreen.image} alt="Agent browser screen" /><AgentScreenBar thought={currentThought} index={currentIndex} count={screens.length} onSelect={(index) => setScreenIndex(Math.max(0, Math.min(screens.length - 1, index)))} /></> : <div className="empty-browser"><b>{serviceFailure ? "The agent has not opened the website." : passed ? "The agent finished the run." : "Run the test to watch the agent."}</b><span>{serviceFailure ? "Nothing ran in this browser." : "The agent’s browser appears here while it works through your steps."}</span></div>}
      </section>
      <aside className="test-rail" aria-label="Test steps"><header><h3>{props.run ? "Test result" : "Your steps"}</h3><span>{props.run ? `${completedSteps ? props.steps.length : failedStep ? stopped! + 1 : 0} of ${props.steps.length} reached` : `${props.steps.length} steps`}</span></header>
        <div className={`run-status ${failed ? "bad" : passed ? "good" : ""}`} role={failed ? "alert" : "status"}><small>{serviceFailure ? "Reiterate problem · not your steps" : kind === "steps" ? "Step needs clearer wording" : kind === "signin" ? "Sign-in problem" : kind === "result" ? "No file came back" : kind === "check" ? "Done-when check not met" : emailProblem ? props.emailStatus === "rejected" ? "Email not accepted" : "Email not received" : passed ? "Test passed" : running ? "Test running" : emailRun ? "Waiting for email" : failed ? "Test failed" : "Not tested yet"}</small><strong>{statusText}</strong><p>{props.run ? statusDetail : "Run the test to watch the agent work through these steps in a fresh browser."}</p>{!serviceFailure && props.run?.failure?.message && kind !== "result" && kind !== "check" && <blockquote><b>The agent said</b>{props.run.failure.message}</blockquote>}{emailRun && props.emailStatus === "rejected" && props.emailFrom && <button type="button" className="button button-primary" onClick={props.onAllowEmail} disabled={locked}>Accept emails from {props.emailFrom}</button>}{kind === "signin" && <button type="button" className="button button-quiet" onClick={props.onChangeCredentials} disabled={locked}>Change sign-in details</button>}</div>
        <div className="test-steps" ref={rowsRef} tabIndex={0} aria-label="Test steps list">{props.steps.map((step, index) => { const done = completedSteps || (failedStep && index < stopped!); const isFailed = failedStep && index === stopped; const relativeDate = lastMonthRewrite(step.description); return <div key={step.id} className={`test-step ${done ? "done" : isFailed ? "failed" : props.run?.status === "failed" && !serviceFailure && failedStep && index > stopped! ? "notrun" : serviceFailure ? "notrun" : ""}`}><span>{done ? "✓" : isFailed ? "!" : index + 1}</span><div>{isFailed ? <textarea aria-label={`Step ${index + 1} instruction`} disabled={locked} value={step.description} onChange={(event) => props.onEditStep(step.id, event.target.value)} /> : step.description}{step.type === "credential" && <small>Uses the {credentialLabel(step.value)} saved in Reiterate, stored encrypted. <button type="button" className="text-button" onClick={props.onChangeCredentials} disabled={locked}>Change</button></small>}{isFailed && <small>Stopped here · <button type="button" className="text-button" onClick={() => setScreenIndex(null)}>Show screen</button></small>}{relativeDate && <small>Fixed date: every run picks this day <button type="button" className="date-chip" disabled={locked} onClick={() => props.onEditStep(step.id, relativeDate)}>Use last month</button></small>}</div></div> })}
          <div className={`done-when ${passed ? "done" : kind === "result" || kind === "check" || emailProblem ? "failed" : ""}`}><b>Done when</b><div>{props.doneWhen.kind === "file" ? "A file is downloaded in the browser" : props.doneWhen.kind === "described" ? `The agent confirms: ${props.doneWhen.value}` : props.doneWhen.kind === "text" ? `“${props.doneWhen.value}” appears on the page` : props.doneWhen.kind === "email" ? `The export arrives at ${props.doneWhen.address}` : `The agent clicks “${props.doneWhen.value}”`}</div>{files.map((file) => { const link = safeFileUrl(file.url); return link && <a href={link} target="_blank" rel="noreferrer" key={`${file.name}:${file.url}`}>↓ {file.name}</a>; })}{!running && <details className="done-options" ref={optionsRef}><summary>Change</summary><p>{props.run === null ? "Suggested from your steps." : "Suggested from your steps and from what the agent saw at the end of this test."}</p>{options.map((option) => <div key={option.label}><button type="button" className={option.doneWhen && JSON.stringify(option.doneWhen) === JSON.stringify(props.doneWhen) ? "selected" : ""} disabled={locked} onClick={() => choose(option)}><strong>{option.label}</strong><span className="option-badges">{option.recommended && <em>Recommended</em>}{option.strength && <em className={option.strength}>{option.strength === "strong" ? "Strong evidence" : option.strength === "medium" ? "Some evidence" : "Weak evidence"}</em>}</span><small>{option.why}</small></button>{option.action === "custom" && <textarea rows={2} aria-label="Success criterion" disabled={locked} maxLength={300} placeholder="For example: a message says the export was emailed to me" value={customText} onChange={(event) => setCustomText(event.target.value)} onBlur={() => { if (customText.trim()) props.onDoneWhen({ kind: "described", value: customText.trim() }); }} />}</div>)}</details>}</div>
        </div>
        <footer><button type="button" className="text-button" onClick={props.onBack} disabled={locked}>Back to review</button><span /><button type="button" className={`button ${props.canContinue ? "button-quiet" : "button-primary"}`} onClick={props.onRun} disabled={locked}>{running ? "Running…" : props.run ? "Run test again" : "Run test"}</button>{props.canContinue && <button type="button" className="button button-primary" onClick={props.onSchedule}>Continue to schedule</button>}</footer>
      </aside>
    </div>
  </div>;
}

function lastMonthRewrite(description: string): string | null {
  const match = /^Click (\d{1,2}) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/i.exec(description);
  if (!match) return null;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[2]!.toLowerCase());
  const day = Number(match[1]);
  const last = new Date(Date.UTC(Number(match[3]), month + 1, 0)).getUTCDate();
  return day === 1 ? "Click the first day of last month" : day === last ? "Click the last day of last month" : null;
}

function safeFileUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null; }
  catch { return null; }
}

/** Shows the test's browser without letting the user click, type, or scroll into it. */
function WatchOnlyBrowser(props: { url: string | null }): JSX.Element {
  return <div className="browser-frame watch-only">{props.url === null ? <p>Opening the virtual browser.</p> : <><iframe title="Test browser (view only)" src={props.url} tabIndex={-1} {...{ inert: "" }} /><div className="watch-only-shield" aria-hidden="true" /></>}</div>;
}

// "portal.example.com" means https://portal.example.com; anything with a scheme is left for startUrlError to judge.
function withScheme(value: string): string {
  const trimmed = value.trim();
  return trimmed === "" || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
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

// The recorder writes "Choose <option> in <menu>"; keep that description in step with an edited option.
function choiceUpdate(step: SetupStep, value: string): Partial<SetupStep> {
  const menu = step.target ?? "menu";
  const recorded = `Choose ${step.value || "option"} in ${menu}`;
  return step.description === recorded ? { value, description: `Choose ${value || "option"} in ${menu}` } : { value };
}

function credentialLabel(kind: string | null | undefined): string {
  return kind === "otp" ? "one-time code" : kind ?? "sign-in detail";
}

// A daily cron is stored in UTC. Converting with today's offset means the local time shifts by an hour at DST changes.
function localTimeToUtcCron(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return `${date.getUTCMinutes()} ${date.getUTCHours()} * * *`;
}

function isRecording(value: unknown): value is Recording {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string";
}


function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "Something went wrong. Retry to continue.";
}
