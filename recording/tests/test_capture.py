from __future__ import annotations

import asyncio
import json
import subprocess
from typing import Any
from urllib.parse import quote

import pytest

from workflow_use_recording.capture import (
    CAPTURE_SCRIPT,
    SIGN_IN_FILL_SCRIPT,
    console_event,
    fill_sign_in,
    install_sign_in_capture,
    install_sign_in_fill,
    page_event,
)


def _record_console_events(context: Any, events: list[Any]) -> None:
    """Collect the capture script's events the way the provider does: from the pages' console messages."""

    def on_console(message: Any) -> None:
        event = console_event(message)
        if event is not None:
            events.append(event)

    context.on("console", on_console)


@pytest.mark.asyncio
async def test_playwright_capture_records_visible_click_and_compacts_input() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        fixture = '<label>Invoice <input aria-label="Invoice number"></label><button>Save invoice</button>'
        await page.goto("data:text/html," + quote(fixture))
        await page.get_by_label("Invoice number").fill("generic-synthetic-secret")
        await page.get_by_role("button", name="Save invoice").click()
        await asyncio.sleep(0.05)
        await browser.close()

    assert any(event["type"] == "input" and event["target"] == "Invoice number" for event in events)
    assert any(event["type"] == "click" and event["target"] == "Save invoice" for event in events)
    inputs = [event for event in events if event["type"] == "input"]
    assert inputs[-1]["value"] == "generic-synthetic-secret"


@pytest.mark.asyncio
async def test_capture_records_typed_text_of_ordinary_fields() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []
    value = "generic-synthetic-secret"

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        await page.goto("data:text/html," + quote('<textarea aria-label="Notes"></textarea>'))
        await page.get_by_label("Notes").fill(value)
        await asyncio.sleep(0.05)
        await browser.close()

    inputs = [event for event in events if event.get("type") == "input"]
    assert inputs[-1]["value"] == value


@pytest.mark.asyncio
async def test_capture_never_uses_unlabeled_editable_text_as_a_target() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []
    value = "generic-synthetic-secret"

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        await page.goto("data:text/html," + quote("<div contenteditable></div>"))
        await page.locator("[contenteditable]").fill(value)
        await asyncio.sleep(0.05)
        await browser.close()

    inputs = [event for event in events if event.get("type") == "input"]
    assert inputs
    assert all(event["target"] == "div" for event in inputs)


@pytest.mark.asyncio
async def test_capture_never_sends_secret_values() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        await page.goto("data:text/html," + quote('<input aria-label="Password" type="password">'))
        await page.get_by_label("Password").fill("do-not-store-me")
        await asyncio.sleep(0.05)
        await browser.close()

    assert {"type": "credential", "value": "password", "target": "Password"}.items() <= next(
        event for event in events if event.get("type") == "credential"
    ).items()
    assert all("do-not-store-me" not in str({k: v for k, v in event.items() if k != "secret"}) for event in events)


