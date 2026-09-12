from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

import pytest

from workflow_use_recording.capture import CAPTURE_SCRIPT


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
        await page.get_by_label("Invoice number").fill("42")
        await page.get_by_role("button", name="Save invoice").click()
        await asyncio.sleep(0.05)
        await browser.close()

    assert any(event["type"] == "input" and event["target"] == "Invoice number" for event in events)
    assert any(event["type"] == "click" and event["target"] == "Save invoice" for event in events)


@pytest.mark.asyncio
async def test_capture_preserves_exact_input_whitespace() -> None:
    playwright = pytest.importorskip("playwright.async_api")
    events: list[dict[str, Any]] = []
    value = "  first line\n    second line  "

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

    assert any(event.get("type") == "input" and event.get("value") == value for event in events)


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

    assert any(event.get("secret") is True for event in events)
    assert all("do-not-store-me" not in str(event) for event in events)


@pytest.mark.asyncio
async def test_capture_blocks_plain_text_token_and_contenteditable_credentials() -> None:
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
            '<input aria-label="API token"><div contenteditable aria-label="One-time code"></div>'
            '<form><label for="username">Username</label><input id="username"><input type="password"></form>'
        )
        await page.goto("data:text/html," + quote(fixture))
        await page.get_by_label("API token").fill("token-that-must-not-persist")
        await page.get_by_label("One-time code").fill("code-that-must-not-persist")
        await page.get_by_label("Username").fill("username-that-must-not-persist")
        await asyncio.sleep(0.05)
        await browser.close()

    secrets = [event for event in events if event.get("secret") is True]
    assert len(secrets) == 3
    assert all(event == {"secret": True} for event in secrets)
    assert all("must-not-persist" not in str(event) for event in events)


@pytest.mark.asyncio
async def test_capture_records_selected_visible_text_and_scroll_direction() -> None:
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

    assert {event.get("value") for event in events if event["type"] == "select_change"} == {"Paid invoices"}
    assert [event["value"] for event in events if event["type"] == "scroll"] == ["down", "up"]
