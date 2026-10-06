import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { applyOrganizedSteps, compileAgent, credentialKinds, dateRuleChoices, dateRuleLabel, doneWhenOptions, draftChanges, findUnambiguousEmailStep, formatDate, groupSteps, mergeDateSteps, openQuestions, replaceStepsFrom, requiredCredentials, resolveDateRule, StepValidationError, type CredentialKind, type DateRule, type DoneWhen, type SetupDraft, type SetupStep } from "./compiler";
import { browserbaseLiveViewUrl, createHostBridge, HostRequestTimeoutError, type EditAgent as EditAgentData, type HostBridge, type RecordedDownload, type Recording } from "./host";
import { HelpTip } from "./HelpTip";
import { RunScreen, RunView } from "./RunView";
import { applyTestRunUpdate, failureLabel, safeFileUrl, type WorkbenchRun } from "./testRun";
import { ActivityLog, TestBrowser } from "./TestWorkbench";
import "./setup.css";

type Screen = "describe" | "demonstrate" | "review" | "test" | "schedule";

type RunState = WorkbenchRun & {
  files: Array<{ name: string; url: string }>;
  revision: number;
  startedAt: string;
};

// Entering sign-in details or choosing a schedule in the host dialog can take a while.
const interactiveRequestTimeoutMs = 10 * 60_000;
const signInNote = "If the website needs a sign-in, sign in during the demonstration. Reiterate saves the username and password you type there, encrypted, for this agent's runs. They never appear in the steps or the agent's instructions.";
const demonstrateSignInNote = "Sign in here if the site asks. Reiterate saves the username and password encrypted for this agent's runs; they never appear in the steps. Entering an email code here is a manual demonstration; an automatic Test run verifies retrieval.";
// Google's default second step is a number to tap in the Gmail app. An authenticator code is the step users can repeat later, e.g. for Connect Google.
const googleAuthenticatorSetupUrl = "https://myaccount.google.com/two-step-verification/authenticator";

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
  const [googleAllowed, setGoogleAllowed] = useState(false);
  const [savedCredentials, setSavedCredentials] = useState<CredentialKind[]>([]);
  const [otpSource, setOtpSource] = useState<"authenticator" | "email" | undefined>();
  const [mode, setMode] = useState<"create" | "edit" | "run" | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [runCloseError, setRunCloseError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<StepValidationError | null>(null);
  const [stepFocus, setStepFocus] = useState<string | null>(null);
  const stepFieldRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);

  const draft = useMemo<SetupDraft>(() => ({ name, url, goal, steps, inputs: [], doneWhen }), [name, url, goal, steps, doneWhen]);
  const liveViewUrl = browserbaseLiveViewUrl(recording?.liveViewUrl ?? null);
  const canContinue = testRun?.status === "succeeded" && (doneWhen.kind !== "email" || emailStatus === "routed") && testRun.revision === revision && !busy;
  // The number is read from the current order, so it stays right if steps move.
  const stepErrorIndex = stepError === null ? -1 : steps.findIndex((step) => step.id === stepError.stepId);

  // A new stage replaces the button that opened it, so focus would fall back to the page. Start on the new stage's heading.
  const contentRef = useRef<HTMLElement>(null);
  const shownScreenRef = useRef(screen);
  useEffect(() => {
    if (shownScreenRef.current === screen) return;
    shownScreenRef.current = screen;
    const heading = contentRef.current?.querySelector<HTMLElement>(".stage-title h2");
    if (heading === null || heading === undefined) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [screen]);

  // Runs after the heading focus above, so going back to Review for a step lands on that step.
  useEffect(() => {
    if (stepFocus === null) return;
    setStepFocus(null);
    focusStepInstruction(stepFieldRefs.current, stepFocus);
  }, [stepFocus]);

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
    setConnecting(true);
    setError(null);
    void bridge.request("ready", {}).then((result) => {
      if (!active) {
        return;
      }
      setScheduleAllowed(result.schedule === true);
      setEmailRoutesAllowed(result.emailRoutes === true);
      setChooseScheduleAllowed(result.chooseSchedule === true);
      setCredentialsAllowed(result.credentials === true);
      setGoogleAllowed(result.google === true);
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
  }, [bridge, connectionAttempt]);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  // After the demonstration, the recorder groups the steps into stages and rewords them. Keep reading the
  // recording until that finishes, then bring the result in without undoing edits made in the meantime.
  useEffect(() => {
    if (bridge === undefined || bridge === null || recording?.status !== "stopped" || recording.organizing !== true) {
      return;
    }
    let active = true;
    const recorded = recording.steps;
    const timer = window.setTimeout(() => {
      void bridge.request("getRecording", { id: recording.id }).then((next) => {
        if (!active) return;
        setRecording(next);
        if (next.organizing !== true) {
          setSteps((current) => mergeDateSteps(applyOrganizedSteps(current, recorded, next.steps)));
          setStepError(null);
        }
      }).catch(() => {
        // The recorded steps are already usable; organizing is only a readability improvement.
        if (active) setRecording((current) => current === null ? null : { ...current, organizing: false });
      });
    }, 1_500);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [bridge, recording]);

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
        setSteps(mergeDateSteps(next.steps));
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
    const runId = testRun.id;
    const refresh = () => {
      void bridge.request("getTestRun", { agentId, runId }).then((next) => {
        if (active) setTestRun((current) => applyTestRunUpdate(current, runId, next));
      }).catch(() => {
        // The test may still be running: the browser panel and activity say the connection was lost and keep
        // retrying, rather than a page error that would outlast the recovery.
        if (active) setTestRun((current) => current?.id === runId ? { ...current, connectionLost: true } : current);
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

  // A step's validation message is stale once the steps change; the next check reports a current one.
  function changeSteps(next: SetupStep[] | ((current: SetupStep[]) => SetupStep[])): void {
    setSteps(next);
    setStepError(null);
  }

  function showError(value: unknown): void {
    if (value instanceof StepValidationError) setStepError(value);
    else setError(errorMessage(value));
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
      changeSteps(mergeDateSteps(next.steps));
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
      changeSteps(mergeDateSteps(next.steps));
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
    changeSteps((current) => current.map((step) => step.id === id ? updateStepFields(step, updates) : step));
    invalidateTest();
  }

  function removeStep(id: string): void {
    changeSteps((current) => current.filter((step) => step.id !== id));
    invalidateTest();
  }

  function continueToTest(): void {
    setError(null);
    setStepError(null);
    try {
      // Done when is edited on Test; validate it when saving/running, so users can return to correct it.
      compileAgent({ ...draft, doneWhen: { kind: "file" } }, otpSource);
      if (!credentialsAllowed && requiredCredentials(steps).length > 0) {
        throw new Error("This Reiterate page is out of date and cannot save sign-in details. Reload Reiterate and set up the agent again.");
      }
      // What gets tested is what is on screen now; a late reorganization would no longer match it.
      setRecording((current) => current?.organizing === true ? { ...current, organizing: false } : current);
      setScreen("test");
    } catch (compileError) {
      showError(compileError);
    }
  }

  async function saveCredentials(kinds: CredentialKind[], replace: boolean): Promise<{ saved: boolean; otpSource?: "authenticator" | "email" }> {
    if (bridge === undefined || bridge === null) {
      return { saved: false };
    }
    if (kinds.length === 0) {
      return { saved: true, otpSource };
    }
    // The host prompts only for values it does not already hold for this website.
    const result = await bridge.request("requestCredentials", { kinds, replace }, { timeoutMs: interactiveRequestTimeoutMs });
    setSavedCredentials(result.saved);
    setOtpSource(result.otpSource);
    return { saved: kinds.every((kind) => result.saved.includes(kind)), otpSource: result.otpSource };
  }

  async function requestReviewOtp(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await saveCredentials(["otp"], false);
      if (!result.saved) setError("Save an authenticator key to answer this question.");
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function changeCredentials(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      if ((await saveCredentials(requiredCredentials(steps), true)).saved) {
        invalidateTest();
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function connectGoogle(): Promise<void> {
    if (bridge === undefined || bridge === null || agentId === null) return;
    setError(null); setBusy(true);
    try {
      if ((await bridge.request("connectGoogle", { agentId }, { timeoutMs: interactiveRequestTimeoutMs })).connected) invalidateTest();
    } catch (requestError) { setError(errorMessage(requestError)); }
    finally { setBusy(false); }
  }

  async function runTest(nextDoneWhen: DoneWhen = doneWhen, nextSteps = steps, nextRevision = revision): Promise<void> {
    if (bridge === undefined || bridge === null) {
      return;
    }
    setError(null);
    setStepError(null);
    setNotice(null);
    let config: ReturnType<typeof compileAgent>;
    try {
      config = compileAgent({ ...draft, steps: nextSteps, doneWhen: nextDoneWhen }, otpSource);
    } catch (compileError) {
      showError(compileError);
      return;
    }
    setBusy(true);
    try {
      const credentials = await saveCredentials(requiredCredentials(nextSteps), false);
      if (!credentials.saved) {
        setError("Add the missing sign-in details to test this agent.");
        return;
      }
      config = compileAgent({ ...draft, steps: nextSteps, doneWhen: nextDoneWhen }, credentials.otpSource);
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
      setTestRun({ id: started.id, status: "running", files: [], revision: nextRevision, screens: [], startedAt });
    } catch (requestError) {
      // The second compile can still find a step problem once the saved one-time code source is known.
      showError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function stopTest(): Promise<void> {
    if (bridge === undefined || bridge === null || agentId === null || testRun?.status !== "running" || testRun.stopping) return;
    const runId = testRun.id;
    setError(null);
    setTestRun((current) => current?.id === runId ? { ...current, stopping: true } : current);
    try { await bridge.request("stopTest", { agentId, runId }); }
    catch (requestError) {
      setError(errorMessage(requestError));
      setTestRun((current) => current?.id === runId ? { ...current, stopping: false } : current);
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
      changeSteps(nextSteps);
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
    changeSteps((current) => current.map((step): SetupStep => {
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
      changeSteps([]);
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
      if (agentId !== null && testRun?.status === "running" && !testRun.stopping) {
        await bridge.request("stopTest", { agentId, runId: testRun.id }).catch(() => undefined);
      }
      await bridge.request("close", { agentId: agentId ?? undefined });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function closeRunOpening(): Promise<void> {
    if (!bridge) return;
    setBusy(true);
    setRunCloseError(null);
    try { await bridge.request("close", {}); }
    catch (requestError) { setRunCloseError(errorMessage(requestError)); }
    finally { setBusy(false); }
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

  if (mode === "edit") return <EditScreen bridge={bridge} credentialsAllowed={credentialsAllowed} googleAllowed={googleAllowed} />;
  if (mode === "run") return <RunScreen bridge={bridge} />;
  // The host decides the mode; until it answers, a run page does not flash the setup steps.
  if (mode === null && new URLSearchParams(window.location.search).get("mode") === "run") {
    return <RunView name={null} url="" run={null} loading={connecting} loadError={error} readError={null} closeError={runCloseError} closing={busy} onRetry={() => setConnectionAttempt((attempt) => attempt + 1)} onClose={() => void closeRunOpening()} />;
  }

  return (
    <main className={`agent-setup setup-flow${screen === "demonstrate" ? " agent-setup-demonstrating" : screen === "test" ? " agent-setup-testing" : ""}`}>
      <header className="setup-header setup-topbar">
        <button className="icon-button setup-nav" type="button" onClick={requestClose} disabled={busy} aria-label="Back to web agents" title="Back to web agents"><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M19 12H5M11 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
        <h1 className="visually-hidden">Set up your agent</h1>
        <nav aria-label="Agent setup progress" className="setup-progress">
          {screens.map((item, index) => <div className={screen === item.id ? "progress-item current" : screens.findIndex((screenItem) => screenItem.id === screen) > index ? "progress-item complete" : "progress-item"} aria-current={screen === item.id ? "step" : undefined} key={item.id}><span>{index + 1}</span>{item.label}</div>)}
        </nav>
        <button className="icon-button setup-nav setup-close" type="button" ref={closeButtonRef} onClick={requestClose} disabled={busy} aria-label="Close setup" title="Close setup"><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></button>
      </header>
      <div className="setup-shell">

        <section className="setup-content" ref={contentRef} aria-busy={busy}>
          {connecting && <p className="setup-status" role="status">Connecting to Reiterate</p>}
          {error !== null && <div className="setup-error" role="alert"><span>{error}</span><button type="button" className="button button-quiet" onClick={() => setError(null)}>Dismiss</button></div>}
          {stepError !== null && stepErrorIndex >= 0 && <div className="setup-error" role="alert"><span id="setup-step-error">Step {stepErrorIndex + 1}: {stepError.message}</span><button type="button" className="button button-quiet" onClick={() => { setScreen("review"); setStepFocus(stepError.stepId); }}>Go to step</button></div>}
          {notice !== null && <p className="setup-notice" role="status">{notice}</p>}
          {screen === "describe" && <Describe name={name} url={url} goal={goal} busy={busy || connecting} onName={(value) => setDraftField(setName, value)} onUrl={(value) => setDraftField(setUrl, value)} onGoal={(value) => setDraftField(setGoal, value)} onContinue={() => void startRecording()} />}
          {screen === "demonstrate" && <Demonstrate recording={recording} steps={steps} liveViewUrl={liveViewUrl} busy={busy} onStop={() => void stopRecording()} onReview={continueToReview} onReset={() => void reset()} />}
          {screen === "review" && <Review steps={steps} goal={goal} organizing={recording?.organizing === true} busy={busy} credentialsAllowed={credentialsAllowed} savedCredentials={savedCredentials} fieldRefs={stepFieldRefs} stepError={stepError !== null && stepErrorIndex >= 0 ? { stepId: stepError.stepId, messageId: "setup-step-error" } : undefined} onRequestOtp={() => void requestReviewOtp()} onUpdateStep={updateStep} onRemoveStep={removeStep} onMergeSteps={(ids) => { changeSteps((current) => combineDateSteps(current, ids)); invalidateTest(); }} onUndoMergedStep={(id) => { changeSteps((current) => undoDateMerge(current, id)); invalidateTest(); }} onMoveStep={(index, delta) => { changeSteps((current) => moveStep(current, index, delta)); invalidateTest(); }} onBack={() => setScreen("demonstrate")} onContinue={continueToTest} onInsert={() => { const id = `inserted-${Date.now()}`; changeSteps((current) => [...current, { id, type: "agent", description: "" }]); invalidateTest(); }} />}
          {screen === "test" && <Test steps={steps} url={url} scheduleRecovery={scheduleRecovery} emailRoutesAllowed={emailRoutesAllowed} textAllowed={chooseScheduleAllowed} googleAllowed={googleAllowed} doneWhen={doneWhen} emailStatus={emailStatus} emailFrom={emailFrom} emailFiles={emailFiles} canContinue={canContinue} onDoneWhen={chooseDoneWhen} onChooseEmail={() => void chooseEmailDoneWhen()} onAllowEmail={() => void allowEmailSender()} onChangeCredentials={() => void changeCredentials()} onConnectGoogle={() => void connectGoogle()} run={testRun} busy={busy} onRun={() => void runTest()} onStop={() => void stopTest()} onSchedule={() => void schedule()} onBack={() => setScreen("review")} onEditStep={editTestStep} />}
          {screen === "schedule" && !scheduleSaved && <div className="setup-panel"><div className="stage-title"><h2>Schedule</h2><p>Your test passed. Scheduled runs repeat the tested steps.</p></div><p>Finish setup to run manually, or choose a daily schedule.</p>{scheduleAllowed && <><label className="result-check"><input type="checkbox" aria-label="Schedule daily" checked={cron !== ""} disabled={busy || scheduleRecovery} onChange={(event) => setCron(event.target.checked ? localTimeToUtcCron(dailyTime) : "")} />Schedule daily</label>{cron !== "" && <label>Time of day<input type="time" aria-label="Time of day" value={dailyTime} disabled={busy || scheduleRecovery} onChange={(event) => { setDailyTime(event.target.value); if (event.target.value) setCron(localTimeToUtcCron(event.target.value)); }} /><span className="field-note">Your local time. The schedule is stored in UTC.</span></label>}</>}<div className="setup-actions"><button className="button button-quiet" type="button" onClick={() => setScreen("test")} disabled={busy || scheduleRecovery}>Back to test</button><button className="button button-primary" type="button" onClick={() => void saveInlineSchedule()} disabled={!canContinue || busy || (cron !== "" && dailyTime === "")}>{cron.trim() ? "Schedule agent" : "Finish setup"}</button></div></div>}
          {scheduleSaved && <div className="setup-panel"><div className="stage-title"><h2>Your agent is ready</h2><p>{cron.trim() ? "The schedule is saved. It will repeat the tested workflow." : "Run this agent manually whenever you need it."}</p></div><div className="setup-actions"><button className="button button-primary" type="button" onClick={() => void close()} disabled={busy}>Open agent</button></div></div>}
        </section>
      </div>
      {confirmClose && <div className="close-confirmation" role="dialog" aria-modal="true" aria-labelledby="close-setup-title"><div className="close-confirmation-card" ref={closeDialogRef}><h2 id="close-setup-title">Leave setup?</h2><p>Changes in this setup have not been saved. Any agent you saved by running a test remains available.</p><div className="setup-actions"><button className="button button-quiet" type="button" onClick={() => setConfirmClose(false)} disabled={busy}>Keep editing</button><button className="button button-danger" type="button" onClick={() => void close()} disabled={busy}>Close setup</button></div></div></div>}
    </main>
  );
}

function EditScreen({ bridge, credentialsAllowed, googleAllowed }: { bridge: HostBridge; credentialsAllowed: boolean; googleAllowed: boolean }): JSX.Element {
  const [agent, setAgent] = useState<EditAgentData | null>(null);
  const [draft, setDraft] = useState<SetupDraft | null>(null);
  const [stages, setStages] = useState<unknown[]>([]);
  const [stageLimitInputs, setStageLimitInputs] = useState<Record<number, string>>({});
  const [stageLimitErrors, setStageLimitErrors] = useState<Record<number, boolean>>({});
  const [testRun, setTestRun] = useState<WorkbenchRun | null>(null);
  // The last test stays on screen after an edit invalidates it, so the page does not jump while typing.
  const [lastRun, setLastRun] = useState<WorkbenchRun | null>(null);
  const shownRun = testRun ?? lastRun;
  const [screenIndex, setScreenIndex] = useState<number | null>(null);
  const testViewRef = useRef<HTMLElement>(null);
  const publishHeadingRef = useRef<HTMLHeadingElement>(null);
  const testShownRef = useRef(shownRun !== null);
  const [checked, setChecked] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [fromStep, setFromStep] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<StepValidationError | null>(null);
  const [conflict, setConflict] = useState<{ updatedBy: string | null; updatedAt: string | null } | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [operation, setOperation] = useState<"test" | "publish" | "credentials" | null>(null);
  const [credentialsChanged, setCredentialsChanged] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [renameSaved, setRenameSaved] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const recordingRef = useRef<Recording | null>(null);
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const insertedStepRef = useRef<HTMLTextAreaElement | null>(null);
  const [insertedStepId, setInsertedStepId] = useState<string | null>(null);
  const [screenOpen, setScreenOpen] = useState(false);
  const revertFocusRef = useRef<string | null>(null);
  const changesHeadingRef = useRef<HTMLHeadingElement>(null);
  const fieldRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});
  const dialogOpen = publishOpen || conflict !== null || confirmClose || screenOpen;

  const load = async (): Promise<void> => {
    setBusy(true); setError(null); setStepError(null);
    try {
      const loaded = await bridge.request("loadAgent", {});
      setAgent(loaded);
      setRenameError(null); setRenameSaved(false);
      setDraft({ name: loaded.name, url: loaded.url, goal: loaded.goal, steps: mergeDateSteps(loaded.steps ?? []), inputs: [] });
      setStages(loaded.stages);
      setStageLimitInputs({}); setStageLimitErrors({});
      setCredentialsChanged(false); setCredentialError(null);
      setTestRun(null); setLastRun(null); setChecked(false); setConflict(null); setPublishOpen(false);
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
  // A re-demonstration's steps are organized like a new one. They replace the old steps as soon as the
  // demonstration stops; stages and clearer wording follow when ready, unless those steps were edited meanwhile.
  useEffect(() => {
    if (recording?.status !== "stopped" || recording.organizing !== true) return;
    let active = true;
    const recorded = recording.steps;
    const timer = window.setTimeout(() => void bridge.request("getRecording", { id: recording.id }).then((next) => {
      if (!active) return;
      setRecording(next);
      if (next.organizing !== true) {
        setDraft((current) => current === null ? current : { ...current, steps: mergeDateSteps(applyOrganizedSteps(current.steps, recorded, next.steps)) });
        setStepError(null);
      }
    }).catch(() => { if (active) setRecording((current) => current === null ? null : { ...current, organizing: false }); }), 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [bridge, recording]);
  useEffect(() => {
    if (testRun?.status !== "running" || agent === null) return;
    let active = true;
    const runId = testRun.id;
    const poll = () => void bridge.request("getTestRun", { agentId: agent.agentId, runId }).then((next) => { if (active) setTestRun((current) => applyTestRunUpdate(current, runId, next)); }).catch(() => {
      // As on create: the workbench shows the lost connection and the next poll retries.
      if (active) setTestRun((current) => current?.id === runId ? { ...current, connectionLost: true } : current);
    });
    poll(); const timer = window.setInterval(poll, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [agent, bridge, testRun?.id, testRun?.status]);
  useEffect(() => { if (testRun !== null) setLastRun(testRun); }, [testRun]);
  // Test & publish moves in and out of the workbench; when that drops focus on the page, put it back on the card.
  useLayoutEffect(() => {
    if (testShownRef.current === (shownRun !== null)) return;
    testShownRef.current = shownRun !== null;
    if (document.activeElement === null || document.activeElement === document.body) publishHeadingRef.current?.focus();
  }, [shownRun]);
  useEffect(() => {
    if (testRun?.id === undefined) return;
    setScreenIndex(null);
    // Bring the workbench back only when its top is off screen. A retry starts inside it, and scrolling then hid Close.
    const view = testViewRef.current;
    if (view === null) return;
    const { top } = view.getBoundingClientRect();
    if (top < 0 || top >= window.innerHeight) view.scrollIntoView({ block: "nearest" });
  }, [testRun?.id]);
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
        if (!busy) { setPublishOpen(false); setConflict(null); setConfirmClose(false); setScreenOpen(false); }
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

  useEffect(() => {
    const key = revertFocusRef.current;
    if (key === null) return;
    revertFocusRef.current = null;
    (fieldRefs.current[key] ?? changesHeadingRef.current)?.focus();
  }, [draft, stages, stageLimitInputs]);

  if (agent === null || draft === null) return <main className="agent-setup edit-agent">
    <header className="setup-header edit-header"><h1>Edit web agent</h1></header>
    <section className="edit-layout">
      {error ? <div className="edit-card" role="alert"><p>{error}</p><div className="edit-actions">
        {!error.includes("no longer exists") && <button className="button button-primary" disabled={busy} onClick={() => void load()}>Retry</button>}
        <button className="button button-quiet" disabled={busy} onClick={() => void bridge.request("close", {}).catch((e) => setError(errorMessage(e)))}>Back to web agents</button>
      </div></div> : <p className="edit-status" role="status"><span className="edit-spinner" aria-hidden="true" />Loading agent…</p>}
    </section>
  </main>;
  const live: SetupDraft = { name: agent.name, url: agent.url, goal: agent.goal, steps: mergeDateSteps(agent.steps ?? []), inputs: [] };
  const raw = agent.steps === null || agent.steps.length === 0;
  const changes = [...draftChanges(draft, live), ...(raw ? rawStageChanges(stages, agent.stages) : [])];
  const totalChanges = changes.length + Number(credentialsChanged);
  const changed = totalChanges > 0;
  const changeCount = `${totalChanges} unpublished ${totalChanges === 1 ? "change" : "changes"}`;
  const lastScreen = testRun?.screens?.at(-1);
  const nextRunTime = agent.nextRunAt ? formatNextRun(agent.nextRunAt) : null;
  const succeeded = testRun?.status === "succeeded";
  const recordingActive = recording?.status === "recording";
  const readOnly = agent.internal || busy || dialogOpen || recordingActive || testRun?.status === "running";
  const canPublish = !agent.internal && changed && checked && succeeded && !recordingActive;
  const openDateQuestionCount = openQuestions(draft, new Date()).length;
  const openOtpQuestionCount = credentialsAllowed ? draft.steps.filter((step) => step.type === "credential" && step.value === "otp" && !agent.credentials?.saved.includes("otp")).length : 0;
  const openQuestionCount = openDateQuestionCount + openOtpQuestionCount;
  const publishHelp = openQuestionCount > 0 ? "Answer all open questions before testing." : agent.internal ? "Managed by Operations. Publishing changes is disabled." : !changed ? "Make a change to publish." : !succeeded ? "Test your changes before publishing." : !checked ? "Confirm you checked the result." : "Ready to publish your changes.";
  const selectedFromStep = Math.min(fromStep, Math.max(0, draft.steps.length - 1));
  const resetTest = (): void => { setTestRun(null); setChecked(false); setNotice(null); setError(null); setStepError(null); };
  const stepErrorIndex = stepError === null ? -1 : draft.steps.findIndex((step) => step.id === stepError.stepId);
  const update = (next: Partial<SetupDraft>): void => { setDraft((current) => current === null ? current : { ...current, ...next }); resetTest(); };
  const updateStage = (index: number, next: Record<string, unknown>): void => { setStages((current) => current.map((stage, i) => i === index && isObject(stage) ? { ...stage, ...next } : stage)); resetTest(); };
  const instructions = raw ? stages.filter(isObject).filter((stage) => stage.type === "agent").map((stage) => String(stage.prompt ?? "")).join("\n") : JSON.stringify(draft.steps);
  const placeholders: string[] = instructions.match(/\$(username|password|otp)\b/g) ?? [];
  const signInKinds = credentialKinds.filter((kind) => agent.credentials?.saved.includes(kind) || requiredCredentials(draft.steps).includes(kind) || placeholders.includes(`$${kind}`));
  const changeCredentials = async (): Promise<void> => {
    setBusy(true); setOperation("credentials"); setCredentialError(null);
    try {
      const result = await bridge.request("requestCredentials", { kinds: signInKinds.length ? signInKinds : ["username", "password"], replace: true }, { timeoutMs: interactiveRequestTimeoutMs });
      const previousSaved = agent.credentials?.saved ?? [];
      setAgent((current) => current === null ? current : { ...current, credentials: { saved: result.saved, otpSource: result.otpSource } });
      if (result.changed ?? (result.saved.length !== previousSaved.length || result.saved.some((kind) => !previousSaved.includes(kind)))) {
        setCredentialsChanged(true); resetTest();
      }
    } catch (e) { setCredentialError(errorMessage(e)); }
    finally { setBusy(false); setOperation(null); }
  };
  const connectGoogle = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      if ((await bridge.request("connectGoogle", { agentId: agent.agentId }, { timeoutMs: interactiveRequestTimeoutMs })).connected) {
        setCredentialsChanged(true); resetTest();
      }
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const requestEditOtp = async (): Promise<void> => {
    setBusy(true); setOperation("credentials"); setCredentialError(null);
    try {
      const result = await bridge.request("requestCredentials", { kinds: ["otp"] }, { timeoutMs: interactiveRequestTimeoutMs });
      const previousSaved = agent.credentials?.saved ?? [];
      setAgent((current) => current === null ? current : { ...current, credentials: { saved: result.saved, otpSource: result.otpSource } });
      if (result.saved.includes("otp") && !previousSaved.includes("otp")) {
        setCredentialsChanged(true);
        resetTest();
      }
      if (!result.saved.includes("otp")) setCredentialError("Save an authenticator key to answer this question.");
    } catch (e) { setCredentialError(errorMessage(e)); }
    finally { setBusy(false); setOperation(null); }
  };
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
    setBusy(true); setOperation("test"); setError(null); setStepError(null); setTestRun(null); setChecked(false);
    // The test runs the steps shown now; a late reorganization would no longer match it.
    setRecording((current) => current?.organizing === true ? { ...current, organizing: false } : current);
    try {
      const config = raw ? { url: draft.url, prompt: "", options: { version: 1, engine: "computer" }, stages, parameters: {} } : compileAgent(draft, agent.credentials?.otpSource);
      await bridge.request("saveDraft", { draft, config });
      const started = await bridge.request("testAgent", { agentId: agent.agentId, arguments: {} });
      setTestRun({ id: started.id, status: "running" }); setChecked(false);
    } catch (e) { if (e instanceof StepValidationError) setStepError(e); else setError(errorMessage(e)); }
    finally { setBusy(false); setOperation(null); }
  };
  const stopTest = async (): Promise<void> => {
    if (testRun?.status !== "running" || testRun.stopping) return;
    const runId = testRun.id;
    setError(null);
    setTestRun((current) => current?.id === runId ? { ...current, stopping: true } : current);
    try { await bridge.request("stopTest", { agentId: agent.agentId, runId }); }
    catch (requestError) {
      setError(errorMessage(requestError));
      setTestRun((current) => current?.id === runId ? { ...current, stopping: false } : current);
    }
  };
  const publish = async (overwrite: boolean): Promise<void> => {
    setBusy(true); setOperation("publish"); setError(null);
    try {
      const result = await bridge.request("publishDraft", { overwrite });
      if ("conflict" in result) { setPublishOpen(false); setConflict(result.conflict); } else {
        setPublishOpen(false); setConflict(null);
        await load();
        setNotice(`Published v${result.version}.${agent.schedule ? ` Scheduled runs use it ${nextRunTime ? `at ${nextRunTime}` : "from the next run"}.` : ""}`);
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
    try { const stopped = await bridge.request("stopRecording", { id: recording.id }); setRecording(stopped); if (stopped.steps.length > 0) update({ steps: replaceStepsFrom(draft.steps, selectedFromStep, mergeDateSteps(draft.steps.some((step) => step.stage != null) ? stopped.steps.map((step) => ({ ...step, stage: step.stage ?? "" })) : stopped.steps)) }); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  };
  const revert = (key: string): void => {
    revertFocusRef.current = key;
    if (raw && key.startsWith("stage:")) {
      const [, stageIndex, field] = key.split(":");
      const index = Number(stageIndex);
      const original = agent.stages[index];
      setStages((current) => current.map((stage, i) => {
        if (i !== index || !isObject(stage) || !isObject(original)) return stage;
        const next = { ...stage };
        if (Object.prototype.hasOwnProperty.call(original, field)) next[field] = original[field];
        else delete next[field];
        return next;
      }));
      if (field === "step_limit") {
        setStageLimitInputs((current) => { const next = { ...current }; delete next[index]; return next; });
        setStageLimitErrors((current) => ({ ...current, [index]: false }));
      }
      resetTest(); return;
    }
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
    else {
      const [, id, field] = key.split(":");
      const original = live.steps.find((step) => step.id === id);
      if (field === "date") update({ steps: draft.steps.map((step) => step.id === id ? { ...step, date: original?.date } : step) });
      else {
        const property = field === "outcome" ? "expectedOutcome" : field === "email-code" ? "requestsEmailCode" : "description";
        update({ steps: draft.steps.map((step) => step.id === id ? { ...step, [property]: original?.[property] } : step) });
      }
    }
  };

  const close = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      if (testRun?.status === "running" && !testRun.stopping) {
        await bridge.request("stopTest", { agentId: agent.agentId, runId: testRun.id }).catch(() => undefined);
      }
      await bridge.request("close", { agentId: agent.agentId }); setConfirmClose(false); setScreenOpen(false);
    }
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

  // While a test is on screen its action sits under the activity, beside the browser, so it never falls below the workbench.
  const publishCard = <section className="edit-card edit-publish"><h2 ref={publishHeadingRef} tabIndex={-1}>Test &amp; publish</h2><p>Scheduled runs continue using the live version until you publish.</p>
    {testRun?.status === "running" && <div className="edit-status" role="status"><span className="edit-spinner" aria-hidden="true" />{testRun.stopping ? "Stopping the test…" : "Test is running."}</div>}
    {testRun && testRun.status !== "running" && <div className={`edit-result edit-result-${succeeded ? "succeeded" : testRun.failure?.kind === "stopped" ? "stopped" : "failed"}`} role={succeeded || testRun.failure?.kind === "stopped" ? "status" : "alert"}>
      <b>{succeeded ? "Test completed" : testRun.failure?.kind === "stopped" ? "Test stopped" : "Test failed"}</b>
      {!succeeded && <>
        <b>{failureLabel(testRun.failure?.kind)}</b>
        {testRun.failure?.kind === "google" && <><h3>The agent needs a Google sign-in</h3><p>Connect the Google account this website uses, then run the test again.</p>{googleAllowed ? <button className="button button-quiet" disabled={busy} onClick={() => void connectGoogle()}>Connect Google</button> : <p>Open Credentials → Connect Google for this agent.</p>}</>}
        {(testRun.failure?.message || testRun.error) && testRun.failure?.kind !== "google" && <p>{testRun.failure?.message || testRun.error}</p>}
      </>}
      {testRun.stoppedAtStep != null && <p>Stopped at step {testRun.stoppedAtStep}{draft.steps[testRun.stoppedAtStep - 1]?.description ? `: ${draft.steps[testRun.stoppedAtStep - 1]!.description}` : ""}</p>}
      {testRun.confirmation && <p>{testRun.confirmation}</p>}
      {testRun.files && testRun.files.length > 0 && <ul className="edit-files">{testRun.files.map((file) => <li key={file.url}><a href={file.url} target="_blank" rel="noreferrer">{file.name}</a></li>)}</ul>}
      {lastScreen && <button className="edit-screen-thumbnail" aria-label="Enlarge final screen" onClick={(e) => { dialogTriggerRef.current = e.currentTarget; setScreenOpen(true); }}><img src={lastScreen.image} alt="Final screen" /></button>}
      {!testRun.failure?.message && !testRun.error && !testRun.confirmation && !testRun.files?.length && !lastScreen && <p>{succeeded ? "The test finished successfully. No result details were returned." : "The test stopped. No result details were returned. Try again."}</p>}
    </div>}
    <div className="edit-actions">
      {testRun?.status === "running" && <button className="button button-quiet" disabled={testRun.stopping || busy} aria-busy={testRun.stopping === true} onClick={() => void stopTest()}>{testRun.stopping ? "Stopping…" : "Stop test"}</button>}
      <button className={`button ${succeeded ? "button-quiet" : "button-primary"}`} aria-describedby={openQuestionCount > 0 ? "edit-question-reason" : undefined} aria-busy={operation === "test"} disabled={busy || agent.internal || testRun?.status === "running" || recordingActive || openQuestionCount > 0} onClick={() => void test()}>{operation === "test" ? "Starting test…" : testRun?.status === "failed" ? "Run test again" : succeeded ? "Test again" : "Test changes"}</button>
      {succeeded && <label className="result-check"><input aria-label="I checked the result" type="checkbox" checked={checked} disabled={readOnly} onChange={(e) => setChecked(e.target.checked)} /> I checked the result</label>}
      <button className={`button ${succeeded ? "button-primary" : "button-quiet"}`} aria-describedby="edit-publish-help" aria-busy={operation === "publish"} disabled={!canPublish || busy} onClick={(e) => { dialogTriggerRef.current = e.currentTarget; setPublishOpen(true); }}>{operation === "publish" ? "Publishing…" : "Publish changes"}</button>
    </div>
    <p id="edit-publish-help">{publishHelp}</p>{openQuestionCount > 0 && <span id="edit-question-reason" className="visually-hidden">Answer all open questions before testing.</span>}
  </section>;

  return <main className="agent-setup edit-agent">
    <header className="setup-header edit-header">
      <button className="icon-button" aria-label="Back to web agents" title="Back to web agents" disabled={dialogOpen} onClick={(e) => requestClose(e.currentTarget)}><EditIcon name="back" /></button>
      <div className="edit-heading">
        <h1 className="visually-hidden">Edit web agent</h1>
        <div className="edit-title">
          <label className="edit-name"><span className="visually-hidden">Agent name</span><input value={draft.name} title="Rename agent" size={Math.max(12, draft.name.length)} disabled={agent.internal || renaming || busy} aria-invalid={renameError !== null} aria-describedby={renameError ? "edit-name-help rename-error" : "edit-name-help"}
            onChange={(e) => { setDraft({ ...draft, name: e.target.value }); setRenameSaved(false); setNotice(null); }}
            onBlur={(e) => void rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === "Escape") { e.preventDefault(); setDraft({ ...draft, name: agent.name }); setRenameError(null); setRenameSaved(false); }
            }} /></label>
          <span className="edit-rename-status" role="status">{renaming ? "Saving…" : renameSaved ? "Saved" : ""}</span>
          <span className="edit-version">Live v{agent.version}</span>
          {agent.schedule && <span className="edit-schedule">{agent.schedule}{agent.nextRunAt ? ` · next run ${nextRunTime}` : ""}</span>}
        </div>
        <p className="visually-hidden" id="edit-name-help">Name saves automatically</p>
        {renameError && <p id="rename-error" className="edit-rename-error" role="alert">{renameError}</p>}
      </div>
      <button className="icon-button" aria-label="Close edit page" title="Close edit page" disabled={dialogOpen} onClick={(e) => requestClose(e.currentTarget)}><EditIcon name="close" /></button>
    </header>
    <section className="edit-layout" aria-busy={busy}>
      {agent.internal && <p className="edit-notice"><b>Read-only internal agent</b><br />Managed by Operations. Publishing changes is disabled.</p>}
      {error && <div className="edit-result edit-result-failed" role="alert">{error}</div>}
      {stepError !== null && stepErrorIndex >= 0 && <div className="edit-result edit-result-failed" role="alert"><span id="edit-step-error">Step {stepErrorIndex + 1}: {stepError.message}</span><button className="text-button" onClick={() => focusStepInstruction(fieldRefs.current, stepError.stepId)}>Go to step</button></div>}
      {notice && <p className="edit-result edit-result-succeeded" role="status">{notice}</p>}
      {shownRun && <section className="edit-test" ref={testViewRef} aria-label="Test run"><div className="workbench-grid">
        <TestBrowser run={shownRun} url={draft.url} passed={shownRun.status === "succeeded"} serviceFailure={shownRun.failure?.kind === "service"} screenIndex={screenIndex} onSelectScreen={setScreenIndex} />
        <div className="edit-test-side"><aside className="test-rail" aria-label="Test activity"><header><h3>Agent activity</h3><span>{testRun === null ? "Changed since this test" : shownRun.status === "running" ? "Running" : succeeded ? "Passed" : "Stopped"}</span></header><ActivityLog run={shownRun} /></aside>{publishCard}</div>
      </div></section>}
      <div className="edit-grid"><div className="edit-main">
        {raw ? <section className="edit-card edit-instructions"><h2>Instructions</h2>
          {stages.map((stage, index) => { const item = isObject(stage) ? stage : null; return item?.type === "agent" ? <div className="raw-stage" key={index}>
            <label>Agent instructions<textarea ref={(field) => { fieldRefs.current[`stage:${index}:prompt`] = field; }} aria-label="Agent instructions" value={String(item.prompt ?? "")} disabled={readOnly} onChange={(e) => updateStage(index, { prompt: e.target.value })} /></label>
          </div> : null; })}
          {stages.some((stage) => !isObject(stage) || stage.type !== "agent") && <p className="raw-preserved">Then: {stages.filter((stage) => !isObject(stage) || stage.type !== "agent").map((stage) => preservedStageLabel(isObject(stage) ? stage : null)).join(" · ")} — kept as is</p>}
        </section> : <section className="edit-card edit-instructions"><h2>Steps</h2><p className="field-note expected-outcome-help"><HelpTip label="Expected outcome">The agent checks this before moving on. Leave empty unless a step is easy to get wrong.</HelpTip></p>
          <StepEditor variant="edit" steps={draft.steps} goal={draft.goal} busy={readOnly} credentialsAllowed={credentialsAllowed} savedCredentials={agent.credentials?.saved ?? []} fieldRefs={fieldRefs} stepError={stepError !== null && stepErrorIndex >= 0 ? { stepId: stepError.stepId, messageId: "edit-step-error" } : undefined} onRequestOtp={() => void requestEditOtp()} onUpdateStep={(id, updates) => update({ steps: draft.steps.map((step) => step.id === id ? updateStepFields(step, updates) : step) })} onRemoveStep={(id) => update({ steps: draft.steps.filter((step) => step.id !== id) })} onMergeSteps={(ids) => update({ steps: combineDateSteps(draft.steps, ids) })} onUndoMergedStep={(id) => update({ steps: undoDateMerge(draft.steps, id) })} onMoveStep={(index, delta) => update({ steps: moveStep(draft.steps, index, delta) })} onRenameStage={(index, name) => update({ steps: renameStageAt(draft.steps, index, name) })} onInsert={insertStep} />
          <div className="redemo-controls">
            <div className="edit-actions"><label>Re-demonstrate from step<select aria-label="Re-demonstrate from step" value={selectedFromStep} disabled={readOnly || draft.steps.length === 0} onChange={(e) => setFromStep(Number(e.target.value))}>{draft.steps.map((_, index) => <option key={index} value={index}>{index + 1}</option>)}</select></label>
              <button className="button button-quiet" disabled={readOnly} onClick={() => void startRecording()}>Re-demonstrate</button>
              {recordingActive && <button className="button button-primary" disabled={busy} onClick={() => void stopRecording()}>Finish re-demonstration</button>}
            </div>
            <p>Replaces step {selectedFromStep + 1} and every later step with a new demonstration.</p>
          </div>
          {recording?.blockedReason && <p className="edit-result edit-result-failed" role="alert">Cannot continue: {recording.blockedReason}</p>}
          {recording?.status === "expired" && <p className="edit-result edit-result-failed" role="alert">Demonstration expired. Re-demonstrate again.</p>}
          {recordingActive && <div className="browser-frame edit-recording">{browserbaseLiveViewUrl(recording.liveViewUrl) ? <iframe title="Virtual browser" src={browserbaseLiveViewUrl(recording.liveViewUrl)!} allow="clipboard-read; clipboard-write" /> : <p>Opening the virtual browser.</p>}{recording.liveViewSwitching && <div className="browser-switching" role="status">Opening the new window…</div>}</div>}
          {recordingActive && <DownloadNotice downloads={recording.downloads ?? []} />}
        </section>}
      </div><aside className="edit-rail">
        <section className="edit-card edit-credentials" aria-labelledby="edit-credentials-title"><h2 id="edit-credentials-title">Sign-in details</h2>
          {credentialsAllowed && agent.credentials ? <>
            {signInKinds.length ? <ul className="edit-credential-kinds">{signInKinds.map((kind) => <li key={kind}>{kind === "username" ? "Username" : kind === "password" ? "Password" : agent.credentials?.otpSource === "email" ? "Email code" : "Authenticator key"} · {agent.credentials!.saved.includes(kind) ? "saved" : "Not saved"}</li>)}</ul> : <p>No sign-in details saved.</p>}
            {credentialsChanged && <p role="status">Changed — test before publishing</p>}
            {!agent.internal && <button className="button button-quiet" disabled={readOnly} aria-busy={operation === "credentials"} onClick={() => void changeCredentials()}>{operation === "credentials" ? "Changing sign-in details…" : signInKinds.length ? "Change sign-in details" : "Add sign-in details"}</button>}
            {credentialError && <p className="edit-rename-error" role="alert">{credentialError}</p>}
          </> : <p>Sign-in details: managed in the agent settings</p>}
        </section>
        {!shownRun && publishCard}
        <section className="edit-card edit-changes"><h2 ref={changesHeadingRef} tabIndex={-1}>Changes</h2>
          {changed && <p>{changeCount}</p>}
          <span className="visually-hidden" role="status">{changed ? changeCount : "No unpublished changes"}</span>
          {!changed ? <p>No changes yet.</p> : changes.map((change) => <div className="change-item" key={change.key}><b>{change.label}</b><span>{change.from || "Empty"} → {change.to || "Empty"}</span><button className="text-button" aria-label={`Revert ${change.label}`} disabled={readOnly} onClick={() => revert(change.key)}>Revert</button></div>)}
          {credentialsChanged && <div className="change-item"><b>Sign-in details: updated</b><span>Leave without publishing to undo</span></div>}
        </section>
        <section className="edit-card edit-details"><h2>Details</h2>
          <label>Website address<input ref={(field) => { fieldRefs.current.url = field; }} aria-label="Website address" value={draft.url} disabled={readOnly} onChange={(e) => update({ url: e.target.value })} /></label>
          <label>Goal<span id="edit-goal-help" className="field-note">What the agent should produce each run. Used to suggest the answers in the review and the success check.</span><textarea ref={(field) => { fieldRefs.current.goal = field; }} rows={3} aria-label="Goal" aria-describedby="edit-goal-help" value={draft.goal} disabled={readOnly} onChange={(e) => update({ goal: e.target.value })} /></label>
          {raw && stages.map((stage, index) => { const item = isObject(stage) ? stage : null; return item?.type === "agent" ? <div className="raw-limit" key={index}>
            <label>Maximum actions<input ref={(field) => { fieldRefs.current[`stage:${index}:step_limit`] = field; }} aria-label="Maximum actions" type="text" inputMode="numeric" value={stageLimitInputs[index] ?? String(item.step_limit ?? 1)} disabled={readOnly} aria-invalid={stageLimitErrors[index] ?? false} aria-describedby={`stage-limit-help-${index}${stageLimitErrors[index] ? ` stage-limit-error-${index}` : ""}`}
              onChange={(e) => {
                const value = e.target.value;
                setStageLimitInputs((current) => ({ ...current, [index]: value }));
                setStageLimitErrors((current) => ({ ...current, [index]: false }));
                if (validStepLimit(value)) updateStage(index, { step_limit: Number(value) });
                else resetTest();
              }}
              onBlur={(e) => setStageLimitErrors((current) => ({ ...current, [index]: !validStepLimit(e.target.value) }))} />
              {stageLimitErrors[index] && <span id={`stage-limit-error-${index}`} className="edit-rename-error" role="alert">Enter a whole number from 1 to 128.</span>}
              <span id={`stage-limit-help-${index}`} className="field-note">The agent stops after this many browser actions.</span></label>
          </div> : null; })}
        </section>
      </aside></div>
    </section>
    {screenOpen && lastScreen && <div className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-screen-title"><div className="edit-modal-card edit-screen-dialog" ref={modalRef} tabIndex={-1}>
      <h2 id="edit-screen-title">Final screen</h2><button className="button button-quiet" onClick={() => setScreenOpen(false)}>Close screenshot</button><img src={lastScreen.image} alt="Final screen" />
    </div></div>}
    {confirmClose && <div className="close-confirmation" role="dialog" aria-modal="true" aria-labelledby="close-edit-title" aria-describedby="close-edit-description"><div className="close-confirmation-card" ref={modalRef} tabIndex={-1}>
      <h2 id="close-edit-title">Discard your changes?</h2><p id="close-edit-description">Your unpublished changes and any active test or re-demonstration will be left behind.</p>
      <div className="edit-actions"><button className="button button-quiet" onClick={() => setConfirmClose(false)} disabled={busy}>Keep editing</button><button className="button button-danger" onClick={() => void close()} disabled={busy}>Discard changes</button></div>
    </div></div>}
    {publishOpen && <div className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="publish-edit-title" aria-describedby="publish-edit-description"><div className="edit-modal-card" ref={modalRef} tabIndex={-1}>
      <h2 id="publish-edit-title">Publish changes?</h2><p id="publish-edit-description">Publish {totalChanges} {totalChanges === 1 ? "change" : "changes"} to this agent.</p>
      {agent.schedule && <p className="edit-notice">Scheduled runs will use v{agent.version + 1} {nextRunTime ? `at ${nextRunTime}` : "at the next run time"}.</p>}
      <div className="edit-actions"><button className="button button-quiet" disabled={busy} onClick={() => setPublishOpen(false)}>Cancel</button><button className="button button-primary" disabled={busy} aria-busy={operation === "publish"} onClick={() => void publish(false)}>{operation === "publish" ? "Publishing…" : "Publish"}</button></div>
    </div></div>}
    {conflict && <div className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="conflict-edit-title" aria-describedby="conflict-edit-description"><div className="edit-modal-card conflict-modal" ref={modalRef} tabIndex={-1}>
      <h2 id="conflict-edit-title">This agent changed while you were editing</h2>
      <div id="conflict-edit-description"><p>{conflict.updatedBy ?? "An unknown user"} saved it at {conflict.updatedAt ? formatConflictDate(conflict.updatedAt) : "an unknown time"}.</p><p>Reloading their version or publishing yours discards the other version's changes permanently.</p></div>
      <div className="edit-actions"><button className="button button-quiet" disabled={busy} onClick={() => setConflict(null)}>Cancel</button><button className="button button-quiet" disabled={busy} onClick={() => void load()}>Reload their version</button><button className="button button-danger" disabled={busy} aria-busy={operation === "publish"} onClick={() => void publish(true)}>{operation === "publish" ? "Publishing…" : "Publish mine anyway"}</button></div>
    </div></div>}
  </main>;
}

function validStepLimit(value: string): boolean { return value.trim() !== "" && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 128; }

/** Show the step a validation message is about: bring its instruction into view and focus it. */
function focusStepInstruction(fields: Record<string, HTMLInputElement | HTMLTextAreaElement | null>, stepId: string): void {
  const field = fields[`step:${stepId}:description`];
  field?.scrollIntoView({ block: "center" });
  field?.focus({ preventScroll: true });
}

function updateStepFields(step: SetupStep, updates: Partial<SetupStep>): SetupStep {
  const next = { ...step, ...updates };
  if (step.uiMerged === true) Object.defineProperty(next, "uiMerged", { configurable: true, value: true, writable: true });
  return next;
}

function EditIcon({ name }: { name: "back" | "up" | "down" | "close" }): JSX.Element {
  const path = { back: "M19 12H5m6-6-6 6 6 6", up: "M12 19V5m-6 6 6-6 6 6", down: "M12 5v14m-6-6 6 6 6-6", close: "M6 6l12 12M18 6L6 18" }[name];
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none"><path d={path} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function combineDateSteps(steps: SetupStep[], ids: string[]): SetupStep[] {
  const selected = steps.filter((step) => ids.includes(step.id));
  if (selected.length < 2 || selected.length > 3) return steps;
  const first = steps.findIndex((step) => step.id === selected[0]?.id);
  if (first < 0 || selected.some((step, index) => steps[first + index]?.id !== step.id)) return steps;
  const merged = mergeDateSteps(selected, true)[0];
  if (merged?.type !== "date") return steps;
  return [...steps.slice(0, first), merged, ...steps.slice(first + selected.length)];
}

function undoDateMerge(steps: SetupStep[], id: string): SetupStep[] {
  const index = steps.findIndex((step) => step.id === id);
  const merged = steps[index];
  if (index < 0 || merged?.type !== "date" || merged.parts === undefined) return steps;
  return [...steps.slice(0, index), ...merged.parts, ...steps.slice(index + 1)];
}

function moveStep(steps: SetupStep[], index: number, delta: number): SetupStep[] {
  const next = [...steps]; const target = index + delta;
  if (target < 0 || target >= next.length) return next;
  const moved = next[index]!, neighbour = next[target]!;
  // A step moved past the edge of its stage joins the stage it moved into.
  next[index] = neighbour; next[target] = moved.stage === neighbour.stage ? moved : { ...moved, stage: neighbour.stage };
  return next;
}
/** Rename the stage that starts at index: every following step with the same stage name. */
function renameStageAt(steps: SetupStep[], index: number, name: string): SetupStep[] {
  const stage = steps[index]?.stage;
  let end = index;
  while (end < steps.length && steps[end]!.stage === stage) end += 1;
  return steps.map((step, i) => i >= index && i < end ? { ...step, stage: name } : step);
}
function rawStageChanges(current: unknown[], live: unknown[]): Array<{ key: string; label: string; from: string; to: string }> {
  return current.flatMap((stage, index) => {
    const original = live[index];
    if (!isObject(stage) || stage.type !== "agent" || !isObject(original)) return [];
    return (["prompt", "step_limit"] as const).flatMap((field) => {
      if (stage[field] === original[field]) return [];
      let from = String(original[field] ?? ""), to = String(stage[field] ?? "");
      if (field === "prompt") {
        const before = from.split("\n"), after = to.split("\n");
        const line = Array.from({ length: Math.max(before.length, after.length) }, (_, i) => i).find((i) => before[i] !== after[i]) ?? 0;
        const excerpt = (text: string): string => text.length > 80 ? `${text.slice(0, 79)}…` : text;
        from = excerpt(before[line] ?? ""); to = excerpt(after[line] ?? "");
      }
      return [{ key: `stage:${index}:${field}`, label: `${field === "prompt" ? "Agent instructions" : "Maximum actions"}${current.filter((item) => isObject(item) && item.type === "agent").length > 1 ? ` (stage ${index + 1})` : ""}`, from, to }];
    });
  });
}
function formatNextRun(value: string): string { return new Intl.DateTimeFormat(undefined, { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(value)); }
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
  return <div className="setup-panel setup-panel-compact"><div className="stage-title"><h2>Describe the job</h2><p>Start with the website and the result you want. You will demonstrate the task next.</p></div><p className="credential-warning">{signInNote}</p><label>Agent name<input aria-label="Agent name" value={props.name} onChange={(event) => props.onName(event.target.value)} autoComplete="off" /></label><label>Website address<input aria-label="Website address" value={props.url} onChange={(event) => props.onUrl(event.target.value)} placeholder="https://example.com" inputMode="url" autoComplete="off" /></label><label>What should the agent do?<textarea aria-label="What should the agent do?" value={props.goal} onChange={(event) => props.onGoal(event.target.value)} placeholder="For example: download the monthly statement for the selected month." /><span className="field-note">Say what the result is and for which period, e.g. "Download last month's bank statement as CSV". Reiterate uses this to suggest answers in the review.</span></label><div className="setup-actions"><button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy}>Continue to demonstration</button></div></div>;
}

function Demonstrate(props: { recording: Recording | null; steps: SetupStep[]; liveViewUrl: string | null; busy: boolean; onStop(): void; onReview(): void; onReset(): void }): JSX.Element {
  const stepsRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const isRecording = props.recording?.status === "recording";
  const isStopped = props.recording?.status === "stopped";
  const state = props.recording?.status === "expired" ? "Demonstration expired" : isRecording ? "Recording in progress" : "Demonstration finished";
  const browserMessage = isRecording ? "Opening the virtual browser." : "The virtual browser is unavailable for this demonstration.";
  const count = props.steps.length;

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

  // Finishing swaps the pressed button for "Continue to review"; keep keyboard focus on that next action.
  const wasRecordingRef = useRef(isRecording);
  useEffect(() => {
    if (wasRecordingRef.current && isStopped && (document.activeElement === null || document.activeElement === document.body)) reviewRef.current?.focus();
    wasRecordingRef.current = isRecording;
  }, [isRecording, isStopped]);

  return (
    <div className="setup-panel demonstrate">
      {/* The controls sit beside the title, above the browser: always on screen, and reached by Tab before the remote browser. */}
      <div className="demonstrate-heading">
        <div className="stage-title">
          <h2>Demonstrate the task</h2>
          <p>Show each step you want the agent to follow. You can review and edit the steps afterwards.</p>
        </div>
        <div className="demonstrate-controls">
          <div className={`recording-state ${isRecording ? "recording-state-active" : ""}`} role="status"><span aria-hidden="true" />{state}</div>
          <button className="button button-quiet" type="button" onClick={props.onReset} disabled={props.busy}>Start over</button>
          {isRecording && <button className="button button-primary" type="button" onClick={props.onStop} disabled={props.busy}>Finish demonstration</button>}
          {isStopped && <button className="button button-primary" type="button" ref={reviewRef} onClick={props.onReview} disabled={props.busy}>Continue to review</button>}
        </div>
      </div>
      {props.recording?.blockedReason !== null && props.recording?.blockedReason !== undefined && <div className="setup-error" role="alert">Cannot continue: {props.recording.blockedReason}</div>}
      {props.recording?.status === "expired" && <div className="setup-error" role="alert">Recording expired. Start a new demonstration.</div>}
      <div className="demonstration-grid">
        <div className="browser-frame">
          {props.liveViewUrl === null
            ? !isStopped && <p>{browserMessage}</p>
            // Clipboard access must be delegated explicitly or paste does nothing in the remote browser.
            : <iframe title="Virtual browser" src={props.liveViewUrl} allow="clipboard-read; clipboard-write" />}
          {isRecording && props.recording?.liveViewSwitching && <div className="browser-switching" role="status">Opening the new window…</div>}
          {/* The recording service drops the live view once stopped, so the summary must not depend on it. */}
          {isStopped && <div className="demonstrate-finished browser-notice-over-screen">
            <div className="browser-notice-card">{count === 0
              ? <><b>No steps were recorded</b><span>Start over to demonstrate the task again.</span></>
              : <><b>{count} {count === 1 ? "step" : "steps"} recorded</b><span>Continue to review to check and edit {count === 1 ? "it" : "them"}.</span></>}</div>
          </div>}
          <DownloadNotice downloads={props.recording?.downloads ?? []} />
        </div>
        <aside className="captured-steps" aria-label="Captured demonstration steps">
          <h3>Recorded steps <span className="captured-steps-count">{count}</span></h3>
          <div className="captured-steps-list" ref={stepsRef} onScroll={onStepsScroll} tabIndex={0} aria-label="Recorded steps list">
            {count === 0 ? <p>Actions will appear here while you demonstrate.</p> : <ol>{props.steps.map((step) => <li key={step.id} className={step.type === "download" ? "captured-download" : undefined}>{step.description}</li>)}</ol>}
          </div>
          <p className="captured-steps-note"><svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg><span>{demonstrateSignInNote}</span></p>
          <p className="captured-steps-note google-verify-note"><span>Signing in with Google? <a href={googleAuthenticatorSetupUrl} target="_blank" rel="noopener noreferrer">Add an authenticator app to your Google Account</a> first. When Google asks you to confirm on your phone or tap a number in the Gmail app, choose Try another way and enter the code from your authenticator app.</span></p>
        </aside>
      </div>
    </div>
  );
}

/** The live view has no download bar, so the setup page says when the demonstration browser saves a file. */
function DownloadNotice(props: { downloads: RecordedDownload[] }): JSX.Element | null {
  const latest = props.downloads.at(-1);
  if (latest === undefined) return null;
  const others = props.downloads.length - 1;
  const text = latest.state === "started" ? `Downloading ${latest.name}…`
    : latest.state === "failed" ? `The download of ${latest.name} failed. Try it again in the browser.`
    : `Downloaded ${latest.name}`;
  return (
    <div className={`download-notice download-${latest.state}`} role={latest.state === "failed" ? "alert" : "status"}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><path d={latest.state === "completed" ? "M5 12.5l4.5 4.5L19 7.5" : latest.state === "failed" ? "M6 6l12 12M18 6L6 18" : "M12 4v11m-5-5 5 5 5-5M5 20h14"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      <span>{text}{others > 0 && <small> · {others + 1} files this demonstration</small>}</span>
    </div>
  );
}

type StepEditorProps = {
  steps: SetupStep[];
  goal: string;
  variant: "review" | "edit";
  busy: boolean;
  credentialsAllowed: boolean;
  savedCredentials: CredentialKind[];
  onRequestOtp(): void;
  onUpdateStep(id: string, updates: Partial<SetupStep>): void;
  onRemoveStep(id: string): void;
  onMergeSteps?(ids: string[]): void;
  onUndoMergedStep?(id: string): void;
  onMoveStep?(index: number, delta: number): void;
  onRenameStage?(index: number, name: string): void;
  onInsert?(): void;
  onContinue?(): void;
  onBack?(): void;
  fieldRefs?: { current: Record<string, HTMLInputElement | HTMLTextAreaElement | null> };
  /** The step a shown validation message is about, and the id of that message. */
  stepError?: { stepId: string; messageId: string };
};

function StepEditor(props: StepEditorProps): JSX.Element {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [expectedOutcomeOpen, setExpectedOutcomeOpen] = useState<Record<string, boolean>>({});
  const [moreOptionsOpen, setMoreOptionsOpen] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [focusStepId, setFocusStepId] = useState<string | null>(null);
  const today = new Date();
  const questions = openQuestions({ name: "", url: "https://example.test", goal: props.goal, steps: props.steps, inputs: [] }, today);
  const otpQuestions = props.credentialsAllowed ? props.steps.flatMap((step, index) => step.type === "credential" && step.value === "otp" && !props.savedCredentials.includes("otp") ? [{ step, index }] : []) : [];
  const questionCount = questions.length + otpQuestions.length;
  const groups = groupSteps(props.steps);
  const selected = selectedIds.map((id) => props.steps.findIndex((step) => step.id === id)).filter((index) => index >= 0);
  const canMerge = selected.length >= 2 && selected.length <= 3 && selected.every((index) => props.steps[index]?.type === "input") && Math.max(...selected) - Math.min(...selected) + 1 === selected.length
    && mergeDateSteps(selected.map((index) => props.steps[index]! ), true)[0]?.type === "date";
  const hasMergeCandidates = props.steps.some((_, index) => isDateMergeCandidate(props.steps, index));
  const emptyStep = props.variant === "edit" ? props.steps.find((step) => step.description === "") : undefined;
  useEffect(() => {
    if (emptyStep !== undefined) props.fieldRefs?.current[`step:${emptyStep.id}:description`]?.focus();
  }, [emptyStep, props.fieldRefs]);
  useEffect(() => {
    if (focusStepId === null) return;
    props.fieldRefs?.current[`step:${focusStepId}:description`]?.focus();
    setFocusStepId(null);
  }, [focusStepId, props.fieldRefs, props.steps]);
  const answerOther = (stepId: string, text: string): void => {
    const value = text.trim();
    if (value) props.onUpdateStep(stepId, { date: { ...props.steps.find((step) => step.id === stepId)!.date!, rule: { kind: "described", text: value } } });
  };
  const setFieldKind = (step: SetupStep, kind: CredentialKind | ""): void => {
    const field = step.target ?? "the field";
    props.onUpdateStep(step.id, kind === ""
      ? { type: "input", value: "", description: `Fill in ${field}` }
      : { type: "credential", value: kind, description: `Enter the saved ${credentialLabel(kind)} in ${field}` });
  };
  const toggleSelected = (id: string): void => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  return <>
    {questionCount > 0 && <div className="setup-notice question-notice" role="status">{questionCount} question{questionCount === 1 ? "" : "s"} to answer before testing</div>}
    {hasMergeCandidates && <div className="merge-date-actions"><button type="button" className="button button-quiet merge-date-button" disabled={props.busy || !canMerge} onClick={() => { const first = props.steps.find((step) => selectedIds.includes(step.id)); props.onMergeSteps?.(selected.map((index) => props.steps[index]!.id)); setSelectedIds([]); setFocusStepId(first?.id ?? null); }}>Combine into one date step</button><span className="field-note">Tick the day, month and year fields, then combine them.</span></div>}
    <div className={props.variant === "review" ? "review-list" : "edit-steps"}>
      {groups.map((group) => <section className={props.variant === "review" ? "review-stage" : "edit-stage-group"} key={group.steps[0]!.step.id} aria-label={group.stage ?? "Steps"}>
        {group.stage !== null && <input className={props.variant === "review" ? "review-stage-name" : "edit-stage"} aria-label={props.variant === "review" ? `Stage name for steps ${group.steps[0]!.index + 1}–${group.steps.at(-1)!.index + 1}` : `Stage name for step ${group.steps[0]!.index + 1}`} value={group.stage} maxLength={60} disabled={props.busy} placeholder="Stage name" onChange={(event) => props.onRenameStage?.(group.steps[0]!.index, event.target.value)} />}
        {props.variant === "review" ? <ol start={group.steps[0]!.index + 1}>{group.steps.map(({ step, index }) => <StepEditorRow key={step.id} {...props} step={step} index={index} selected={selectedIds.includes(step.id)} onToggleSelected={toggleSelected} expectedOutcomeOpen={expectedOutcomeOpen[step.id] === true || Boolean(step.expectedOutcome?.trim())} onExpectedOutcomeOpen={() => setExpectedOutcomeOpen((current) => ({ ...current, [step.id]: true }))} onSetFieldKind={setFieldKind} onRemoveStep={(id) => { const stepIndex = props.steps.findIndex((item) => item.id === id); const next = props.steps[stepIndex + 1] ?? props.steps[stepIndex - 1]; props.onRemoveStep(id); setFocusStepId(next?.id ?? null); }} onUndoMergedStep={(id) => { const current = props.steps.find((item) => item.id === id); props.onUndoMergedStep?.(id); setFocusStepId(current?.parts?.[0]?.id ?? null); }} otherOpen={otherOpen[step.id] === true} onOtherOpen={(open) => setOtherOpen((current) => ({ ...current, [step.id]: open }))} moreOptionsOpen={moreOptionsOpen[step.id] === true} onMoreOptionsOpen={(open) => setMoreOptionsOpen((current) => ({ ...current, [step.id]: open }))} otherText={otherText[step.id] ?? ""} onOtherText={(value) => setOtherText((current) => ({ ...current, [step.id]: value }))} onAnswerOther={answerOther} />)}</ol> : group.steps.map(({ step, index }) => <StepEditorRow key={step.id} {...props} step={step} index={index} selected={selectedIds.includes(step.id)} onToggleSelected={toggleSelected} expectedOutcomeOpen={expectedOutcomeOpen[step.id] === true || Boolean(step.expectedOutcome?.trim())} onExpectedOutcomeOpen={() => setExpectedOutcomeOpen((current) => ({ ...current, [step.id]: true }))} onSetFieldKind={setFieldKind} onRemoveStep={(id) => { const stepIndex = props.steps.findIndex((item) => item.id === id); const next = props.steps[stepIndex + 1] ?? props.steps[stepIndex - 1]; props.onRemoveStep(id); setFocusStepId(next?.id ?? null); }} onUndoMergedStep={(id) => { const current = props.steps.find((item) => item.id === id); props.onUndoMergedStep?.(id); setFocusStepId(current?.parts?.[0]?.id ?? null); }} otherOpen={otherOpen[step.id] === true} onOtherOpen={(open) => setOtherOpen((current) => ({ ...current, [step.id]: open }))} moreOptionsOpen={moreOptionsOpen[step.id] === true} onMoreOptionsOpen={(open) => setMoreOptionsOpen((current) => ({ ...current, [step.id]: open }))} otherText={otherText[step.id] ?? ""} onOtherText={(value) => setOtherText((current) => ({ ...current, [step.id]: value }))} onAnswerOther={answerOther} />)}
      </section>)}
    </div>
    {props.variant === "edit" && props.onInsert && <button type="button" className="button button-quiet" disabled={props.busy} onClick={props.onInsert}>Insert step</button>}
    {props.variant === "review" && <div className="setup-actions"><button className="button button-quiet" type="button" onClick={props.onInsert} disabled={props.busy}>Insert step</button><button className="button button-quiet" type="button" onClick={props.onBack} disabled={props.busy}>Back to demonstration</button><button className="button button-primary" type="button" onClick={props.onContinue} disabled={props.busy || questionCount > 0} aria-describedby={questionCount > 0 ? "open-question-reason" : undefined}>Continue to test</button>{questionCount > 0 && <span id="open-question-reason" className="field-note">Answer all open questions before testing.</span>}</div>}
  </>;
}

function isDateMergeCandidate(steps: SetupStep[], index: number): boolean {
  const step = steps[index];
  if (step?.type !== "input" || !/^\d{1,4}$/.test(step.value ?? "")) return false;
  let start = index;
  while (start > 0 && steps[start - 1]?.type === "input" && /^\d{1,4}$/.test(steps[start - 1]?.value ?? "")) start -= 1;
  let end = index + 1;
  while (end < steps.length && steps[end]?.type === "input" && /^\d{1,4}$/.test(steps[end]?.value ?? "")) end += 1;
  return end - start >= 2 && end - start <= 3;
}

function StepEditorRow(props: StepEditorProps & { step: SetupStep; index: number; selected: boolean; onToggleSelected(id: string): void; onSetFieldKind(step: SetupStep, kind: CredentialKind | ""): void; onRemoveStep(id: string): void; onUndoMergedStep(id: string): void; expectedOutcomeOpen: boolean; onExpectedOutcomeOpen(): void; otherOpen: boolean; onOtherOpen(open: boolean): void; moreOptionsOpen: boolean; onMoreOptionsOpen(open: boolean): void; otherText: string; onOtherText(value: string): void; onAnswerOther(id: string, text: string): void }): JSX.Element {
  const typedField = props.step.type === "input" || props.step.type === "credential";
  const dateQuestion = props.step.type === "date" && props.step.date?.rule === null ? openQuestions({ name: "", url: "https://example.test", goal: props.goal, steps: props.steps, inputs: [] }, new Date()).find((question) => question.stepId === props.step.id) ?? {
    kind: "date" as const,
    stepId: props.step.id,
    stepIndex: props.index,
    text: `Step ${props.index + 1} enters the date ${formatDate(props.step.date?.value ?? "1970-01-01", props.step.date?.format ?? "parts")} into ${props.step.target ?? "the date field"}. What should it be on future runs?`,
    choices: [],
  } : undefined;
  const dateChoices = props.step.type === "date" && props.step.date !== undefined
    ? dateRuleChoices({ ...props.step, date: { ...props.step.date, rule: null } }, props.goal, new Date())
    : dateQuestion?.choices ?? [];
  const selectedRule = props.step.date?.rule ?? null;
  const selectedChoice = selectedRule === null || selectedRule === undefined ? undefined : dateChoices.find((choice) => JSON.stringify(choice.rule) === JSON.stringify(selectedRule));
  const defaultChoices = dateChoices.filter((choice) => choice.recommended || choice.rule.kind === (dateChoices.find((item) => item.recommended)?.rule.kind === "end_of_last_month" ? "start_of_last_month" : "end_of_last_month") || choice.rule.kind === "fixed");
  const visibleDateChoices = props.moreOptionsOpen ? dateChoices : selectedChoice && !defaultChoices.includes(selectedChoice) ? [...defaultChoices, selectedChoice] : defaultChoices;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const selectedValue = selectedRule === null || props.step.date === undefined ? "Choose an answer" : selectedChoice?.value
    ?? (selectedRule.kind === "fixed" ? formatDate(props.step.date.value, props.step.date.format) : formatDate(resolveDateRule(selectedRule, new Date()), props.step.date.format));
  const emailCodeCandidate = props.step.type === "click" && /code|resend|send|sms|verify/i.test(`${props.step.target ?? ""} ${props.step.description}`);
  const moveRadio = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) return;
    const group = event.currentTarget.closest<HTMLElement>('[role="radiogroup"]');
    const radios = group === null ? [] : Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const current = radios.indexOf(event.currentTarget);
    if (current < 0 || radios.length === 0) return;
    const next = event.key === "ArrowDown" || event.key === "ArrowRight" ? (current + 1) % radios.length : (current + radios.length - 1) % radios.length;
    event.preventDefault();
    radios[next]?.focus();
  };
  const answer = (rule: DateRule): void => props.onUpdateStep(props.step.id, { date: { ...props.step.date!, rule } });
  const invalid = props.stepError?.stepId === props.step.id;
  const content = <>
    <label className="step-instruction"><span className="step-number-prefix" aria-hidden="true">{props.index + 1}</span><span className={props.variant === "review" ? "visually-hidden" : "edit-field-label"}>Instruction</span><textarea ref={(field) => { if (props.fieldRefs) { props.fieldRefs.current[`step:${props.step.id}:description`] = field; props.fieldRefs.current[`removed:${props.step.id}`] = field; } }} rows={1} placeholder="Describe the action" aria-label={`Step ${props.index + 1} description`} aria-invalid={invalid || undefined} aria-describedby={invalid ? props.stepError?.messageId : undefined} value={props.step.description} disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, { description: event.target.value })} /></label>
    {props.step.type === "date" && <div className="date-preview"><span>{selectedRule === null ? "Not answered" : selectedChoice?.label ?? dateRuleLabel(selectedRule, new Date(), props.step.date?.format ?? "parts")}</span><b>→</b><span>{selectedValue}</span>{selectedRule !== null && <button type="button" className="text-button" disabled={props.busy} onClick={() => props.onUpdateStep(props.step.id, { date: { ...props.step.date!, rule: null } })}>Change answer</button>}</div>}
    {props.variant === "review" && <span id={`step-${props.step.id}-expected-outcome-help`} className="visually-hidden">The agent checks this before moving on. Leave empty unless a step is easy to get wrong.</span>}
    {props.variant === "review" ? props.expectedOutcomeOpen ? <label className="review-expected-outcome"><span className="edit-field-label">Expected outcome (optional)</span><textarea ref={(field) => { if (props.fieldRefs) props.fieldRefs.current[`step:${props.step.id}:outcome`] = field; }} rows={1} placeholder="What should the agent see after this step? (optional)" aria-label={`Step ${props.index + 1} expected outcome`} aria-describedby={`step-${props.step.id}-expected-outcome-help`} value={props.step.expectedOutcome ?? ""} disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, { expectedOutcome: event.target.value || undefined })} /></label> : <button type="button" className="expected-outcome-disclosure" title="The agent checks this before moving on. Leave empty unless a step is easy to get wrong." aria-describedby={`step-${props.step.id}-expected-outcome-help`} disabled={props.busy} onClick={props.onExpectedOutcomeOpen}>Add expected outcome</button> : <label><span className="edit-field-label">Expected outcome (optional)</span><textarea ref={(field) => { if (props.fieldRefs) props.fieldRefs.current[`step:${props.step.id}:outcome`] = field; }} rows={1} placeholder="What should the agent see after this step? (optional)" aria-label={`Step ${props.index + 1} expected outcome`} value={props.step.expectedOutcome ?? ""} disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, { expectedOutcome: event.target.value || undefined })} /></label>}
    {emailCodeCandidate && <label className="review-email-code"><input ref={(field) => { if (props.fieldRefs) props.fieldRefs.current[`step:${props.step.id}:email-code`] = field; }} type="checkbox" aria-label={`Step ${props.index + 1} requests or resends email code`} checked={props.step.requestsEmailCode === true} disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, { requestsEmailCode: event.target.checked })} /><span>Requests email code</span></label>}
    {typedField && <div className="review-step-note"><label className="review-step-kind">Field<select aria-label={`Step ${props.index + 1} field type`} value={props.step.type === "credential" ? props.step.value ?? "" : ""} disabled={props.busy} onChange={(event) => props.onSetFieldKind(props.step, event.target.value as CredentialKind | "")}><option value="">Text</option><option value="username">Saved username</option><option value="password">Saved password</option><option value="otp">Saved one-time code</option></select></label>{props.step.type !== "credential" ? <label className="review-step-value">{props.step.type === "select_change" ? "Choose" : "Type"}{props.step.type === "select_change" ? <input aria-label={`Step ${props.index + 1} option`} value={props.step.value ?? ""} placeholder="Option to choose" disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, choiceUpdate(props.step, event.target.value))} /> : <textarea rows={1} aria-label={`Step ${props.index + 1} text`} value={props.step.value ?? ""} placeholder="Leave empty to clear the field" disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, { value: event.target.value })} />}</label> : <span>Uses the {credentialLabel(props.step.value)} from your demonstration, stored encrypted; never part of these instructions.</span>}</div>}
    {props.step.type === "select_change" && !typedField && <label className="review-step-value">Choose<input aria-label={`Step ${props.index + 1} option`} value={props.step.value ?? ""} placeholder="Option to choose" disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, choiceUpdate(props.step, event.target.value))} /></label>}
    {dateQuestion && <div className="question-block"><p id={`step-${props.step.id}-question`}>{dateQuestion.text}</p><div role="radiogroup" aria-labelledby={`step-${props.step.id}-question`}>{visibleDateChoices.map((choice, choiceIndex) => { const checked = JSON.stringify(choice.rule) === JSON.stringify(selectedRule); const consequence = choice.rule.kind === "fixed" ? choice.value : formatDate(resolveDateRule(choice.rule, tomorrow), props.step.date?.format ?? "parts"); return <button type="button" role="radio" key={JSON.stringify(choice.rule)} className="question-choice" aria-checked={checked} tabIndex={checked || (selectedRule === null && choiceIndex === 0) ? 0 : -1} disabled={props.busy} onKeyDown={moveRadio} onClick={() => answer(choice.rule)}><strong>{choice.label}</strong><span>{choice.value}</span>{choice.recommended && <em>Recommended</em>}{checked && <small className="question-consequence">Next run enters {consequence}</small>}{choice.rule.kind === "fixed" && <small className="question-warning">Every run will use this same date.</small>}</button>; })}<button type="button" className="text-button more-options" aria-expanded={props.moreOptionsOpen} disabled={props.busy} onClick={() => props.onMoreOptionsOpen(!props.moreOptionsOpen)}>More options…</button>{props.moreOptionsOpen && <button type="button" role="radio" className="question-choice" aria-checked={props.otherOpen && dateChoices.every((choice) => JSON.stringify(choice.rule) !== JSON.stringify(selectedRule))} tabIndex={props.otherOpen ? 0 : -1} disabled={props.busy} onKeyDown={moveRadio} onClick={() => props.onOtherOpen(true)}><strong>Other…</strong></button>}</div>{props.otherOpen && <input aria-label={`Other answer for step ${props.index + 1}`} placeholder="For example: the last working day of last month" value={props.otherText} disabled={props.busy} onChange={(event) => props.onOtherText(event.target.value)} onBlur={() => props.onAnswerOther(props.step.id, props.otherText)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); props.onAnswerOther(props.step.id, props.otherText); } }} />}</div>}
    {props.step.type === "credential" && props.step.value === "otp" && props.credentialsAllowed && !props.savedCredentials.includes("otp") && <div className="question-block"><p id={`step-${props.step.id}-question`}>Step {props.index + 1} needs a one-time code. How should the agent get it?</p><div role="radiogroup" aria-labelledby={`step-${props.step.id}-question`}><button type="button" role="radio" className="question-choice" aria-checked={!props.otherOpen} tabIndex={props.otherOpen ? -1 : 0} disabled={props.busy} onKeyDown={moveRadio} onClick={props.onRequestOtp}><strong>Authenticator app or email code set up in Reiterate</strong><em>Recommended</em></button><button type="button" role="radio" className="question-choice" aria-checked={props.otherOpen} tabIndex={props.otherOpen ? 0 : -1} disabled={props.busy} onKeyDown={moveRadio} onClick={() => props.onOtherOpen(true)}><strong>Other…</strong></button></div>{props.otherOpen && <><input aria-label={`Other answer for step ${props.index + 1}`} placeholder="For example: a code sent by text message" value={props.otherText} disabled={props.busy} onChange={(event) => props.onOtherText(event.target.value)} /><small>Reiterate does not support this yet. Choose the first option to set up an authenticator app or email code.</small></>}</div>}
  </>;
  const mergeCandidate = props.step.type === "input" && isDateMergeCandidate(props.steps, props.index);
  const mergeNote = props.step.type === "date" && props.step.uiMerged === true && props.step.parts !== undefined && <p className="merge-note">Combined from {props.step.parts.length} recorded steps · <button type="button" className="text-button" onClick={() => props.onUndoMergedStep(props.step.id)} disabled={props.busy}>Undo</button></p>;
  if (props.variant === "review") return <li className={`review-step${props.step.type === "download" ? " review-step-download" : ""}${invalid ? " step-invalid" : ""}`}><div>{content}{mergeNote}</div><div className="edit-step-controls"><button type="button" className="icon-button" aria-label={`Move step ${props.index + 1} up`} disabled={props.busy || props.index === 0} onClick={() => props.onMoveStep?.(props.index, -1)}><EditIcon name="up" /></button><button type="button" className="icon-button" aria-label={`Move step ${props.index + 1} down`} disabled={props.busy || props.index === props.steps.length - 1} onClick={() => props.onMoveStep?.(props.index, 1)}><EditIcon name="down" /></button><button type="button" className="icon-button" aria-label={`Remove step ${props.index + 1}`} disabled={props.busy} onClick={() => props.onRemoveStep(props.step.id)}><EditIcon name="close" /></button></div>{mergeCandidate && <input type="checkbox" aria-label={`Select step ${props.index + 1} for date merge`} checked={props.selected} disabled={props.busy} onChange={() => props.onToggleSelected(props.step.id)} />}</li>;
  return <div className={`edit-step${invalid ? " step-invalid" : ""}`}><div>{content}{mergeNote}</div><div className="edit-step-controls"><button className="icon-button" aria-label={`Move step ${props.index + 1} up`} disabled={props.busy || props.index === 0} onClick={() => props.onMoveStep?.(props.index, -1)}><EditIcon name="up" /></button><button className="icon-button" aria-label={`Move step ${props.index + 1} down`} disabled={props.busy || props.index === props.steps.length - 1} onClick={() => props.onMoveStep?.(props.index, 1)}><EditIcon name="down" /></button><button className="icon-button" aria-label={`Remove step ${props.index + 1}`} disabled={props.busy} onClick={() => props.onRemoveStep(props.step.id)}><EditIcon name="close" /></button></div>{mergeCandidate && <input type="checkbox" aria-label={`Select step ${props.index + 1} for date merge`} checked={props.selected} disabled={props.busy} onChange={() => props.onToggleSelected(props.step.id)} />}</div>;
}

