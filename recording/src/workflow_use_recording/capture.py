"""Browser-side capture code. It sends semantic, bounded events to Python."""

import json
from collections.abc import Callable
from typing import Any

CAPTURE_SCRIPT = r"""
(() => {
  if (window.__workflowUseRecordingInstalled) return;
  window.__workflowUseRecordingInstalled = true;

  const semanticText = (value, size = 240) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, size);
  const labelText = (node) => {
    if (!(node instanceof Element)) return "";
    const labelled = (node.getAttribute("aria-labelledby") || "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "").join(" ");
    const hasLabels = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement;
    const associated = hasLabels
      ? Array.from(node.labels || []).map((label) => label.textContent || "").join(" ") : "";
    return semanticText(node.getAttribute("aria-label") || labelled || associated);
  };
  // Sign-in fields become credential steps: the kind is recorded, never the value.
  // Buttons and checkboxes are clicked, not typed into (e.g. "Sign in", "Remember me").
  const typedField = (node) => (node instanceof HTMLInputElement &&
      !["button", "submit", "reset", "checkbox", "radio", "image", "file", "hidden"].includes(node.type)) ||
    node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && node.isContentEditable);
  const otherSecretHint =
    /api.?key|\bauth\b|credential|jwt|secret|token|\bpin\b|passphrase|security.?answer|cvv|cvc|card.?number/;
  // Only a real sign-in username or password is handed to the host to reuse. Tokens, PINs, card
  // numbers and the like are still recorded as secret fields, but their values are never kept.
  const reusableSignIn = (node, kind) => {
    if (kind === "username") return true;
    if (kind !== "password") return false;
    const input = node instanceof HTMLInputElement ? node : null;
    const hint = (`${input?.name || ""} ${node.id} ${labelText(node)} ` +
      `${node.getAttribute("placeholder") || ""}`).toLowerCase();
    // A new-password field (sign-up, reset) is not the password the account signs in with today.
    if (/new-password/.test(input?.autocomplete || "")) return false;
    const passwordField = input?.type === "password" || /current-password/.test(input?.autocomplete || "");
    const oneTime = /one.?time|otp|passcode|verification.?code|2fa|mfa|authenticator/.test(hint);
    return !otherSecretHint.test(hint) && !oneTime && (passwordField || /pass.?word/.test(hint));
  };
  const credentialKind = (node) => {
    if (!typedField(node)) return null;
    const input = node instanceof HTMLInputElement ? node : null;
    const hint = (`${input?.type || ""} ${input?.autocomplete || ""} ${input?.name || ""} ${node.id} ` +
      `${labelText(node)} ${node.getAttribute("placeholder") || ""}`).toLowerCase();
    // Most specific signal first: the input type, then explicit autocomplete and username hints.
    const oneTime = /one.?time|otp|passcode|verification.?code|2fa|mfa|authenticator/.test(hint);
    if (input?.type === "password" || /(?:current|new)-password/.test(input?.autocomplete || "")) {
      // A masked verification field is still a one-time code, not the account password.
      const verification = /one.?time|\botp\b|verification.?code|2fa|mfa|authenticator/.test(hint);
      return /one-time-code/.test(input?.autocomplete || "") || verification ? "otp" : "password";
    }
    // A "show password" toggle turns the field into type=text; its hints still say password.
    if (/pass.?word/.test(hint)) return "password";
    if (/\b(?:username|email)\b/.test(input?.autocomplete || "") || /user.?name/.test(hint)) return "username";
    if (oneTime) return "otp";
    if (otherSecretHint.test(hint)) return "password";
    const passwordInForm = Boolean(node.closest("form")?.querySelector('input[type="password"]'));
    if (passwordInForm || /user.?name|login/.test(hint)) return "username";
    return null;
  };
  // Controls a person clicks on purpose. Landmark and container roles (dialog, form, main, ...) are not here:
  // naming a click after one of them glues the whole panel's text into one unreadable label.
  const CLICKABLE = "button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=tab]," +
    "[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=checkbox],[role=radio]," +
    "[role=switch],[role=treeitem],[role=combobox],[onclick]";
  // innerText keeps the visual line breaks that textContent drops ("Continue with Google" + "or" stays apart).
  const visibleLines = (node) => String(node instanceof HTMLElement ? node.innerText : node.textContent || "")
    .split(/\n+/).map((line) => semanticText(line)).filter(Boolean);
  const visibleName = (node) => {
    const lines = visibleLines(node);
    const joined = lines.join(" ");
    return joined.length <= 80 ? joined : semanticText(lines[0] || "", 80);
  };
  // Single-page apps attach click handlers in JavaScript, so a clickable card or table cell often has no
  // role; its pointer cursor is the visible sign. The cursor is inherited, so this is usually the clicked node.
  const pointerTarget = (node) => {
    let current = node;
    for (let depth = 0; current instanceof Element && depth < 6; depth += 1) {
      if (getComputedStyle(current).cursor === "pointer") return current;
      current = current.parentElement;
    }
    return null;
  };
  const target = (node) => {
    if (!(node instanceof Element)) return "";
    const valueBearing = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement || (node instanceof HTMLElement && node.isContentEditable);
    const fallback = valueBearing ? node.tagName.toLowerCase()
      : visibleName(node) || node.querySelector("img[alt]")?.getAttribute("alt") || node.tagName.toLowerCase();
    return semanticText(
      labelText(node) || node.getAttribute("title") ||
      node.getAttribute("name") || fallback
    );
  };
  const targetKey = (node) => {
    if (!(node instanceof Element)) return "";
    if (node.id) return `${location.origin}${location.pathname}|#${node.id}`;
    if (node.getAttribute("name")) return `${location.origin}${location.pathname}|name:${node.getAttribute("name")}`;
    const peers = Array.from(document.querySelectorAll(node.tagName));
    return `${location.origin}${location.pathname}|${node.tagName}:${peers.indexOf(node)}`;
  };
  const emit = (event) => {
    if (typeof window.workflowUseRecord !== "function") return;
    void window.workflowUseRecord(event).catch(() => undefined);
  };
  document.addEventListener("click", (event) => {
    const clicked = event.target instanceof Element ? event.target : null;
    const control = clicked?.closest(CLICKABLE) || null;
    // A label stands for its field: clicking "Email" focuses the email box.
    const field = control instanceof HTMLLabelElement && control.control ? control.control : control;
    // Without a control, only something styled as clickable counts. Plain text and empty panel space do nothing.
    const node = field || pointerTarget(clicked);
    if (!node) return;
    // Focusing a sign-in field is implied by its credential step.
    if (credentialKind(node)) return;
    emit({ type: "click", target: target(node) });
  }, true);
  document.addEventListener("input", (event) => {
    const node = event.target;
    if (!typedField(node)) return;
    const kind = credentialKind(node);
    const editable = node instanceof HTMLElement && node.isContentEditable;
    const typedText = () => String((editable ? node.innerText : node.value) ?? "");
    if (kind) {
      // The step records only the kind. The typed value is read separately in an isolated world.
      emit({ type: "credential", value: kind, target: target(node), targetKey: targetKey(node) });
      return;
    }
    // Ordinary fields keep what was typed so the agent can repeat it; sign-in fields never do.
    // Kept verbatim (whitespace and line breaks matter); oversized text is flagged, not cut.
    const typed = typedText();
    emit(typed.length > 2000
      ? { type: "input", target: target(node), targetKey: targetKey(node), tooLong: true }
      : { type: "input", target: target(node), targetKey: targetKey(node), value: typed });
  }, true);
  document.addEventListener("change", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLSelectElement)) return;
    // A multi-select keeps each label as its own JSON array item so commas inside labels stay unambiguous.
    const labels = Array.from(node.selectedOptions).map((option) => semanticText(option.label || option.text, 240));
    const value = node.multiple ? JSON.stringify(labels) : labels[0] || "";
    emit({ type: "select_change", target: target(node), value });
  }, true);
  document.addEventListener("keydown", (event) => {
    const node = event.target;
    if (!["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    // Submitting a sign-in field keeps the key but not the field's label.
    emit(credentialKind(node)
      ? { type: "key_press", value: event.key }
      : { type: "key_press", target: target(node), value: event.key });
  }, true);
  let lastScroll = 0;
  let lastScrollY = window.scrollY;
  window.addEventListener("scroll", () => {
    const now = Date.now();
    if (now - lastScroll < 700) return;
    const currentScrollY = window.scrollY;
    if (currentScrollY === lastScrollY) return;
    lastScroll = now;
    const direction = currentScrollY > lastScrollY ? "down" : "up";
    lastScrollY = currentScrollY;
    emit({ type: "scroll", value: direction });
  }, true);
})();
"""


