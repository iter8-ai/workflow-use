"""Browser-side capture code. It sends semantic, bounded events to Python."""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING, Any

from .security import url_origin

if TYPE_CHECKING:
    from .models import RecordingLogin

logger = logging.getLogger(__name__)

_FIELD_CLASSIFICATION_SCRIPT = r"""
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
  const credentialKind = (node, autofill = false) => {
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
    if (/\b(?:username|email)\b/.test(input?.autocomplete || "") || /user.?name/.test(hint) ||
        input?.type === "email" || /\be-?mail\b/.test(hint)) return "username";
    if (oneTime) return "otp";
    if (otherSecretHint.test(hint)) return "password";
    const passwordInForm = !autofill && Boolean(node.closest("form")?.querySelector('input[type="password"]'));
    if (passwordInForm || /user.?name|login/.test(hint)) return "username";
    return null;
  };
""".lstrip("\n")


# First console argument of every recorded page event; the second is the event as one JSON object.
CONSOLE_PREFIX = "__workflowUse__"

CAPTURE_SCRIPT = r"""
(() => {
  if (window.__workflowUseRecordingInstalled) return;
  window.__workflowUseRecordingInstalled = true;

  __FIELD_CLASSIFICATION__
  // Controls a person clicks on purpose. Landmark and container roles (dialog, form, main, ...) are not here:
  // naming a click after one of them glues the whole panel's text into one unreadable label.
  const CLICKABLE = "button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=tab]," +
    "[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=checkbox],[role=radio]," +
    "[role=switch],[role=treeitem],[role=combobox],[role=row],[role=gridcell],[role=cell],[role=listitem]," +
    "[onclick],[tabindex]:not([tabindex='-1'])";
  // innerText keeps the visual line breaks that textContent drops ("Continue with Google" + "or" stays apart).
  // Inline siblings (table cells, spans) have no break between them, so their text is joined with spaces.
  const visibleLines = (node) => {
    const parts = node instanceof HTMLElement && node.children.length > 1 && !/\n/.test(node.innerText)
      ? Array.from(node.children).map((child) => child instanceof HTMLElement ? child.innerText : child.textContent)
      : String(node instanceof HTMLElement ? node.innerText : node.textContent || "").split(/\n+/);
    return parts.map((line) => semanticText(line)).filter(Boolean);
  };
  const visibleName = (node) => {
    const lines = visibleLines(node);
    const joined = lines.join(" ");
    return joined.length <= 80 ? joined : semanticText(lines[0] || "", 80);
  };
  // The clicked element and its ancestors, through shadow roots: a web component's button reaches the
  // document listener retargeted to its host element, but composedPath() still starts at the button.
  const clickPath = (event) => event.composedPath().filter((node) => node instanceof Element);
  // Single-page apps attach click handlers in JavaScript, so a clickable card or table cell often has no
  // role; its pointer cursor is the visible sign. The cursor is inherited, so this is usually the clicked node.
  const pointerTarget = (path) => path.slice(0, 6).find((node) => getComputedStyle(node).cursor === "pointer") || null;
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
  // Events travel in a console message, not a Playwright binding: a binding leaves
  // `__playwright__binding__` globals on the page, which Cloudflare's bot checks detect and block.
  const emit = (event) => console.debug(__CONSOLE_PREFIX__, JSON.stringify(event));
  document.addEventListener("click", (event) => {
    const path = clickPath(event);
    const control = path.find((node) => node.matches(CLICKABLE)) || null;
    // Clicking a label makes the browser click its field next; that second click is the step.
    if (control instanceof HTMLLabelElement && control.control && control.control !== path[0]) return;
    // Without a control, only something styled as clickable counts. Plain text and empty panel space do nothing.
    const node = control || pointerTarget(path);
    if (!node) return;
    // Focusing a sign-in field is implied by its credential step.
    if (credentialKind(node)) return;
    // event.detail counts clicks in quick succession on the same spot (a double click, or paging a calendar).
    const click = { type: "click", target: target(node) };
    emit(event.detail > 1 ? { ...click, repeat: true } : click);
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
""".replace("  __FIELD_CLASSIFICATION__\n", _FIELD_CLASSIFICATION_SCRIPT).replace(
    "__CONSOLE_PREFIX__", json.dumps(CONSOLE_PREFIX)
)


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
  __FIELD_CLASSIFICATION__
  document.addEventListener("input", (event) => {
    // A page can set a value and dispatch its own input event; only real user input counts.
    if (!event.isTrusted) return;
    // A Google account password is never kept: agents sign in with Google through a connected Google account.
    if (/^accounts\.(?:google\.(?:com|[a-z]{2}|[a-z]{2,}\.[a-z]{2})|youtube\.com)\.?$/i.test(location.hostname)) return;
    const node = event.target;
    const kind = credentialKind(node);
    if (!kind || !reusableSignIn(node, kind)) return;
    const editable = node instanceof HTMLElement && node.isContentEditable;
    const value = String((editable ? node.innerText : node.value) ?? "");
    send(JSON.stringify({ kind, value }));
  }, true);
})();
""".replace("  __FIELD_CLASSIFICATION__\n", _FIELD_CLASSIFICATION_SCRIPT).replace("__BINDING__", SIGN_IN_BINDING)


# Fills a saved username and password into the sign-in form of a page on a saved sign-in's origin, so the person
# demonstrating does not type them. Uses the capture's own field classification: only reusable sign-in fields
# are filled, never a new-password, one-time code or other secret field. The values are set the way a page
# script would, so the events are not trusted and the sign-in capture never reads them back. Each field is
# filled once while empty; a field the person clears stays cleared. DOM changes (a password step shown after
# the username step) are filled as they appear; a new document is filled again from Python.
SIGN_IN_FILL_SCRIPT = r"""
(login) => {
  const allowedOrigin = () => {
    for (let i = 0; i < login.origins.length; i++) {
      if (login.origins[i] === location.origin) return true;
    }
    return false;
  };
  if (!allowedOrigin() || window.__workflowUseSignInFillInstalled) return;
  Object.defineProperty(window, "__workflowUseSignInFillInstalled", { value: true });
  __FIELD_CLASSIFICATION__
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const filled = new WeakSet();
  const visible = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const fill = () => {
    if (!allowedOrigin()) return;
    for (const node of document.querySelectorAll("input")) {
      if (filled.has(node) || node.value || node.disabled || node.readOnly || !visible(node)) continue;
      // A sign-up or password-reset form asks for a new account, not the saved one.
      if (node.form?.querySelector('input[autocomplete~="new-password"]')) continue;
      const kind = credentialKind(node, true);
      if (!kind || !reusableSignIn(node, kind)) continue;
      const value = kind === "username" ? login.username : login.password;
      if (typeof value !== "string" || !value) continue;
      filled.add(node);
      setValue.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; fill(); }, 50);
  };
  fill();
  new MutationObserver(later).observe(document, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "type", "disabled"],
  });
}
""".replace("  __FIELD_CLASSIFICATION__\n", _FIELD_CLASSIFICATION_SCRIPT).strip()


async def fill_sign_in(frame: Any, login: RecordingLogin | None) -> None:
    """Fill ``login`` into ``frame`` when the frame's origin is one of the saved sign-in's origins."""
    if login is None or url_origin(getattr(frame, "url", "")) not in login.origins:
        return
    values = {
        "origins": login.origins,
        "username": login.username.get_secret_value() if login.username is not None else None,
        "password": login.password.get_secret_value(),
    }
    try:
        await frame.evaluate(SIGN_IN_FILL_SCRIPT, values)
    except Exception as error:
        # Usually the frame navigated on; its next document is filled when it commits. Only the type is logged.
        logger.debug("recording_sign_in_fill_skipped error_type=%s", type(error).__name__)


def install_sign_in_fill(
    page: Any, login: Callable[[], RecordingLogin | None], track: Callable[[Awaitable[None]], None]
) -> None:
    """Fill the saved sign-in into every matching document ``page`` shows, now and after each navigation.

    ``login`` is read at fill time, so a session that dropped its sign-in after the recording ended fills nothing.
    """
    page.on("framenavigated", lambda frame: track(fill_sign_in(frame, login())))
    for frame in page.frames:
        track(fill_sign_in(frame, login()))


def console_event(message: Any) -> dict[str, Any] | None:
    """Turn a page's console message into a recorder event, or ``None`` for any other console output.

    Page scripts can write such messages too, so nothing arriving this way may carry a sign-in value.
    """
    try:
        if message.type != "debug" or len(message.args) != 2:
            return None
        text = message.text
    except Exception:
        return None
    prefix = f"{CONSOLE_PREFIX} "
    if not isinstance(text, str) or not text.startswith(prefix):
        return None
    try:
        event = json.loads(text[len(prefix) :])
    except ValueError:
        return None
    if not isinstance(event, dict):
        return None
    filtered = page_event(event)
    return filtered if isinstance(filtered, dict) else None


def page_event(event: object) -> object:
    """Browser-only events never arrive from page JavaScript."""
    if isinstance(event, dict):
        event = {key: value for key, value in event.items() if key != "secret"}
        if event.get("type") in {"sign_in_value", "download", "page_loaded"}:
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