function Review(props: { steps: SetupStep[]; goal: string; organizing: boolean; busy: boolean; credentialsAllowed: boolean; savedCredentials: CredentialKind[]; fieldRefs: StepEditorProps["fieldRefs"]; stepError: StepEditorProps["stepError"]; onRequestOtp(): void; onUpdateStep(id: string, updates: Partial<SetupStep>): void; onRemoveStep(id: string): void; onMergeSteps(ids: string[]): void; onUndoMergedStep(id: string): void; onMoveStep(index: number, delta: number): void; onBack(): void; onContinue(): void; onInsert(): void }): JSX.Element {
  const renameStage = (index: number, name: string): void => { const group = groupSteps(props.steps)[groupSteps(props.steps).findIndex((item) => item.steps.some(({ index: itemIndex }) => itemIndex === index))]; group?.steps.forEach(({ step }) => props.onUpdateStep(step.id, { stage: name })); };
  return <div className="setup-panel review-panel"><div className="stage-title"><h2>Review and complete the setup</h2><p>Make each instruction clear. Typed text and choices are repeated on every run; sign-in fields use details you save in Reiterate.</p></div>{props.organizing && <p className="setup-notice organizing-notice" role="status"><span className="edit-spinner" aria-hidden="true" />Grouping your steps into stages and making them easier to read. You can edit while this finishes.</p>}<StepEditor variant="review" {...props} onRenameStage={renameStage} onInsert={props.onInsert} /></div>;
}