@pytest.mark.asyncio
async def test_capture_blocks_plain_text_token_and_contenteditable_credentials() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []
    sign_ins: list[dict[str, str]] = []

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        await install_sign_in_capture(context, page, sign_ins.append)
        fixture = (
            '<input aria-label="API token"><div contenteditable aria-label="One-time code"></div>'
            '<div contenteditable aria-label="Login password"></div>'
            '<input type="password" name="otp" aria-label="Verification code">'
            '<form><label for="username">Username</label><input id="username"><input aria-label="Secret key">'
            '<input type="password" aria-label="Passcode">'
            '<input aria-label="Account" id="auth-username" autocomplete="username"><input aria-label="PIN">'
            '<input aria-label="Passphrase"><input autocomplete="current-password" class="revealed"></form>'
        )
        await page.goto("data:text/html," + quote(fixture))
        await page.get_by_label("API token").fill("token-that-must-not-persist")
        await page.get_by_label("One-time code").fill("code-that-must-not-persist")
        await page.get_by_label("Login password").fill("editable-password")
        await page.get_by_label("Verification code").fill("masked-code")
        await page.get_by_label("Username").fill("username-that-must-not-persist")
        await page.get_by_label("Secret key").fill("secret-that-must-not-persist")
        await page.get_by_label("Passcode").fill("passcode-that-must-not-persist")
        await page.get_by_label("Account").fill("account-that-must-not-persist")
        await page.get_by_label("PIN").fill("pin-that-must-not-persist")
        await page.get_by_label("Passphrase").fill("phrase-that-must-not-persist")
        await page.locator(".revealed").fill("revealed-that-must-not-persist")
        await asyncio.sleep(0.05)
        await browser.close()

    kinds = {event["target"]: event["value"] for event in events if event.get("type") == "credential"}
    # Page events never carry sign-in values; the isolated world hands over only real usernames and passwords.
    # Tokens, PINs, passphrases, secret keys and one-time or verification codes are never kept.
    assert all("secret" not in event for event in events)
    handed = {(event["value"], event["secret"]) for event in sign_ins}
    assert handed >= {
        ("password", "editable-password"),
        ("username", "username-that-must-not-persist"),
        ("username", "account-that-must-not-persist"),
        ("password", "revealed-that-must-not-persist"),
    }
    kept = {secret for _, secret in handed}
    for never in ("token", "code", "masked", "secret-that", "passcode", "pin-that", "phrase-that"):
        assert not any(value.startswith(never) for value in kept), never
    assert kinds == {
        "API token": "password",
        "One-time code": "otp",
        "Login password": "password",
        "Verification code": "otp",
        "Username": "username",
        "Secret key": "password",
        "Passcode": "password",
        "Account": "username",
        "PIN": "password",
        "Passphrase": "password",
        "input": "password",
    }
    assert all(event.get("type") != "input" for event in events)
    assert all("must-not-persist" not in str({k: v for k, v in event.items() if k != "secret"}) for event in events)


@pytest.mark.asyncio
async def test_capture_records_select_target_and_chosen_label() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context(viewport={"width": 400, "height": 200})
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        fixture = (
            '<select aria-label="Status"><option value="paid">Paid invoices</option></select>'
            '<div style="height:3000px"></div>'
        )
        await page.goto("data:text/html," + quote(fixture))
        await page.get_by_label("Status").select_option("paid")
        await page.evaluate("window.scrollTo(0, 300)")
        await asyncio.sleep(0.75)
        await page.evaluate("window.scrollTo(0, 0)")
        await asyncio.sleep(0.1)
        await browser.close()

    select_events = [event for event in events if event["type"] == "select_change"]
    assert select_events == [{"type": "select_change", "target": "Status", "value": "Paid invoices"}]
    assert [event["value"] for event in events if event["type"] == "scroll"] == ["down", "up"]


@pytest.mark.asyncio
async def test_capture_records_the_sign_in_button_but_no_field_values() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []
    sign_ins: list[dict[str, str]] = []

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        await install_sign_in_capture(context, page, sign_ins.append)
        fixture = (
            '<form onsubmit="return false"><input aria-label="Email"><input aria-label="Password" type="password">'
            '<label><input type="checkbox"> Remember me</label><button type="submit">Sign in</button></form>'
        )
        await page.goto("data:text/html," + quote(fixture))
        await page.get_by_label("Email").fill("user-that-must-not-persist")
        await page.get_by_label("Password").fill("password-that-must-not-persist")
        await page.get_by_label("Remember me").check()
        await page.get_by_role("button", name="Sign in").click()
        await asyncio.sleep(0.05)
        await browser.close()

    assert [(event.get("type"), event.get("value")) for event in events if event.get("type") != "click"] == [
        ("credential", "username"),
        ("credential", "password"),
    ]
    assert {"type": "click", "target": "Sign in"} in events
    assert all("must-not-persist" not in str(event) for event in events)
    assert sign_ins[-1] == {"type": "sign_in_value", "value": "password", "secret": "password-that-must-not-persist"}


