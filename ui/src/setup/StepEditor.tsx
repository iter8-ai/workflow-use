import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { dateRuleChoices, dateRuleLabel, formatDate, groupSteps, mergeDateSteps, openQuestions, resolveDateRule, type CredentialKind, type DateRule, type SetupStep } from "./compiler";
import { credentialLabel, openQuestionCount } from "./stepList";

/** The Instructions editor shared by setup's Review and the edit page. Page navigation stays outside it. */
export type StepEditorProps = {
  steps: SetupStep[];
  goal: string;
  busy: boolean;
  credentialsAllowed: boolean;
  savedCredentials: CredentialKind[];
  onRequestOtp(): void;
  onUpdateStep(id: string, updates: Partial<SetupStep>): void;
  onRemoveStep(id: string): void;
  onMergeSteps(ids: string[]): void;
  onUndoMergedStep(id: string): void;
  onMoveStep(index: number, delta: number): void;
  onRenameStage(index: number, name: string): void;
  onInsert(): void;
  fieldRefs?: FieldRefs;
};
type FieldRefs = { current: Record<string, HTMLInputElement | HTMLTextAreaElement | null> };

export function StepEditor(props: StepEditorProps): JSX.Element {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [expectedOutcomeOpen, setExpectedOutcomeOpen] = useState<Record<string, boolean>>({});
  const [moreOptionsOpen, setMoreOptionsOpen] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  // The field to focus once the list has re-rendered: a step's instruction, or its newly opened expected outcome.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const ownFieldRefs = useRef<FieldRefs["current"]>({});
  const fieldRefs = props.fieldRefs ?? ownFieldRefs;
  // The step count when Insert step was pressed; the next longer list puts focus on its new last step.
  const insertedFromRef = useRef<number | null>(null);
  const questionCount = openQuestionCount(props);
  const groups = groupSteps(props.steps);
  const selected = selectedIds.map((id) => props.steps.findIndex((step) => step.id === id)).filter((index) => index >= 0);
  const canMerge = selected.length >= 2 && selected.length <= 3 && selected.every((index) => props.steps[index]?.type === "input") && Math.max(...selected) - Math.min(...selected) + 1 === selected.length
    && mergeDateSteps(selected.map((index) => props.steps[index]!), true)[0]?.type === "date";
  const hasMergeCandidates = props.steps.some((_, index) => isDateMergeCandidate(props.steps, index));
  useEffect(() => {
    const from = insertedFromRef.current;
    if (from === null || props.steps.length <= from) return;
    insertedFromRef.current = null;
    fieldRefs.current[`step:${props.steps.at(-1)!.id}:description`]?.focus();
  }, [fieldRefs, props.steps]);
  useEffect(() => {
    if (focusKey === null) return;
    fieldRefs.current[focusKey]?.focus();
    setFocusKey(null);
  }, [focusKey, fieldRefs, props.steps]);
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
  const removeStep = (id: string): void => {
    const stepIndex = props.steps.findIndex((item) => item.id === id);
    const next = props.steps[stepIndex + 1] ?? props.steps[stepIndex - 1];
    props.onRemoveStep(id);
    setFocusKey(next ? `step:${next.id}:description` : null);
  };
  const undoMergedStep = (id: string): void => {
    const current = props.steps.find((item) => item.id === id);
    props.onUndoMergedStep(id);
    setFocusKey(current?.parts?.[0] ? `step:${current.parts[0].id}:description` : null);
  };
  return <div className="instructions-editor">
    {questionCount > 0 && <div className="setup-notice question-notice" role="status">{questionCount} question{questionCount === 1 ? "" : "s"} to answer before testing</div>}
    {hasMergeCandidates && <div className="merge-date-actions"><button type="button" className="button button-quiet merge-date-button" disabled={props.busy || !canMerge} onClick={() => { const first = props.steps.find((step) => selectedIds.includes(step.id)); props.onMergeSteps(selected.map((index) => props.steps[index]!.id)); setSelectedIds([]); setFocusKey(first ? `step:${first.id}:description` : null); }}>Combine into one date step</button><span className="field-note">Tick the day, month and year fields, then combine them.</span></div>}
    <div className="review-list">
      {groups.map((group) => {
        const first = group.steps[0]!.index + 1, last = group.steps.at(-1)!.index + 1;
        return <section className="review-stage" key={group.steps[0]!.step.id} aria-label={group.stage ?? "Steps"}>
          {group.stage !== null && <input className="review-stage-name" aria-label={first === last ? `Stage name for step ${first}` : `Stage name for steps ${first}–${last}`} value={group.stage} maxLength={60} disabled={props.busy} placeholder="Stage name" onChange={(event) => props.onRenameStage(first - 1, event.target.value)} />}
          <ol start={first}>{group.steps.map(({ step, index }) => <StepEditorRow key={step.id} {...props} fieldRefs={fieldRefs} step={step} index={index} selected={selectedIds.includes(step.id)} onToggleSelected={toggleSelected}
            expectedOutcomeOpen={expectedOutcomeOpen[step.id] === true || Boolean(step.expectedOutcome?.trim())}
            // Keep the field once it is in use, so clearing an outcome does not take the field away mid-edit.
            onExpectedOutcomeOpen={() => setExpectedOutcomeOpen((current) => current[step.id] ? current : { ...current, [step.id]: true })}
            onAddExpectedOutcome={() => { setExpectedOutcomeOpen((current) => ({ ...current, [step.id]: true })); setFocusKey(`step:${step.id}:outcome`); }}
            onSetFieldKind={setFieldKind} onRemoveStep={removeStep} onUndoMergedStep={undoMergedStep}
            otherOpen={otherOpen[step.id] === true} onOtherOpen={(open) => setOtherOpen((current) => ({ ...current, [step.id]: open }))}
            moreOptionsOpen={moreOptionsOpen[step.id] === true} onMoreOptionsOpen={(open) => setMoreOptionsOpen((current) => ({ ...current, [step.id]: open }))}
            otherText={otherText[step.id] ?? ""} onOtherText={(value) => setOtherText((current) => ({ ...current, [step.id]: value }))} onAnswerOther={answerOther} />)}</ol>
        </section>;
      })}
    </div>
    <button type="button" className="button button-quiet insert-step" disabled={props.busy} onClick={() => { insertedFromRef.current = props.steps.length; props.onInsert(); }}>Insert step</button>
  </div>;
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

function StepEditorRow(props: StepEditorProps & { fieldRefs: FieldRefs; step: SetupStep; index: number; selected: boolean; onToggleSelected(id: string): void; onSetFieldKind(step: SetupStep, kind: CredentialKind | ""): void; expectedOutcomeOpen: boolean; onExpectedOutcomeOpen(): void; onAddExpectedOutcome(): void; otherOpen: boolean; onOtherOpen(open: boolean): void; moreOptionsOpen: boolean; onMoreOptionsOpen(open: boolean): void; otherText: string; onOtherText(value: string): void; onAnswerOther(id: string, text: string): void }): JSX.Element {
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
  const outcomeHelpId = `step-${props.step.id}-expected-outcome-help`;
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
  const mergeCandidate = props.step.type === "input" && isDateMergeCandidate(props.steps, props.index);
  return <li className={`review-step${props.step.type === "download" ? " review-step-download" : ""}`}><div>
    <label className="step-instruction"><span className="step-number-prefix" aria-hidden="true">{props.index + 1}</span><span className="visually-hidden">Instruction</span><textarea ref={(field) => { props.fieldRefs.current[`step:${props.step.id}:description`] = field; props.fieldRefs.current[`removed:${props.step.id}`] = field; }} rows={1} placeholder="Describe the action" aria-label={`Step ${props.index + 1} description`} value={props.step.description} disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, { description: event.target.value })} /></label>
    {props.step.type === "date" && <div className="date-preview"><span>{selectedRule === null ? "Not answered" : selectedChoice?.label ?? dateRuleLabel(selectedRule, new Date(), props.step.date?.format ?? "parts")}</span><b>→</b><span>{selectedValue}</span>{selectedRule !== null && <button type="button" className="text-button" disabled={props.busy} onClick={() => props.onUpdateStep(props.step.id, { date: { ...props.step.date!, rule: null } })}>Change answer</button>}</div>}
    <span id={outcomeHelpId} className="visually-hidden">The agent checks this before moving on. Leave empty unless a step is easy to get wrong.</span>
    {props.expectedOutcomeOpen
      ? <label className="review-expected-outcome"><span className="edit-field-label">Expected outcome (optional)</span><textarea ref={(field) => { props.fieldRefs.current[`step:${props.step.id}:outcome`] = field; }} rows={1} placeholder="What should the agent see after this step? (optional)" aria-label={`Step ${props.index + 1} expected outcome`} aria-describedby={outcomeHelpId} value={props.step.expectedOutcome ?? ""} disabled={props.busy} onChange={(event) => { props.onExpectedOutcomeOpen(); props.onUpdateStep(props.step.id, { expectedOutcome: event.target.value || undefined }); }} /></label>
      : <button type="button" className="expected-outcome-disclosure" title="The agent checks this before moving on. Leave empty unless a step is easy to get wrong." aria-describedby={outcomeHelpId} disabled={props.busy} onClick={props.onAddExpectedOutcome}>Add expected outcome</button>}
    {emailCodeCandidate && <label className="review-email-code"><input ref={(field) => { props.fieldRefs.current[`step:${props.step.id}:email-code`] = field; }} type="checkbox" aria-label={`Step ${props.index + 1} requests or resends email code`} checked={props.step.requestsEmailCode === true} disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, { requestsEmailCode: event.target.checked })} /><span>Requests email code</span></label>}
    {typedField && <div className="review-step-note"><label className="review-step-kind">Field<select aria-label={`Step ${props.index + 1} field type`} value={props.step.type === "credential" ? props.step.value ?? "" : ""} disabled={props.busy} onChange={(event) => props.onSetFieldKind(props.step, event.target.value as CredentialKind | "")}><option value="">Text</option><option value="username">Saved username</option><option value="password">Saved password</option><option value="otp">Saved one-time code</option></select></label>{props.step.type !== "credential" ? <label className="review-step-value">{props.step.type === "select_change" ? "Choose" : "Type"}{props.step.type === "select_change" ? <input aria-label={`Step ${props.index + 1} option`} value={props.step.value ?? ""} placeholder="Option to choose" disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, choiceUpdate(props.step, event.target.value))} /> : <textarea rows={1} aria-label={`Step ${props.index + 1} text`} value={props.step.value ?? ""} placeholder="Leave empty to clear the field" disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, { value: event.target.value })} />}</label> : <span>Uses the {credentialLabel(props.step.value)} from your demonstration, stored encrypted; never part of these instructions.</span>}</div>}
    {props.step.type === "select_change" && !typedField && <label className="review-step-value">Choose<input aria-label={`Step ${props.index + 1} option`} value={props.step.value ?? ""} placeholder="Option to choose" disabled={props.busy} onChange={(event) => props.onUpdateStep(props.step.id, choiceUpdate(props.step, event.target.value))} /></label>}
    {dateQuestion && <div className="question-block"><p id={`step-${props.step.id}-question`}>{dateQuestion.text}</p><div role="radiogroup" aria-labelledby={`step-${props.step.id}-question`}>{visibleDateChoices.map((choice, choiceIndex) => { const checked = JSON.stringify(choice.rule) === JSON.stringify(selectedRule); const consequence = choice.rule.kind === "fixed" ? choice.value : formatDate(resolveDateRule(choice.rule, tomorrow), props.step.date?.format ?? "parts"); return <button type="button" role="radio" key={JSON.stringify(choice.rule)} className="question-choice" aria-checked={checked} tabIndex={checked || (selectedRule === null && choiceIndex === 0) ? 0 : -1} disabled={props.busy} onKeyDown={moveRadio} onClick={() => answer(choice.rule)}><strong>{choice.label}</strong><span>{choice.value}</span>{choice.recommended && <em>Recommended</em>}{checked && <small className="question-consequence">Next run enters {consequence}</small>}{choice.rule.kind === "fixed" && <small className="question-warning">Every run will use this same date.</small>}</button>; })}<button type="button" className="text-button more-options" aria-expanded={props.moreOptionsOpen} disabled={props.busy} onClick={() => props.onMoreOptionsOpen(!props.moreOptionsOpen)}>More options…</button>{props.moreOptionsOpen && <button type="button" role="radio" className="question-choice" aria-checked={props.otherOpen && dateChoices.every((choice) => JSON.stringify(choice.rule) !== JSON.stringify(selectedRule))} tabIndex={props.otherOpen ? 0 : -1} disabled={props.busy} onKeyDown={moveRadio} onClick={() => props.onOtherOpen(true)}><strong>Other…</strong></button>}</div>{props.otherOpen && <input aria-label={`Other answer for step ${props.index + 1}`} placeholder="For example: the last working day of last month" value={props.otherText} disabled={props.busy} onChange={(event) => props.onOtherText(event.target.value)} onBlur={() => props.onAnswerOther(props.step.id, props.otherText)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); props.onAnswerOther(props.step.id, props.otherText); } }} />}</div>}
    {props.step.type === "credential" && props.step.value === "otp" && props.credentialsAllowed && !props.savedCredentials.includes("otp") && <div className="question-block"><p id={`step-${props.step.id}-question`}>Step {props.index + 1} needs a one-time code. How should the agent get it?</p><div role="radiogroup" aria-labelledby={`step-${props.step.id}-question`}><button type="button" role="radio" className="question-choice" aria-checked={!props.otherOpen} tabIndex={props.otherOpen ? -1 : 0} disabled={props.busy} onKeyDown={moveRadio} onClick={props.onRequestOtp}><strong>Authenticator app or email code set up in Reiterate</strong><em>Recommended</em></button><button type="button" role="radio" className="question-choice" aria-checked={props.otherOpen} tabIndex={props.otherOpen ? 0 : -1} disabled={props.busy} onKeyDown={moveRadio} onClick={() => props.onOtherOpen(true)}><strong>Other…</strong></button></div>{props.otherOpen && <><input aria-label={`Other answer for step ${props.index + 1}`} placeholder="For example: a code sent by text message" value={props.otherText} disabled={props.busy} onChange={(event) => props.onOtherText(event.target.value)} /><small>Reiterate does not support this yet. Choose the first option to set up an authenticator app or email code.</small></>}</div>}
    {props.step.type === "date" && props.step.uiMerged === true && props.step.parts !== undefined && <p className="merge-note">Combined from {props.step.parts.length} recorded steps · <button type="button" className="text-button" onClick={() => props.onUndoMergedStep(props.step.id)} disabled={props.busy}>Undo</button></p>}
  </div><div className="edit-step-controls"><button type="button" className="icon-button" aria-label={`Move step ${props.index + 1} up`} disabled={props.busy || props.index === 0} onClick={() => props.onMoveStep(props.index, -1)}><EditIcon name="up" /></button><button type="button" className="icon-button" aria-label={`Move step ${props.index + 1} down`} disabled={props.busy || props.index === props.steps.length - 1} onClick={() => props.onMoveStep(props.index, 1)}><EditIcon name="down" /></button><button type="button" className="icon-button" aria-label={`Remove step ${props.index + 1}`} disabled={props.busy} onClick={() => props.onRemoveStep(props.step.id)}><EditIcon name="close" /></button></div>{mergeCandidate && <input type="checkbox" aria-label={`Select step ${props.index + 1} for date merge`} checked={props.selected} disabled={props.busy} onChange={() => props.onToggleSelected(props.step.id)} />}</li>;
}

export function EditIcon({ name }: { name: "back" | "up" | "down" | "close" }): JSX.Element {
  const path = { back: "M19 12H5m6-6-6 6 6 6", up: "M12 19V5m-6 6 6-6 6 6", down: "M12 5v14m-6-6 6 6 6-6", close: "M6 6l12 12M18 6L6 18" }[name];
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none"><path d={path} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// The recorder writes "Choose <option> in <menu>"; keep that description in step with an edited option.
function choiceUpdate(step: SetupStep, value: string): Partial<SetupStep> {
  const menu = step.target ?? "menu";
  const recorded = `Choose ${step.value || "option"} in ${menu}`;
  return step.description === recorded ? { value, description: `Choose ${value || "option"} in ${menu}` } : { value };
}
