from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import quote

import pytest

from workflow_use_recording.capture import CAPTURE_SCRIPT, install_sign_in_capture, page_event


@pytest.mark.asyncio
async def test_playwright_capture_records_visible_click_and_compacts_input() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        await context.expose_binding("workflowUseRecord", lambda _, event: record(event))
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

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        await context.expose_binding("workflowUseRecord", lambda _, event: record(event))
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

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        await context.expose_binding("workflowUseRecord", lambda _, event: record(event))
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

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        await context.expose_binding("workflowUseRecord", lambda _, event: record(event))
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

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        await context.expose_binding("workflowUseRecord", lambda _, event: record(event))
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

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context(viewport={"width": 400, "height": 200})
        await context.expose_binding("workflowUseRecord", lambda _, event: record(event))
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

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        await context.expose_binding("workflowUseRecord", lambda _, event: record(event))
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

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

    async with playwright.async_playwright() as runtime:
        browser = await runtime.chromium.launch()
        context = await browser.new_context()
        await context.expose_binding("workflowUseRecord", lambda _, event: record(event))
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
        await context.expose_binding("workflowUseRecord", lambda _, event: events.append(page_event(event)))
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
        # A hostile page calls the page binding directly with forged values.
        await page.evaluate(
            """() => Promise.all([
              window.workflowUseRecord({ type: "sign_in_value", value: "password", secret: "forged" }),
              window.workflowUseRecord({ type: "credential", value: "password", target: "Password", secret: "forged" }),
            ])"""
        )
        visible = await page.evaluate("() => [window.__signInVisible, typeof window.workflowUseSignIn]")
        await asyncio.sleep(0.1)
        await browser.close()

    assert visible == ["undefined", "undefined"]
    assert [event["secret"] for event in sign_ins] == ["typed-password"]
    assert all("forged" not in str(event) and "sign_in_value" not in str(event) for event in events)


def test_page_events_never_carry_sign_in_values() -> None:
    assert page_event({"type": "credential", "value": "password", "secret": "forged"}) == {
        "type": "credential",
        "value": "password",
    }
    assert page_event({"type": "sign_in_value", "value": "password", "secret": "forged"}) == {}


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

    async def record(event: dict[str, Any]) -> None:
        events.append(event)

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
        await context.expose_binding("workflowUseRecord", lambda _, event: record(event))
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
