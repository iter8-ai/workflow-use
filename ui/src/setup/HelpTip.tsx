import { useEffect, useId, useRef, useState } from "react";

/** A (?) button that shows a short explanation under the stage heading. */
export function HelpTip(props: { label: string; children: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeOnEscape); };
  }, [open]);
  return <span className="help-tip" ref={rootRef}>
    <button type="button" className="help-tip-button" aria-label={props.label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><svg aria-hidden="true" viewBox="0 0 20 20" width="20" height="20"><circle cx="10" cy="10" r="8.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M7.9 7.7a2.2 2.2 0 0 1 4.25.8c0 1.45-2.15 1.9-2.15 3.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><circle cx="10" cy="14.3" r="1" fill="currentColor" /></svg></button>
    <span id={id} role="note" className="help-tip-bubble" hidden={!open}>{props.children}</span>
  </span>;
}