@pytest.mark.asyncio
async def test_capture_records_each_multi_select_label_separately() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        fixture = (
            '<select aria-label="Status" multiple><option value="p">Paid, in full</option>'
            '<option value="o">Overdue</option><option value="d">Draft</option></select>'
        )
        await page.goto("data:text/html," + quote(fixture))
        await page.get_by_label("Status").select_option(["p", "o"])
        await asyncio.sleep(0.05)
        await browser.close()

    selects = [event for event in events if event["type"] == "select_change"]
    assert json.loads(selects[-1]["value"]) == ["Paid, in full", "Overdue"]


@pytest.mark.asyncio
async def test_page_scripts_cannot_read_or_forge_sign_in_values() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[Any] = []
    sign_ins: list[dict[str, str]] = []

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        await install_sign_in_capture(context, page, sign_ins.append)
        fixture = (
            "<script>"
            # A hostile page tampers with prototypes and String before the user types. (Replacing the page's
            # JSON.stringify would also break Playwright's own page plumbing; the isolated world has its own JSON.)
            "Object.defineProperty(HTMLInputElement.prototype, 'value', {get() { return 'tampered'; },"
            " set() {}, configurable: true});"
            "window.String = () => 'tampered';"
            "Object.defineProperty(Object.prototype, 'secret', {set() {}, get() { return 'tampered'; },"
            " configurable: true});"
            "window.__signInVisible = typeof window.workflowUseSignIn;"
            "</script>"
            '<form><input aria-label="Email"><input type="password" aria-label="Password">'
            '<input type="password" autocomplete="new-password" aria-label="New password"></form>'
        )
        await page.goto("data:text/html," + quote(fixture))
        await page.get_by_label("Password", exact=True).fill("typed-password")
        # A reset page's new password must not replace the one the account signs in with.
        await page.get_by_label("New password").fill("replacement-password")
        # A page dispatches its own input event: not user input, so nothing is kept.
        await page.evaluate(
            """() => document.querySelector('input[aria-label="Password"]')
              .dispatchEvent(new Event("input", { bubbles: true }))"""
        )
        # A hostile page writes forged events to the console the recorder listens on.
        await page.evaluate(
            """() => {
              const forge = (event) => console.debug("__workflowUse__", JSON.stringify(event));
              forge({ type: "sign_in_value", value: "password", secret: "forged" });
              forge({ type: "credential", value: "password", target: "Password", secret: "forged" });
            }"""
        )
        visible = await page.evaluate("() => [window.__signInVisible, typeof window.workflowUseSignIn]")
        await asyncio.sleep(0.1)
        await browser.close()

    assert visible == ["undefined", "undefined"]
    assert [event["secret"] for event in sign_ins] == ["typed-password"]
    assert all("forged" not in str(event) and "sign_in_value" not in str(event) for event in events)


def test_page_events_never_carry_browser_only_events() -> None:
    assert page_event({"type": "credential", "value": "password", "secret": "forged"}) == {
        "type": "credential",
        "value": "password",
    }
    assert page_event({"type": "sign_in_value", "value": "password", "secret": "forged"}) == {}
    assert page_event({"type": "page_loaded", "url": "https://example.com/login"}) == {}


@pytest.mark.asyncio
async def test_sign_in_capture_covers_a_document_that_is_already_open() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    sign_ins: list[dict[str, str]] = []

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        page = await context.new_page()
        # Like a sign-in popup: the document is loaded before capture is attached.
        await page.goto("data:text/html," + quote('<input type="password" aria-label="Password">'))
        await install_sign_in_capture(context, page, sign_ins.append)
        await page.get_by_label("Password").fill("popup-password")
        await asyncio.sleep(0.1)
        await browser.close()

    assert [event["secret"] for event in sign_ins] == ["popup-password"]