SIGN_IN_WORLD = "workflow-use-sign-in"
SIGN_IN_BINDING = "workflowUseSignIn"

# Runs in an isolated world: its own JavaScript globals and prototypes, invisible to and untouchable by page
# scripts, and the only context where the sign-in binding exists. It reads what the user typed into a real
# username or password field and nothing else.
SIGN_IN_SCRIPT = r"""
(() => {
  const send = globalThis.__BINDING__;
  if (typeof send !== "function" || globalThis.__workflowUseSignInInstalled) return;
  globalThis.__workflowUseSignInInstalled = true;
  const semanticText = (value, size = 240) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, size);
  const labelText = (node) => {
    if (!(node instanceof Element)) return "";
    const labelled = (node.getAttribute("aria-labelledby") || "").split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "").join(" ");
    const hasLabels = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement;
    const associated = hasLabels
      ? Array.from(node.labels || []).map((label) => label.textContent || "").join(" ") : "";
    return semanticText(node.getAttribute("aria-label") || labelled || associated);
  };
  // Sign-in fields become credential steps: the kind is recorded, never the value.
  // Buttons and checkboxes are clicked, not typed into (e.g. "Sign in", "Remember me").
  const typedField = (node) => (node instanceof HTMLInputElement &&
      !["button", "submit", "reset", "checkbox", "radio", "image", "file", "hidden"].includes(node.type)) ||
    node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && node.isContentEditable);
  const otherSecretHint =
    /api.?key|\bauth\b|credential|jwt|secret|token|\bpin\b|passphrase|security.?answer|cvv|cvc|card.?number/;
  // Only a real sign-in username or password is handed to the host to reuse. Tokens, PINs, card
  // numbers and the like are still recorded as secret fields, but their values are never kept.
  const reusableSignIn = (node, kind) => {
    if (kind === "username") return true;
    if (kind !== "password") return false;
    const input = node instanceof HTMLInputElement ? node : null;
    const hint = (`${input?.name || ""} ${node.id} ${labelText(node)} ` +
      `${node.getAttribute("placeholder") || ""}`).toLowerCase();
    // A new-password field (sign-up, reset) is not the password the account signs in with today.
    if (/new-password/.test(input?.autocomplete || "")) return false;
    const passwordField = input?.type === "password" || /current-password/.test(input?.autocomplete || "");
    const oneTime = /one.?time|otp|passcode|verification.?code|2fa|mfa|authenticator/.test(hint);
    return !otherSecretHint.test(hint) && !oneTime && (passwordField || /pass.?word/.test(hint));
  };
  const credentialKind = (node) => {
    if (!typedField(node)) return null;
    const input = node instanceof HTMLInputElement ? node : null;
    const hint = (`${input?.type || ""} ${input?.autocomplete || ""} ${input?.name || ""} ${node.id} ` +
      `${labelText(node)} ${node.getAttribute("placeholder") || ""}`).toLowerCase();
    // Most specific signal first: the input type, then explicit autocomplete and username hints.
    const oneTime = /one.?time|otp|passcode|verification.?code|2fa|mfa|authenticator/.test(hint);
    if (input?.type === "password" || /(?:current|new)-password/.test(input?.autocomplete || "")) {
      // A masked verification field is still a one-time code, not the account password.
      const verification = /one.?time|\botp\b|verification.?code|2fa|mfa|authenticator/.test(hint);
      return /one-time-code/.test(input?.autocomplete || "") || verification ? "otp" : "password";
    }
    // A "show password" toggle turns the field into type=text; its hints still say password.
    if (/pass.?word/.test(hint)) return "password";
    if (/\b(?:username|email)\b/.test(input?.autocomplete || "") || /user.?name/.test(hint)) return "username";
    if (oneTime) return "otp";
    if (otherSecretHint.test(hint)) return "password";
    const passwordInForm = Boolean(node.closest("form")?.querySelector('input[type="password"]'));
    if (passwordInForm || /user.?name|login/.test(hint)) return "username";
    return null;
  };
  document.addEventListener("input", (event) => {
    // A page can set a value and dispatch its own input event; only real user input counts.
    if (!event.isTrusted) return;
    const node = event.target;
    const kind = credentialKind(node);
    if (!kind || !reusableSignIn(node, kind)) return;
    const editable = node instanceof HTMLElement && node.isContentEditable;
    const value = String((editable ? node.innerText : node.value) ?? "");
    send(JSON.stringify({ kind, value }));
  }, true);
})();
""".replace("__BINDING__", SIGN_IN_BINDING)


