import { useEffect, useRef } from "react";
import type { GoogleSignInPromptState } from "./googleSignIn";

/**
 * The offer to finish the Google sign-in setup after a demonstration, or the note left when the user skips it.
 * `disabled` holds the offer while the page is busy: a save would discard a running test.
 */
export function GoogleSignInPrompt({ prompt, disabled = false }: { prompt: GoogleSignInPromptState; disabled?: boolean }): JSX.Element | null {
  const noteRef = useRef<HTMLParagraphElement>(null);
  const wasOffered = useRef(prompt.state === "offer");
  // Skip and Cancel remove the buttons; keep keyboard focus on the note that replaces them.
  useEffect(() => {
    if (prompt.state === "skipped" && wasOffered.current) noteRef.current?.focus();
    wasOffered.current = prompt.state === "offer";
  }, [prompt.state]);

  if (prompt.state === "hidden") return null;
  if (prompt.state === "skipped") {
    return <p className="google-signin-skipped" ref={noteRef} tabIndex={-1} role="status"><GoogleSignInIcon />Test runs will stop at Google's verification until the Google sign-in is set up.</p>;
  }
  return <section className="google-signin-prompt" aria-labelledby="google-signin-prompt-title" aria-busy={prompt.busy}>
    <GoogleSignInIcon />
    <div>
      <h3 id="google-signin-prompt-title">Finish the Google sign-in setup</h3>
      <p>You signed in with Google during the demonstration. Google asks for a verification code every time the agent signs in, so the agent needs your Google password and an authenticator key. It takes about two minutes.</p>
      {prompt.error && <p className="google-signin-error" role="alert">{prompt.error}</p>}
      <div className="setup-actions">
        <button type="button" className="button button-primary" onClick={prompt.onSetUp} disabled={disabled || prompt.busy}>Set up Google sign-in</button>
        <button type="button" className="button button-quiet" onClick={prompt.onSkip} disabled={disabled || prompt.busy}>Skip for now</button>
      </div>
    </div>
  </section>;
}

/** A key: what the setup adds. Drawn in the stroke of the setup page's other note icons. */
function GoogleSignInIcon(): JSX.Element {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18"><circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M11 12l8-8m-3 3 2.5 2.5M14 9l2 2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