@pytest.mark.asyncio
async def test_clicks_in_a_sign_in_dialog_name_the_control_not_the_whole_dialog() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []

    # Shaped like a hosted sign-in page: everything sits inside one role="main" panel.
    fixture = (
        '<div role="main" style="padding:40px"><h1>Welcome</h1>'
        '<button type="button">Continue with Google</button><p id="or">or</p>'
        '<form onsubmit="return false"><label for="email">Email</label><input id="email" name="email" type="email">'
        '<label for="pw">Password</label><input id="pw" type="password"><button type="submit">Log in</button></form>'
        '<span role="link" tabindex="0">Use single sign-on</span>'
        '<a href="#reset">Reset password</a>'
        '<div class="card" style="cursor:pointer"><b>Invoices</b><small>Monthly statements</small></div></div>'
    )
    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        await page.goto("data:text/html," + quote(fixture))
        await page.locator('[role="main"]').click(position={"x": 5, "y": 5})
        await page.locator("#or").click()
        await page.get_by_text("Email", exact=True).click()
        await page.get_by_text("Password", exact=True).click()
        await page.get_by_role("button", name="Continue with Google").click()
        await page.get_by_text("Use single sign-on").click()
        await page.get_by_text("Monthly statements").click()
        await asyncio.sleep(0.05)
        await browser.close()

    clicks = [event["target"] for event in events if event["type"] == "click"]
    assert clicks == ["Continue with Google", "Use single sign-on", "Monthly statements"]


@pytest.mark.asyncio
async def test_clicks_on_web_components_labels_rows_and_double_clicks_are_named() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []

    fixture = (
        '<x-button></x-button><label for="notes">Notes</label><input id="notes" name="notes">'
        '<label><input type="checkbox"> Remember me</label>'
        '<div role="grid"><div role="row" id="row"><span>INV-1001</span><span>12.00</span></div></div>'
        "<button>Next page</button>"
        "<script>customElements.define('x-button', class extends HTMLElement { constructor() { super();"
        " this.attachShadow({ mode: 'open' }).innerHTML = '<button>Save changes</button>'; } });</script>"
    )
    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        _record_console_events(context, events)
        await context.add_init_script(CAPTURE_SCRIPT)
        page = await context.new_page()
        await page.goto("data:text/html," + quote(fixture))
        await page.get_by_role("button", name="Save changes").click()
        await page.get_by_text("Notes", exact=True).click()
        await page.get_by_text("Remember me").click()
        await page.get_by_text("INV-1001").click()
        await page.get_by_role("button", name="Next page").dblclick()
        await asyncio.sleep(0.05)
        await browser.close()

    clicks = [(event["target"], event.get("repeat", False)) for event in events if event["type"] == "click"]
    assert clicks == [
        ("Save changes", False),
        ("Notes", False),
        ("Remember me", False),
        ("INV-1001 12.00", False),
        ("Next page", False),
        ("Next page", True),
    ]


_SAVED_USERNAME = "saved-user@example.test"
_SAVED_PASSWORD = "saved-password-must-not-leak"
_SIGN_IN_PAGES = {
    "https://login.example.test/": (
        '<form action="/password"><input name="username" aria-label="Username">'
        '<input type="password" aria-label="Password"><button>Sign in</button></form>'
    ),
    # A two-step sign-in: the username page posts on to a separate password page.
    "https://login.example.test/step-one": (
        '<form action="/password"><input autocomplete="username" aria-label="Email"><button>Next</button></form>'
    ),
    "https://login.example.test/password": (
        '<form><input type="password" aria-label="Password"><input autocomplete="one-time-code" aria-label="Code">'
        "<button>Sign in</button></form>"
    ),
    "https://login.example.test/sign-up": (
        '<form><input name="username" aria-label="Username">'
        '<input type="password" autocomplete="new-password" aria-label="New password"></form>'
    ),
    "https://other.example.test/": (
        '<form><input name="username" aria-label="Username"><input type="password" aria-label="Password"></form>'
    ),
}