def page_event(event: object) -> object:
    """Events from page JavaScript never carry sign-in values or downloads; those come only from the browser."""
    if isinstance(event, dict):
        event = {key: value for key, value in event.items() if key != "secret"}
        if event.get("type") in {"sign_in_value", "download"}:
            return {}
    return event


def sign_in_event(payload: str) -> dict[str, str] | None:
    """Turn an isolated-world binding payload into a recorder event."""
    try:
        data = json.loads(payload)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    kind, value = data.get("kind"), data.get("value")
    if kind not in {"username", "password"} or not isinstance(value, str):
        return None
    return {"type": "sign_in_value", "value": kind, "secret": value}


async def install_sign_in_capture(context: Any, page: Any, on_event: Callable[[dict[str, str]], Any]) -> None:
    """Capture typed sign-in values for ``page`` in an isolated world, before its next document loads."""
    cdp = await context.new_cdp_session(page)

    def on_binding(params: dict[str, Any]) -> None:
        if params.get("name") != SIGN_IN_BINDING:
            return
        event = sign_in_event(str(params.get("payload", "")))
        if event is not None:
            on_event(event)

    cdp.on("Runtime.bindingCalled", on_binding)
    await cdp.send("Runtime.enable")
    await cdp.send("Runtime.addBinding", {"name": SIGN_IN_BINDING, "executionContextName": SIGN_IN_WORLD})
    await cdp.send("Page.enable")
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {"source": SIGN_IN_SCRIPT, "worldName": SIGN_IN_WORLD})
    # A popup may already show its first document (e.g. a sign-in window); cover it too. The script
    # guards against a second install, and the binding reaches worlds created from now on by name.
    frame_tree = await cdp.send("Page.getFrameTree")
    world = await cdp.send(
        "Page.createIsolatedWorld", {"frameId": frame_tree["frameTree"]["frame"]["id"], "worldName": SIGN_IN_WORLD}
    )
    await cdp.send("Runtime.evaluate", {"expression": SIGN_IN_SCRIPT, "contextId": world["executionContextId"]})
