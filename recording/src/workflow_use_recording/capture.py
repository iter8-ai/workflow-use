"""Browser-side capture code. It sends semantic, bounded events to Python."""

CAPTURE_SCRIPT = r"""
(() => {
  if (window.__workflowUseRecordingInstalled) return;
  window.__workflowUseRecordingInstalled = true;

  const semanticText = (value, size = 240) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, size);
  const exactText = (value, size = 240) => String(value ?? "").slice(0, size);
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
  const secretInput = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const input = node instanceof HTMLInputElement ? node : null;
    const hint = (`${input?.type || ""} ${input?.autocomplete || ""} ${input?.name || ""} ${node.id} ` +
      `${labelText(node)} ${node.getAttribute("placeholder") || ""}`).toLowerCase();
    const passwordInForm = Boolean(node.closest("form")?.querySelector('input[type="password"]'));
    return input?.type === "password" || passwordInForm ||
      /api.?key|auth|credential|jwt|login|one.?time|otp|passcode|secret|token|user.?name|verification.?code/.test(hint);
  };
  const target = (node) => {
    if (!(node instanceof Element)) return "";
    return semanticText(
      labelText(node) || node.getAttribute("title") ||
      node.getAttribute("name") || node.textContent || node.tagName.toLowerCase()
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
    if (secretInput(node)) {
      emit({ secret: true });
      return;
    }
    emit({ type: "click", target: target(node) });
  }, true);
  document.addEventListener("input", (event) => {
    const node = event.target;
    const editable = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ||
      (node instanceof HTMLElement && node.isContentEditable);
    if (!editable) return;
    if (secretInput(node)) {
      emit({ secret: true });
      return;
    }
    const value = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
      ? node.value : node.textContent;
    emit({ type: "input", target: target(node), targetKey: targetKey(node), value: exactText(value, 2000) });
  }, true);
  document.addEventListener("change", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLSelectElement)) return;
    const option = node.selectedOptions[0];
    emit({ type: "select_change", target: target(node), value: semanticText(option?.textContent || "", 1000) });
  }, true);
  document.addEventListener("keydown", (event) => {
    const node = event.target;
    if (secretInput(node)) {
      emit({ secret: true });
      return;
    }
    if (["Enter", "Escape", "Tab", "ArrowDown", "ArrowUp"].includes(event.key)) {
      emit({ type: "key_press", target: target(node), value: event.key });
    }
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