def _saved_login(*origins: str) -> Any:
    from workflow_use_recording.models import RecordingLogin

    return RecordingLogin(origins=list(origins), username=_SAVED_USERNAME, password=_SAVED_PASSWORD)


def test_saved_sign_in_guards_use_current_origin_despite_page_array_override() -> None:
    harness = r"""
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(0, "utf8");
let queries = 0;
let observe;
class HTMLInputElement {}
Object.defineProperty(HTMLInputElement.prototype, "value", { set() {} });
const sandbox = {
  location: { origin: "https://other.example.test" },
  window: {},
  document: { querySelectorAll() { queries++; return []; } },
  HTMLInputElement,
  MutationObserver: class { constructor(callback) { observe = callback; } observe() {} },
  setTimeout(callback) { callback(); },
};
const context = vm.createContext(sandbox);
vm.runInContext('var login = { origins: ["https://login.example.test"], password: "saved" }; ' +
  'Array.prototype.includes = () => true; (' + source + ')(login)', context);
assert.equal(queries, 0);
assert.equal(sandbox.window.__workflowUseSignInFillInstalled, undefined);
sandbox.location.origin = "https://login.example.test";
vm.runInContext('Array.prototype.includes = () => false; (' + source + ')(login)', context);
assert.equal(queries, 1);
assert.equal(typeof observe, "function");
sandbox.location.origin = "https://other.example.test";
vm.runInContext('Array.prototype.includes = () => true', context);
observe();
assert.equal(queries, 1);
"""
    subprocess.run(["node", "-e", harness], input=SIGN_IN_FILL_SCRIPT, text=True, check=True, capture_output=True)


def test_capture_events_reach_original_console_when_page_replaces_debug() -> None:
    harness = r"""
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const capture = fs.readFileSync(0, "utf8");
const listeners = {};
const original = [];
const intercepted = [];
const console = {
  debug(prefix, event) {
    assert.equal(this, console);
    original.push([prefix, event]);
  },
};
const context = vm.createContext({
  console,
  window: { scrollY: 0, addEventListener() {} },
  document: { addEventListener(type, listener) { listeners[type] = listener; } },
  Element: class {},
  HTMLInputElement: class {},
  HTMLTextAreaElement: class {},
  HTMLElement: class {},
});
vm.runInContext(capture, context);
console.debug = () => {};
listeners.keydown({ target: null, key: "Enter" });
console.debug = (...args) => intercepted.push(args);
listeners.keydown({ target: null, key: "Escape" });
assert.deepEqual(original, [
  ["__workflowUse__", '{"type":"key_press","target":"","value":"Enter"}'],
  ["__workflowUse__", '{"type":"key_press","target":"","value":"Escape"}'],
]);
assert.deepEqual(intercepted, []);
"""
    subprocess.run(["node", "-e", harness], input=CAPTURE_SCRIPT, text=True, check=True, capture_output=True)


