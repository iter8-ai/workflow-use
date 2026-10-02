import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { actionLabels, outcomeLabels, type AgentThought, type ReasoningNote } from "./agentThought";

type Tone = "good" | "bad" | "thinking" | "neutral";
type BarView = { tone: Tone; label: string; summary: ReactNode; details: ReactNode[] };

/**
 * Bottom bar under a finished test's screenshot: what the agent noted, plus screen paging.
 * The agent's own "completed" is only shown as a pass when the host also passed the test.
 */
export function AgentScreenBar(props: { thought: AgentThought; testPassed: boolean; index: number; count: number; onSelect(index: number): void }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const summary = summaryRef.current;
    if (summary === null) return;
    const measure = () => setTruncated(summary.scrollWidth > summary.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(summary);
    return () => observer.disconnect();
  }, [props.thought, expanded]);
  const view = barView(props.thought, props.testPassed);
  const canExpand = expanded || truncated || view.details.length > 0;
  return <div className={`test-caption${expanded ? " expanded" : ""}`}>
    <span className={`caption-kind ${view.tone}`}>{view.label}</span>
    <div className="caption-body" aria-live="polite">
      <p ref={summaryRef} className="caption-summary">{view.summary}</p>
      {expanded && view.details.map((detail, index) => <p className="caption-detail" key={index}>{detail}</p>)}
    </div>
    {canExpand && <button type="button" className="text-button caption-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Less" : "More"}</button>}
    <div className="caption-pager" role="group" aria-label="Screens">
      <button type="button" className="icon-button" aria-label="Previous screen" onClick={() => props.onSelect(props.index - 1)} disabled={props.index <= 0}><Chevron direction="left" /></button>
      <span>{props.index + 1} / {props.count}</span>
      <button type="button" className="icon-button" aria-label="Next screen" onClick={() => props.onSelect(props.index + 1)} disabled={props.index >= props.count - 1}><Chevron direction="right" /></button>
    </div>
  </div>;
}

function barView(thought: AgentThought, testPassed: boolean): BarView {
  switch (thought.kind) {
    case "outcome": {
      const { status, reason, confirmation } = thought.outcome;
      return {
        tone: status === "blocked" || status === "failed" ? "bad" : status === "completed" && testPassed ? "good" : "neutral",
        label: outcomeLabels[status],
        summary: reason || "The agent gave no reason.",
        details: [...(confirmation === null ? [] : [<>Saw “{confirmation}”</>]), ...thought.reasoning.map(note)],
      };
    }
    case "reasoning": {
      const [first, ...rest] = thought.reasoning;
      return { tone: "thinking", label: "Thinking", summary: first ? note(first) : null, details: rest.map(note) };
    }
    case "actions":
      return {
        tone: "neutral",
        label: thought.actions.length === 1 ? "Action" : "Actions",
        summary: thought.actions.map((action) => actionLabels[action]).join(" · "),
        details: thought.safetyChecks === null ? [] : [`Safety checks: ${thought.safetyChecks}`],
      };
    case "replay":
      return { tone: "neutral", label: "Replay", summary: "Repeated a step recorded in the demonstration.", details: [] };
    case "text":
      return { tone: "neutral", label: "Agent", summary: thought.text, details: [] };
    case "empty":
      return { tone: "neutral", label: "Agent", summary: <span className="caption-muted">No note for this screen.</span>, details: [] };
    default: {
      const unhandled: never = thought;
      return unhandled;
    }
  }
}

function note(item: ReasoningNote): ReactNode {
  return <>{item.title && <strong>{item.title}</strong>}{item.title && item.body && " "}{item.body}</>;
}

function Chevron(props: { direction: "left" | "right" }): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d={props.direction === "left" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
