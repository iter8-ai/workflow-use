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
    <button type="button" className="help-tip-button" aria-label={props.label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>?</button>
    <span id={id} role="note" className="help-tip-bubble" hidden={!open}>{props.children}</span>
  </span>;
}