def test_saved_sign_in_fills_only_identified_username_fields() -> None:
    harness = r"""
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { capture, fill } = JSON.parse(fs.readFileSync(0, "utf8"));
let observe;
const listeners = {};
const events = [];
class Element {
  getAttribute(name) { return name === "aria-label" ? this.label : name === "name" ? this.name : ""; }
  closest() { return this.form; }
  getClientRects() { return [1]; }
  matches() { return true; }
  dispatchEvent(event) { listeners[event.type]?.({ target: this }); }
}
class HTMLElement extends Element {}
class HTMLInputElement extends HTMLElement {
  constructor(label, name = "", type = "text", autocomplete = "", inForm = true) {
    super();
    this.label = label;
    this.name = name;
    this.type = type;
    this.autocomplete = autocomplete;
    this.id = "";
    this.tagName = "INPUT";
    this.labels = [];
    this.form = inForm ? form : null;
    this.value = "";
  }
  get value() { return this._value; }
  set value(value) { this._value = value; }
}
const form = {
  querySelector(selector) {
    return selector === 'input[type="password"]' ? fields.find((field) => field.type === "password") : null;
  },
};
const fields = [
  new HTMLInputElement("Company", "company"),
  new HTMLInputElement("Tenant", "tenant"),
  new HTMLInputElement("Email"),
  new HTMLInputElement("Contact", "", "email"),
  new HTMLInputElement("Account", "", "text", "username"),
  new HTMLInputElement("Login", "login"),
  new HTMLInputElement("Password", "", "password"),
  new HTMLInputElement("Contact address", "", "email", "", false),
  new HTMLInputElement("Email", "", "text", "", false),
  new HTMLInputElement("E-mail", "", "text", "", false),
];
const context = vm.createContext({
  window: {
    scrollY: 0,
    addEventListener() {},
  },
  console: { debug(prefix, event) { if (prefix === "__workflowUse__") events.push(JSON.parse(event)); } },
  location: { origin: "https://login.example.test", pathname: "/" },
  document: {
    addEventListener(type, listener) { listeners[type] = listener; },
    getElementById() { return null; },
    querySelectorAll() { return fields; },
  },
  Element, HTMLElement, HTMLInputElement,
  HTMLLabelElement: class extends HTMLElement {},
  HTMLTextAreaElement: class extends HTMLElement {},
  HTMLSelectElement: class extends HTMLElement {},
  MutationObserver: class { constructor(callback) { observe = callback; } observe() {} },
  Event: class { constructor(type) { this.type = type; } },
  getComputedStyle() { return { visibility: "visible", cursor: "pointer" }; },
  setTimeout(callback) { callback(); },
});
vm.runInContext(capture, context);
vm.runInContext('(' + fill + ')({origins: ["https://login.example.test"], ' +
  'username: "saved-user", password: "saved-password"})', context);
assert.deepEqual(fields.map((field) => field.value),
  ["", "", "saved-user", "saved-user", "saved-user", "saved-user", "saved-password",
    "saved-user", "saved-user", "saved-user"]);
assert.deepEqual(events.map((event) => [event.type, event.value]),
  Array(4).fill(["credential", "username"]).concat(
    [["credential", "password"]], Array(3).fill(["credential", "username"])));
const email = fields.at(-1);
listeners.click({ composedPath: () => [email], detail: 1 });
assert.equal(events.length, 8);
listeners.keydown({ target: email, key: "Enter" });
assert.deepEqual([events.at(-1).type, events.at(-1).value], ["key_press", "Enter"]);
fields.push(new HTMLInputElement("Company", "company"), new HTMLInputElement("Email", "", "text", "", false));
observe();
assert.deepEqual(fields.slice(-2).map((field) => field.value), ["", "saved-user"]);
assert.equal(events.at(-1).type, "credential");
assert.equal(events.at(-1).value, "username");
assert.equal(JSON.stringify(events).includes("saved-user"), false);
assert.equal(JSON.stringify(events).includes("saved-password"), false);
"""
    subprocess.run(
        ["node", "-e", harness],
        input=json.dumps({"capture": CAPTURE_SCRIPT, "fill": SIGN_IN_FILL_SCRIPT}),
        text=True,
        check=True,
        capture_output=True,
    )


@pytest.mark.asyncio
async def test_saved_sign_in_does_not_match_ascii_host_confusable_with_unicode_idn() -> None:
    class Frame:
        def __init__(self, url: str) -> None:
            self.url = url
            self.values: dict[str, Any] | None = None

        async def evaluate(self, _script: str, values: dict[str, Any]) -> None:
            self.values = values

    login = _saved_login("https://faß.example")
    ascii_frame = Frame("https://fass.example/login")
    idn_frame = Frame("https://xn--fa-hia.example/login")
    await fill_sign_in(ascii_frame, login)
    await fill_sign_in(idn_frame, login)

    assert ascii_frame.values is None
    assert idn_frame.values == {
        "origins": ["https://xn--fa-hia.example"],
        "username": _SAVED_USERNAME,
        "password": _SAVED_PASSWORD,
    }