function Test(props: {
  steps: SetupStep[]; url: string; scheduleRecovery: boolean; emailRoutesAllowed: boolean; textAllowed: boolean; googleAllowed: boolean; doneWhen: DoneWhen;
  onDoneWhen(value: DoneWhen): void; onChooseEmail(): void; onAllowEmail(): void; onChangeCredentials(): void; onConnectGoogle(): void; run: RunState | null; busy: boolean; emailStatus: "waiting" | "routed" | "rejected" | "no_documents" | "timeout" | null; emailFrom: string | null; emailFiles: Array<{ name: string; url: string }>; canContinue: boolean;
  onRun(): void; onStop(): void; onSchedule(): void; onBack(): void; onEditStep(id: string, description: string): void;
}): JSX.Element {
  const [screenIndex, setScreenIndex] = useState<number | null>(null);
  const [railTab, setRailTab] = useState<"activity" | "steps">("steps");
  const [customText, setCustomText] = useState(props.doneWhen.kind === "described" ? props.doneWhen.value : "");
  const rowsRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef<HTMLDetailsElement>(null);
  const emailRun = props.doneWhen.kind === "email" && props.run?.status === "succeeded";
  const emailProblem = emailRun && ["rejected", "no_documents", "timeout"].includes(props.emailStatus ?? "");
  const failed = props.run?.status === "failed" || emailProblem;
  const passed = props.run?.status === "succeeded" && (!emailRun || props.emailStatus === "routed");
  const running = props.run?.status === "running";
  const userStopped = props.run?.failure?.kind === "stopped";
  const locked = props.busy || running || props.scheduleRecovery;
  const stopped = props.run?.stoppedAtStep && Number.isInteger(props.run.stoppedAtStep) && props.run.stoppedAtStep > 0 && props.run.stoppedAtStep <= props.steps.length ? props.run.stoppedAtStep - 1 : null;
  const failureMessage = props.run?.failure?.message ?? props.run?.error;
  const criterionNotMet = props.run?.status === "failed" && failureMessage?.startsWith("Success criterion not met: ");
  const kind = criterionNotMet ? "check" : props.run?.failure?.kind;
  const failedStep = (kind === "steps" || kind === "signin" || kind === "google" || kind === "website" || kind === "unknown") && stopped !== null;
  const completedSteps = props.run?.status === "succeeded" || kind === "result" || kind === "check";
  const options = doneWhenOptions(props.steps, props.run ? { confirmation: props.run.confirmation, failureKind: kind, files: props.run.files } : null, props.doneWhen)
    .filter((option) => (option.action !== "email" || props.emailRoutesAllowed) && (props.textAllowed || option.doneWhen?.kind !== "text"));
  const files = props.doneWhen.kind === "email" ? props.emailFiles : props.run?.files ?? [];
  const statusText = props.emailStatus === "rejected" && emailRun ? `The export arrived from ${props.emailFrom ?? "an external sender"}`
    : props.emailStatus === "no_documents" && emailRun ? "The email arrived without a file"
    : props.emailStatus === "timeout" && emailRun ? "The export email didn’t arrive"
    : props.emailStatus === "routed" && emailRun ? "The export arrived in Reiterate"
    : userStopped ? `You stopped the test${stopped !== null ? ` at step ${stopped + 1}` : ""}`
    : kind === "service" ? "Reiterate couldn’t run the test"
    : kind === "signin" ? "The website didn’t accept the sign-in"
    : kind === "google" ? "The agent needs a Google sign-in"
    : kind === "steps" && stopped !== null ? `Stuck at step ${stopped + 1}`
    : kind === "result" ? "Every step ran, but no file was downloaded"
    : criterionNotMet ? "The success criterion wasn’t met"
    : kind === "check" ? "The website result wasn’t confirmed"
    : failed ? "The test stopped" : passed ? "The agent completed every step"
    : emailRun ? "Waiting for the export email" : running ? "Test is running" : "Not tested yet";
  const serviceFailure = kind === "service";
  const statusDetail = userStopped ? "Nothing needs changing. Run the test again when you are ready."
    : serviceFailure ? (stopped !== null
      ? `Reiterate’s AI service stopped responding at step ${stopped + 1}. Run the test again in a few minutes. Your steps do not need changing.`
      : "The agent stopped before it opened the website because Reiterate’s AI service didn’t respond. None of your steps were tried. Run the test again in a few minutes. Your steps do not need changing.")
    : emailRun && props.emailStatus === "rejected" ? `New Reiterate addresses only accept email from you. Allow ${props.emailFrom ?? "this sender"}, then run the test again.`
    : emailRun && props.emailStatus === "no_documents" ? "The email arrived without a file. Check the export settings and run the test again."
    : emailRun && props.emailStatus === "timeout" ? "The email didn’t arrive within three minutes. Check the export settings and run the test again."
    : emailRun && props.emailStatus === "waiting" ? `Waiting for the export at ${props.doneWhen.kind === "email" ? props.doneWhen.address : "Reiterate"}.`
    : criterionNotMet ? failureMessage!.slice("Success criterion not met: ".length)
    : kind === "steps" ? "The steps before it worked. Rewrite the highlighted step below, then run the test again."
    : kind === "signin" ? "Check the saved sign-in details, then run the test again."
    : kind === "google" ? "Connect the Google account this website uses, then run the test again."
    : kind === "result" ? "Choose how Reiterate knows the run worked under Done when."
    : passed && props.doneWhen.kind === "described" && props.run?.confirmation ? `Agent saw: ${props.run.confirmation}`
    : props.run?.status === "succeeded" && !emailRun && files.length === 0 ? "Reiterate doesn’t keep a file from this run, so workflows can’t use its output."
    : running ? "Watch the browser while the agent works through your steps."
    : props.run?.failure?.message ?? (failed ? props.run?.error : props.run?.confirmation) ?? "";
  useEffect(() => { setScreenIndex(null); }, [props.run?.id]);
  // Watch the agent while it works, then review the result against the steps.
  const runId = props.run?.id;
  useEffect(() => { if (runId) setRailTab(running ? "activity" : "steps"); }, [runId, running]);
  useEffect(() => {
    if (running) return;
    if (props.run?.id && optionsRef.current) optionsRef.current.open = kind === "result" || kind === "check";
  }, [props.run?.id, running, kind]);
  useEffect(() => {
    if (running || railTab !== "steps") return;
    const target = failedStep ? rowsRef.current?.querySelectorAll<HTMLElement>(".test-step")[stopped!] : kind === "result" || kind === "check" ? rowsRef.current?.querySelector<HTMLElement>(".done-when") : null;
    const list = rowsRef.current;
    if (list && target) list.scrollTop += target.getBoundingClientRect().top - list.getBoundingClientRect().top - 16;
    else if (list && completedSteps) list.scrollTop = list.scrollHeight;
  }, [props.run?.id, running, failedStep, stopped, kind, completedSteps, railTab]);
  const moveTab = (event: ReactKeyboardEvent): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = railTab === "activity" ? "steps" : "activity";
    setRailTab(next);
    document.getElementById(`test-tab-${next}`)?.focus();
  };
  const choose = (option: typeof options[number]): void => {
    if (option.action === "email") return props.onChooseEmail();
    if (option.action === "custom") { if (customText.trim()) props.onDoneWhen({ kind: "described", value: customText.trim() }); return; }
    if (option.doneWhen) props.onDoneWhen(option.doneWhen);
  };
  return <div className="setup-workbench">
    <div className="stage-title stage-title-inline"><h2>Verify agent can follow the process</h2><HelpTip label="How the test works">Reiterate runs your steps in a new browser. Watch it work, and if it stops, fix the step in the list.</HelpTip></div>
    <div className="workbench-grid">
      <TestBrowser run={props.run} url={props.url} passed={passed} serviceFailure={serviceFailure} screenIndex={screenIndex} onSelectScreen={setScreenIndex} />
      <aside className="test-rail" aria-label="Test steps"><header><h3>{props.run ? "Test result" : "Your steps"}</h3><span>{props.run ? `${completedSteps ? props.steps.length : userStopped && stopped !== null ? stopped + 1 : failedStep ? stopped! + 1 : 0} of ${props.steps.length} reached` : `${props.steps.length} steps`}</span></header>
        <div className={`run-status ${failed && !userStopped ? "bad" : passed ? "good" : ""}`} role={failed && !userStopped ? "alert" : "status"}><small>{userStopped ? "Test stopped" : serviceFailure ? "Reiterate problem · not your steps" : kind === "steps" ? "Step needs clearer wording" : kind === "signin" ? "Sign-in problem" : kind === "google" ? "Google sign-in needed" : kind === "result" ? "No file came back" : kind === "check" ? "Done-when check not met" : emailProblem ? props.emailStatus === "rejected" ? "Email not accepted" : "Email not received" : passed ? "Test passed" : running ? "Test running" : emailRun ? "Waiting for email" : failed ? "Test failed" : "Not tested yet"}</small><strong>{statusText}</strong><p>{props.run ? statusDetail : "Run the test to watch the agent work through these steps in a fresh browser."}</p>{!serviceFailure && !userStopped && props.run?.failure?.message && kind !== "result" && kind !== "check" && <blockquote><b>The agent said</b>{props.run.failure.message}</blockquote>}{emailRun && props.emailStatus === "rejected" && props.emailFrom && <button type="button" className="button button-primary" onClick={props.onAllowEmail} disabled={locked}>Accept emails from {props.emailFrom}</button>}{kind === "signin" && <button type="button" className="button button-quiet" onClick={props.onChangeCredentials} disabled={locked}>Change sign-in details</button>}{kind === "google" && (props.googleAllowed ? <button type="button" className="button button-quiet" onClick={props.onConnectGoogle} disabled={locked}>Connect Google</button> : <p>Open Credentials → Connect Google for this agent.</p>)}</div>
        <div className="rail-tabs" role="tablist" aria-label="Test details" onKeyDown={moveTab}>
          <button type="button" role="tab" id="test-tab-activity" aria-controls="test-panel-activity" aria-selected={railTab === "activity"} tabIndex={railTab === "activity" ? 0 : -1} onClick={() => setRailTab("activity")}>Activity</button>
          <button type="button" role="tab" id="test-tab-steps" aria-controls="test-panel-steps" aria-selected={railTab === "steps"} tabIndex={railTab === "steps" ? 0 : -1} onClick={() => setRailTab("steps")}>Steps <span>{props.steps.length}</span></button>
        </div>
        <div className="rail-panel" role="tabpanel" id="test-panel-activity" aria-labelledby="test-tab-activity" hidden={railTab !== "activity"}>{railTab === "activity" && <ActivityLog run={props.run} />}</div>
        <div className="test-steps" role="tabpanel" id="test-panel-steps" hidden={railTab !== "steps"} ref={rowsRef} tabIndex={0} aria-label="Test steps list">{props.steps.map((step, index) => { const done = completedSteps || (stopped !== null && index < stopped && (failedStep || userStopped)); const isStopped = userStopped && stopped === index; const isFailed = failedStep && index === stopped; const relativeDate = lastMonthRewrite(step.description); const startsStage = step.stage != null && step.stage !== props.steps[index - 1]?.stage && (Boolean(step.stage.trim()) || index > 0); return <Fragment key={step.id}>{startsStage && <div className="test-stage">{step.stage?.trim() || "Then"}</div>}<div className={`test-step ${done ? "done" : isStopped ? "stopped" : isFailed ? "failed" : userStopped && stopped !== null && index > stopped ? "notrun" : props.run?.status === "failed" && !serviceFailure && failedStep && index > stopped! ? "notrun" : serviceFailure ? "notrun" : ""}`}><span>{done ? "✓" : isFailed ? "!" : index + 1}</span><div>{isFailed ? <textarea aria-label={`Step ${index + 1} instruction`} disabled={locked} value={step.description} onChange={(event) => props.onEditStep(step.id, event.target.value)} /> : step.description}{step.type === "credential" && <small>Uses the {credentialLabel(step.value)} saved in Reiterate, stored encrypted. <button type="button" className="text-button" onClick={props.onChangeCredentials} disabled={locked}>Change</button></small>}{isStopped && <small>Stopped here</small>}{isFailed && <small>Stopped here · <button type="button" className="text-button" onClick={() => setScreenIndex(null)}>Show screen</button></small>}{relativeDate && <small>Fixed date: every run picks this day <button type="button" className="date-chip" disabled={locked} onClick={() => props.onEditStep(step.id, relativeDate)}>Use last month</button></small>}</div></div></Fragment> })}
          <div className={`done-when ${passed ? "done" : kind === "result" || kind === "check" || emailProblem ? "failed" : ""}`}><b>Done when</b><div>{props.doneWhen.kind === "file" ? "A file is downloaded in the browser" : props.doneWhen.kind === "described" ? `The agent confirms: ${props.doneWhen.value}` : props.doneWhen.kind === "text" ? `“${props.doneWhen.value}” appears on the page` : props.doneWhen.kind === "email" ? `The export arrives at ${props.doneWhen.address}` : `The agent clicks “${props.doneWhen.value}”`}</div>{files.map((file) => { const link = safeFileUrl(file.url); return link && <a href={link} target="_blank" rel="noreferrer" key={`${file.name}:${file.url}`}>↓ {file.name}</a>; })}{!running && <details className="done-options" ref={optionsRef}><summary>Change</summary><p>{props.run === null ? "Suggested from your steps." : "Suggested from your steps and from what the agent saw at the end of this test."}</p>{options.map((option) => <div key={option.label}><button type="button" className={option.doneWhen && JSON.stringify(option.doneWhen) === JSON.stringify(props.doneWhen) ? "selected" : ""} disabled={locked} onClick={() => choose(option)}><strong>{option.label}</strong><span className="option-badges">{option.recommended && <em>Recommended</em>}{option.strength && <em className={option.strength}>{option.strength === "strong" ? "Strong evidence" : option.strength === "medium" ? "Some evidence" : "Weak evidence"}</em>}</span><small>{option.why}</small></button>{option.action === "custom" && <textarea rows={2} aria-label="Success criterion" disabled={locked} maxLength={300} placeholder="For example: a message says the export was emailed to me" value={customText} onChange={(event) => setCustomText(event.target.value)} onBlur={() => { if (customText.trim()) props.onDoneWhen({ kind: "described", value: customText.trim() }); }} />}</div>)}</details>}</div>
        </div>
        <footer><button type="button" className="text-button" onClick={props.onBack} disabled={locked}>Back to review</button><span />{running && <button type="button" className="button button-quiet" onClick={props.onStop} disabled={props.busy || props.run?.stopping === true} aria-busy={props.run?.stopping === true}>{props.run?.stopping ? "Stopping…" : "Stop test"}</button>}<button type="button" className={`button ${props.canContinue ? "button-quiet" : "button-primary"}`} onClick={props.onRun} disabled={locked}>{running ? "Running…" : props.run ? "Run test again" : "Run test"}</button>{props.canContinue && <button type="button" className="button button-primary" onClick={props.onSchedule}>Continue to schedule</button>}</footer>
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
