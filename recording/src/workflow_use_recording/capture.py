"""Browser-side capture code. It sends semantic, bounded events to Python."""

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
  const credentialKind = (node) => {
    if (!(node instanceof HTMLElement)) return null;
    const input = node instanceof HTMLInputElement ? node : null;
    // Buttons and checkboxes in a sign-in form are ordinary steps (e.g. "Sign in").
    const notTyped = ["button", "submit", "reset", "checkbox", "radio", "image", "file", "hidden"];
    const editable = (input && !notTyped.includes(input.type)) ||
      node instanceof HTMLTextAreaElement || node.isContentEditable;
    if (!editable) return null;
    const hint = (`${input?.type || ""} ${input?.autocomplete || ""} ${input?.name || ""} ${node.id} ` +
      `${labelText(node)} ${node.getAttribute("placeholder") || ""}`).toLowerCase();
    if (/one.?time|otp|passcode|verification.?code|2fa|mfa|authenticator/.test(hint)) return "otp";
    if (input?.type === "password") return "password";
    const passwordInForm = Boolean(node.closest("form")?.querySelector('input[type="password"]'));
    if (passwordInForm || /user.?name|login/.test(hint)) return "username";
    if (/api.?key|\bauth\b|credential|jwt|secret|token/.test(hint)) return "password";
    return null;
  };
  const target = (node) => {
    if (!(node instanceof Element)) return "";
    const valueBearing = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ||
      node instanceof HTMLSelectElement || (node instanceof HTMLElement && node.isContentEditable);
    const fallback = valueBearing ? node.tagName.toLowerCase() : node.textContent || node.tagName.toLowerCase();
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
    const node = event.target instanceof Element
      ? event.target.closest("button,a,input,select,textarea,[role]") || event.target : null;
    // Focusing a sign-in field is implied by its credential step.
    if (credentialKind(node)) return;
    emit({ type: "click", target: target(node) });
  }, true);
  document.addEventListener("input", (event) => {
    const node = event.target;
    const editable = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ||
      (node instanceof HTMLElement && node.isContentEditable);
    if (!editable) return;
    const kind = credentialKind(node);
    if (kind) {
      emit({ type: "credential", value: kind, target: target(node), targetKey: targetKey(node) });
      return;
    }
    emit({ type: "input", target: target(node), targetKey: targetKey(node) });
  }, true);
  document.addEventListener("change", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLSelectElement)) return;
    emit({ type: "select_change", target: target(node) });
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