@pytest.mark.asyncio
async def test_saved_sign_in_matches_unicode_dotted_frame_origin() -> None:
    class Frame:
        url = "https://xn--bcher-kva.example./login"

        def __init__(self) -> None:
            self.values: dict[str, Any] | None = None

        async def evaluate(self, _script: str, values: dict[str, Any]) -> None:
            self.values = values

    frame = Frame()
    await fill_sign_in(frame, _saved_login("https://bücher.example."))

    assert frame.values == {
        "origins": ["https://xn--bcher-kva.example."],
        "username": _SAVED_USERNAME,
        "password": _SAVED_PASSWORD,
    }


async def _sign_in_browser(runtime: Any, login: Any) -> tuple[Any, Any, list[Any], list[dict[str, str]]]:
    """A recording-like page: page capture, typed sign-in capture and the saved sign-in fill."""
    events: list[Any] = []
    sign_ins: list[dict[str, str]] = []
    tasks: set[asyncio.Task[None]] = set()

    def track(coroutine: Any) -> None:
        task = asyncio.ensure_future(coroutine)
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    async def serve(route: Any) -> None:
        url = route.request.url.split("?", 1)[0]
        await route.fulfill(content_type="text/html", body=_SIGN_IN_PAGES.get(url, "<p>Not found</p>"))

    browser = await runtime.chromium.launch()
    context = await browser.new_context()
    await context.route("**/*", serve)
    _record_console_events(context, events)
    await context.add_init_script(CAPTURE_SCRIPT)
    page = await context.new_page()
    await install_sign_in_capture(context, page, sign_ins.append)
    install_sign_in_fill(page, lambda: login, track)
    return browser, page, events, sign_ins


async def _field(page: Any, label: str) -> str:
    locator = page.get_by_label(label, exact=True)
    for _ in range(40):
        if await locator.input_value():
            break
        await asyncio.sleep(0.05)
    return await locator.input_value()


@pytest.mark.asyncio
async def test_a_saved_sign_in_is_filled_on_its_origin_and_never_captured() -> None:
    playwright = pytest.importorskip("playwright.async_api")

    async with playwright.async_playwright() as runtime:
        browser, page, events, sign_ins = await _sign_in_browser(runtime, _saved_login("https://LOGIN.example.test/"))
        await page.goto("https://login.example.test/")
        username, password = await _field(page, "Username"), await _field(page, "Password")
        await asyncio.sleep(0.1)
        await browser.close()

    assert (username, password) == (_SAVED_USERNAME, _SAVED_PASSWORD)
    # The fill dispatches input events, so the page sees it and the steps say a sign-in value was entered;
    # it is not the person typing, so no value reaches the sign-in capture or any page event.
    assert {event["value"] for event in events if event.get("type") == "credential"} == {"username", "password"}
    assert sign_ins == []
    assert all(_SAVED_PASSWORD not in str(event) and _SAVED_USERNAME not in str(event) for event in events)


@pytest.mark.asyncio
async def test_a_saved_sign_in_is_not_filled_on_another_origin() -> None:
    playwright = pytest.importorskip("playwright.async_api")

    async with playwright.async_playwright() as runtime:
        browser, page, _events, _sign_ins = await _sign_in_browser(runtime, _saved_login("https://login.example.test"))
        await page.goto("https://other.example.test/")
        await asyncio.sleep(0.3)
        values = await page.evaluate("() => Array.from(document.querySelectorAll('input'), (node) => node.value)")
        await browser.close()

    assert values == ["", ""]


