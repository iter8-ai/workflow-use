import { useEffect, useRef, useState } from "react";
import type { HostBridge, Recording } from "./host";

// The host's dialog walks the user through adding an authenticator app, which takes a few minutes.
const setUpTimeoutMs = 10 * 60_000;

export type GoogleSignInPromptState = {
  state: "hidden" | "offer" | "skipped";
  busy: boolean;
  error: string | null;
  onSetUp(): void;
  onSkip(): void;
};

/**
 * Google asks for a verification code on every agent run, so a demonstration that signed in with Google is followed
 * by an offer to save the organisation's Google sign-in. Hosts without the Google sign-in dialog show nothing new.
 *
 * The check runs once each time `recording` becomes stopped, whether Stop or a poll observed it.
 */
export function useGoogleSignInPrompt(bridge: HostBridge | null | undefined, allowed: boolean, recording: Recording | null, page: {
  /** A save from the offer changed the Google sign-in, so an earlier test no longer counts. */
  onChanged(): void;
  /** The heading that takes focus when a save removes the offer. */
  heading(): HTMLElement | null | undefined;
}): {
  /** Hides the offer or skip note; call when a new demonstration starts or the current one is cancelled. */
  reset(): void;
  /** Opens the host's dialog; resolves whether the Google sign-in changed. */
  setUp(reason: "demonstration" | "test" | "edit"): Promise<boolean>;
  prompt: GoogleSignInPromptState;
} {
  const [state, setState] = useState<GoogleSignInPromptState["state"]>("hidden");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef<Pick<Recording, "id" | "status"> | null>(null);
  // Bumped by each check and reset, so an answer for an earlier demonstration can't bring its offer back.
  const checkRef = useRef(0);

  useEffect(() => {
    const previous = seenRef.current;
    seenRef.current = recording === null ? null : { id: recording.id, status: recording.status };
    if (recording?.status !== "stopped" || (previous?.id === recording.id && previous.status === "stopped")) return;
    const check = ++checkRef.current;
    setState("hidden"); setError(null);
    if (!allowed || !bridge || recording.google?.signedIn !== true) return;
    bridge.request("getGoogleSignIn", {}).then((result) => {
      if (check === checkRef.current && result.status !== "ready") setState("offer");
    }, () => {
      // Without the status the offer could be wrong; the Test result still explains a Google failure.
    });
  }, [allowed, bridge, recording]);

  const reset = (): void => {
    checkRef.current += 1;
    setState("hidden"); setError(null);
  };
  const open = async (reason: "demonstration" | "test" | "edit") => {
    if (!bridge) return null;
    const result = await bridge.request("setUpGoogleSignIn", { reason }, { timeoutMs: setUpTimeoutMs });
    // A status check still in flight was asked before this save, so its answer can't bring the offer back.
    if (result.status === "ready") checkRef.current += 1;
    // Cancel keeps the user moving: the offer becomes the skip note.
    setState((current) => result.status === "ready" ? "hidden" : current === "offer" ? "skipped" : current);
    return result;
  };
  const setUp = async (reason: "demonstration" | "test" | "edit"): Promise<boolean> => (await open(reason))?.changed === true;
  const onSetUp = (): void => {
    const check = checkRef.current;
    setBusy(true); setError(null);
    open("demonstration")
      .then((result) => {
        if (result?.changed === true) page.onChanged();
        // The offer is gone; keep keyboard focus on the page it was part of, unless a reset came during the save.
        if (result?.status === "ready" && checkRef.current === check + 1) {
          const heading = page.heading();
          if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
        }
      })
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "The Google sign-in couldn't be saved. Try again."))
      .finally(() => setBusy(false));
  };

  return { reset, setUp, prompt: { state, busy, error, onSetUp, onSkip: () => setState("skipped") } };
}
