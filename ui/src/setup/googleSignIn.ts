import { useState } from "react";
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
 */
export function useGoogleSignInPrompt(bridge: HostBridge | null | undefined, allowed: boolean): {
  /** Decides whether to offer the setup after a demonstration stops. Never throws: the offer is guidance only. */
  afterDemonstration(recording: Recording): Promise<void>;
  /** Opens the host's dialog; resolves whether the Google sign-in changed. */
  setUp(reason: "demonstration" | "test" | "edit"): Promise<boolean>;
  prompt: GoogleSignInPromptState;
} {
  const [state, setState] = useState<GoogleSignInPromptState["state"]>("hidden");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const afterDemonstration = async (recording: Recording): Promise<void> => {
    setState("hidden"); setError(null);
    if (!allowed || !bridge || recording.google?.signedIn !== true) return;
    try {
      if ((await bridge.request("getGoogleSignIn", {})).status !== "ready") setState("offer");
    } catch {
      // Without the status the offer could be wrong; the Test result still explains a Google failure.
    }
  };
  const setUp = async (reason: "demonstration" | "test" | "edit"): Promise<boolean> => {
    if (!bridge) return false;
    const result = await bridge.request("setUpGoogleSignIn", { reason }, { timeoutMs: setUpTimeoutMs });
    // Cancel keeps the user moving: the offer becomes the skip note.
    setState((current) => result.status === "ready" ? "hidden" : current === "offer" ? "skipped" : current);
    return result.changed;
  };
  const onSetUp = (): void => {
    setBusy(true); setError(null);
    setUp("demonstration")
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "The Google sign-in couldn't be saved. Try again."))
      .finally(() => setBusy(false));
  };

  return { afterDemonstration, setUp, prompt: { state, busy, error, onSetUp, onSkip: () => setState("skipped") } };
}