@pytest.mark.asyncio
async def test_a_saved_sign_in_is_not_filled_after_frame_navigates_before_evaluation() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    login = _saved_login("https://login.example.test")

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        page = await browser.new_page()

        async def serve(route: Any) -> None:
            await route.fulfill(content_type="text/html", body=_SIGN_IN_PAGES[route.request.url])

        await page.route("**/*", serve)
        await page.goto("https://login.example.test/")

        class NavigatingFrame:
            @property
            def url(self) -> str:
                return page.main_frame.url

            async def evaluate(self, script: str, values: dict[str, Any]) -> Any:
                await page.goto("https://other.example.test/")
                return await page.main_frame.evaluate(script, values)

        await fill_sign_in(NavigatingFrame(), login)
        initial = await page.evaluate("() => Array.from(document.querySelectorAll('input'), (node) => node.value)")
        await page.evaluate(
            """() => document.querySelector('form').insertAdjacentHTML('beforeend',
              '<input name="username" aria-label="Late username"><input type="password" aria-label="Late password">')"""
        )
        await asyncio.sleep(0.1)
        late = await page.evaluate("() => Array.from(document.querySelectorAll('input'), (node) => node.value)")

        await page.goto("https://login.example.test/")
        await fill_sign_in(page.main_frame, login)
        allowed = await page.evaluate("() => Array.from(document.querySelectorAll('input'), (node) => node.value)")
        await browser.close()

    assert initial == ["", ""]
    assert late == ["", "", "", ""]
    assert allowed == [_SAVED_USERNAME, _SAVED_PASSWORD]


@pytest.mark.asyncio
async def test_a_two_step_sign_in_gets_each_step_filled() -> None:
    playwright = pytest.importorskip("playwright.async_api")

    async with playwright.async_playwright() as runtime:
        browser, page, _events, sign_ins = await _sign_in_browser(runtime, _saved_login("https://login.example.test"))
        await page.goto("https://login.example.test/step-one")
        username = await _field(page, "Email")
        await page.get_by_role("button", name="Next").click()
        await page.wait_for_url("https://login.example.test/password**")
        password = await _field(page, "Password")
        code = await page.get_by_label("Code").input_value()
        # A password field the page shows later, without a navigation, is filled as it appears.
        await page.evaluate(
            """() => document.querySelector("form").insertAdjacentHTML(
              "beforeend", '<input type="password" aria-label="Confirm password">')"""
        )
        late = await _field(page, "Confirm password")
        await browser.close()

    assert (username, password, late) == (_SAVED_USERNAME, _SAVED_PASSWORD, _SAVED_PASSWORD)
    assert code == ""
    assert sign_ins == []


@pytest.mark.asyncio
async def test_a_saved_sign_in_is_not_filled_into_a_sign_up_form_or_after_it_is_dropped() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    login: list[Any] = [_saved_login("https://login.example.test")]

    async with playwright.async_playwright() as runtime:
        browser, page, _events, _sign_ins = await _sign_in_browser(runtime, None)
        install_sign_in_fill(page, lambda: login[0], lambda coroutine: asyncio.ensure_future(coroutine))
        await page.goto("https://login.example.test/sign-up")
        await asyncio.sleep(0.3)
        sign_up = await page.evaluate("() => Array.from(document.querySelectorAll('input'), (node) => node.value)")
        # The recording ended: the session no longer holds the sign-in, so a new document gets nothing.
        login[0] = None
        await page.goto("https://login.example.test/")
        await asyncio.sleep(0.3)
        after = await page.evaluate("() => Array.from(document.querySelectorAll('input'), (node) => node.value)")
        await browser.close()

    assert sign_up == ["", ""]
    assert after == ["", ""]


def test_a_saved_sign_in_never_shows_its_values() -> None:
    login = _saved_login("https://login.example.test")

    assert _SAVED_PASSWORD not in repr(login) and _SAVED_USERNAME not in repr(login)
    assert _SAVED_PASSWORD not in str(login.model_dump()) and _SAVED_PASSWORD not in login.model_dump_json()
