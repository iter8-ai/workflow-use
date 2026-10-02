import { readFileSync } from "node:fs";
import { expect, test, type FrameLocator } from "@playwright/test";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/^https:\/\/(?:[^/]+\.)?browserbase\.com\//, (route) => route.fulfill({ contentType: "text/html", body: "<p>Recorded browser</p>" }));
  await page.route(/\/host\?scenario=/, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: hostPage(baseUrl),
    });
  });
});

test("takes a user through demonstration, review, testing, and host scheduling", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await expect(setup.getByRole("heading", { name: "Set up your agent" })).toBeVisible();
  await expect(setup.getByText("Reiterate saves the username and password you type there, encrypted", { exact: false })).toBeVisible();
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await expect(setup.getByText("Changes require a new test.")).toHaveCount(0);
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();

  await expect(setup.getByText("Open the reports section")).toBeVisible();
  await page.clock.runFor(2_100);
  await expect(setup.getByRole("button", { name: "Finish demonstration" })).toBeVisible();
  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();

  await setup.getByRole("button", { name: "Continue to test" }).click();

  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__testArguments)).toEqual([{}]);
  await expect(setup.getByRole("link", { name: "statement.pdf" })).toHaveAttribute("href", "https://files.example.test/statement.pdf");
  await expect(setup.getByLabel("I checked the result")).toHaveCount(0);
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__chooseScheduleCalls)).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.__savedSchedule)).toEqual("30 9 * * *");
  await expect.poll(() => page.evaluate(() => window.__scheduleArguments)).toEqual([{}]);
  await expect.poll(() => page.evaluate(() => window.__savedAgents)).toEqual([
    expect.objectContaining({ draft: expect.objectContaining({ inputs: [] }) }),
  ]);
  await setup.getByRole("button", { name: "Open agent" }).click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{ agentId: "agent-1" }]);
});

test("nginx response policies allow finished-run PNG evidence", async ({ page }) => {
  const policies = [...readFileSync(new URL("../nginx.conf", import.meta.url), "utf8").matchAll(/add_header Content-Security-Policy "([^"]+)" always;/g)].map((match) => match[1]);
  expect(policies).toHaveLength(5);
  for (const policy of policies) {
    await page.route(`${baseUrl}/policy`, (route) => route.fulfill({
      contentType: "text/html", headers: { "Content-Security-Policy": policy },
      body: '<img alt="Agent browser screen" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S8sAAAAASUVORK5CYII=">',
    }));
    await page.goto(`${baseUrl}/policy`);
    await expect.poll(() => page.getByAltText("Agent browser screen").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    expect(policy).toContain("script-src 'self'; style-src 'self'; frame-src https://browserbase.com https://*.browserbase.com;");
    await page.unroute(`${baseUrl}/policy`);
  }
});

test("locks draft mutations after a lost schedule reply until the identical retry succeeds", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${baseUrl}/host?scenario=lost-schedule-reply`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect.poll(() => page.evaluate(() => window.__scheduleRequests)).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.__savedSchedule)).toBe("30 9 * * *");
  await page.clock.fastForward(45_001);
  await expect(setup.getByRole("alert")).toContainText("The request timed out.");
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Run test again" })).toBeDisabled();
  await expect(setup.getByRole("button", { name: "Back to review" })).toBeDisabled();
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await expect(setup.getByRole("button", { name: "A file is downloaded in the browser" })).toBeDisabled();
  await expect(setup.getByLabel("Success criterion")).toBeDisabled();
  await expect(setup.getByRole("button", { name: "Close setup" })).toBeEnabled();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toBeVisible();
  expect(await page.evaluate(() => window.__chooseScheduleCalls)).toHaveLength(1);
  expect(await page.evaluate(() => window.__testArguments)).toHaveLength(1);
  expect(await page.evaluate(() => window.__scheduleRequests)).toEqual([
    { agentId: "agent-1", runId: "run-1", arguments: {}, cron: "30 9 * * *" },
    { agentId: "agent-1", runId: "run-1", arguments: {}, cron: "30 9 * * *" },
  ]);
  expect(await page.evaluate(() => window.__scheduleArguments)).toEqual([{}]);
});

test("locks the legacy inline schedule after a lost reply and retries the same cron", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${baseUrl}/host?scenario=legacy-lost-schedule-reply`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await setup.getByLabel("Schedule daily").check();
  await setup.getByRole("button", { name: "Schedule agent" }).click();
  await expect.poll(() => page.evaluate(() => window.__scheduleRequests)).toHaveLength(1);
  await page.clock.fastForward(45_001);
  await expect(setup.getByRole("alert")).toContainText("The request timed out.");
  await expect(setup.getByRole("button", { name: "Back to test" })).toBeDisabled();
  await expect(setup.getByLabel("Schedule daily")).toBeDisabled();
  await expect(setup.getByLabel("Time of day")).toBeDisabled();
  await setup.getByRole("button", { name: "Schedule agent" }).click();
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toBeVisible();
  const requests = await page.evaluate(() => window.__scheduleRequests);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(await page.evaluate(() => window.__scheduleArguments)).toEqual([{}]);
});

test("retains passing evidence when a rerun save is rejected by the host", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=rerun-save-rejection`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Run test again" }).click();
  await expect(setup.getByRole("alert")).toContainText("This agent is scheduled. Edit it in agent settings.");
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeEnabled();
  expect(await page.evaluate(() => window.__testArguments)).toHaveLength(1);
});

test("invalidates changed criteria but retains a pass for identical choices and custom blur", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await expect(setup.getByText("Suggested from your steps and from what the agent saw at the end of this test.", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "A file is downloaded in the browser" }).click();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeVisible();
  await setup.getByLabel("Success criterion").fill("Export sent");
  await setup.getByLabel("Success criterion").press("Tab");
  await expect(setup.getByText("Test passed", { exact: true })).toHaveCount(0);
  await expect(setup.locator(".done-when.done")).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await setup.getByLabel("Success criterion").focus();
  await setup.getByLabel("Success criterion").press("Tab");
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeVisible();
  await setup.getByLabel("Success criterion").fill("Export delivered");
  await setup.getByLabel("Success criterion").press("Tab");
  await expect(setup.getByText("Test passed", { exact: true })).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
});

test("reselects retained custom text after switching to the file criterion", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await setup.getByLabel("Success criterion").fill("Export sent");
  await setup.getByLabel("Success criterion").press("Tab");
  await setup.getByRole("button", { name: "A file is downloaded in the browser" }).click();
  await expect(setup.getByLabel("Success criterion")).toHaveValue("Export sent");
  await setup.getByRole("button", { name: "Describe what success looks like" }).click();
  await expect(setup.locator(".done-when > div").first()).toHaveText("The agent confirms: Export sent");
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect.poll(() => page.evaluate(() => window.__savedAgents[0]?.draft.doneWhen)).toEqual({ kind: "described", value: "Export sent" });
});

test("reselects retained custom text on unchanged blur after switching to file", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await setup.getByLabel("Success criterion").fill("Export sent");
  await setup.getByLabel("Success criterion").press("Tab");
  await expect(setup.locator(".done-when > div").first()).toHaveText("The agent confirms: Export sent");
  await setup.getByRole("button", { name: "A file is downloaded in the browser" }).click();
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await expect(setup.getByLabel("Success criterion")).toHaveValue("Export sent");
  await setup.getByLabel("Success criterion").focus();
  await setup.getByLabel("Success criterion").press("Tab");
  await expect(setup.locator(".done-when > div").first()).toHaveText("The agent confirms: Export sent");
  await expect(setup.getByText("Test passed", { exact: true })).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  expect(await page.evaluate(() => window.__testArguments)).toHaveLength(1);
  expect(await page.evaluate(() => window.__savedAgents[0].draft.doneWhen)).toEqual({ kind: "file" });
});

test("preserves stopped-step evidence for the pinned host's unknown failure", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=unknown-failure`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("alert")).toContainText("The test stopped, but its cause is unknown. Try again.");
  await expect(setup.getByText("2 of 3 reached", { exact: true })).toBeVisible();
  await expect(setup.locator(".test-step.done")).toHaveCount(1);
  await expect(setup.locator(".test-step.failed")).toHaveCount(1);
  await expect(setup.locator(".test-step.notrun")).toHaveCount(1);
  await expect(setup.getByText("Stopped here", { exact: false })).toBeVisible();
  await expect(setup.getByLabel("Step 2 instruction")).toBeInViewport();
  await setup.getByLabel("Step 2 instruction").fill("Find the export option");
  await expect(setup.getByLabel("Step 2 instruction")).toBeFocused();
  await expect(setup.getByText("None of your steps were tried", { exact: false })).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
});

test("offers done-when choices before the first test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await expect(setup.getByRole("button", { name: "A file is downloaded in the browser" })).toBeVisible();
  await expect(setup.getByText("Suggested from your steps.", { exact: true })).toBeVisible();
});

test("finishes a manual setup through the host without scheduling", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=manual-schedule`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__chooseScheduleCalls)).toHaveLength(1);
  expect(await page.evaluate(() => window.__savedSchedule)).toBeUndefined();
  await setup.getByRole("button", { name: "Open agent" }).click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{ agentId: "agent-1" }]);
});

test("stays on the passed test when host schedule selection is cancelled", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=cancel-schedule`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toHaveCount(0);
  expect(await page.evaluate(() => window.__savedSchedule)).toBeUndefined();
});

test("waits for a slow host schedule choice without timing out", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${baseUrl}/host?scenario=slow-schedule`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect.poll(() => page.evaluate(() => window.__chooseScheduleCalls)).toHaveLength(1);
  await page.clock.fastForward(60_000);
  await expect(setup.getByRole("alert")).toHaveCount(0);
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toHaveCount(0);
  expect(await page.evaluate(() => window.__savedSchedule)).toBeUndefined();
  await page.clock.fastForward(30_000);
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__savedSchedule)).toBe("30 9 * * *");
});

test("retries a rejected schedule save with the selected schedule", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=schedule-save-failure`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByRole("alert")).toContainText("Schedule save failed.");
  expect(await page.evaluate(() => window.__savedSchedule)).toBeUndefined();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toBeVisible();
  expect(await page.evaluate(() => window.__chooseScheduleCalls)).toHaveLength(1);
  expect(await page.evaluate(() => window.__scheduleRequests)).toHaveLength(2);
});

test("chooses a new schedule after a new test replaces a rejected save's run", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=schedule-save-failure`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByRole("alert")).toContainText("Schedule save failed.");
  await setup.getByRole("button", { name: "Run test again" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toBeVisible();
  expect(await page.evaluate(() => window.__chooseScheduleCalls)).toHaveLength(2);
  expect(await page.evaluate(() => window.__scheduleRequests.at(-1))).toEqual({
    agentId: "agent-1", runId: "run-2", arguments: {}, cron: "30 9 * * *",
  });
});

test("confirms before closing work that has not been saved", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await setup.getByLabel("Agent name").fill("Draft report agent");
  await setup.getByRole("button", { name: "Close setup" }).click();
  await expect(setup.getByRole("heading", { name: "Leave setup?" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([]);
  await setup.getByRole("button", { name: "Keep editing" }).click();
  await expect(setup.getByLabel("Agent name")).toHaveValue("Draft report agent");
  await setup.getByRole("button", { name: "Close setup" }).click();
  await setup.getByRole("dialog").getByRole("button", { name: "Close setup" }).click();

  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{}]);
});

test("starts another demonstration after a stopped recording", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Agent name").fill("Reports");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Get the report.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  await setup.getByRole("button", { name: "Start over" }).click();
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await expect(setup.getByRole("heading", { name: "Demonstrate the task" })).toBeVisible();
  await expect(setup.getByRole("alert")).toHaveCount(0);
});

test("gives the demonstration the full width and scrolls long step lists", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/host?scenario=many-steps`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Agent name").fill("Reports");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Get the report.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await setup.getByRole("button", { name: "Finish demonstration" }).click();

  const browser = setup.getByTitle("Virtual browser");
  await expect(browser).toHaveAttribute("allow", "clipboard-read; clipboard-write");
  const grid = await setup.locator(".demonstration-grid").boundingBox();
  expect(grid?.width ?? 0).toBeGreaterThan(1440 - 60);
  const browserBox = await browser.boundingBox();
  expect(browserBox?.width ?? 0).toBeGreaterThan(1000);
  expect(browserBox?.height ?? 0).toBeGreaterThan(560);

  const list = setup.getByLabel("Recorded steps list");
  const sizes = await list.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  await list.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect(setup.getByText("Recorded action 60")).toBeInViewport();
  await expect(setup.getByRole("button", { name: "Continue to review" })).toBeInViewport();
  await page.screenshot({ path: "e2e-artifacts/demonstrate-many-steps.png" });
});

test("shows the running test's browser without letting the user interact with it", async ({ page }) => {
  await page.route("https://www.browserbase.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<button>Portal</button>" }));
  await page.goto(`${baseUrl}/host?scenario=watch`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();

  await expect(setup.getByText("Test is running", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Running…" })).toBeDisabled();
  const browser = setup.locator('iframe[title="Test browser (view only)"]');
  await expect(browser).toHaveAttribute("src", "https://www.browserbase.com/devtools-fullscreen/inspector.html");
  await expect(browser).toHaveAttribute("inert", "");
  await expect(browser).toHaveAttribute("tabindex", "-1");
  const topmost = await browser.evaluate((frame) => {
    const box = frame.getBoundingClientRect();
    return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.className;
  });
  expect(topmost).toBe("watch-only-shield");
});

test("a service failure after steps ran does not claim no steps were tried", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=service-failure-midrun`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();

  await expect(setup.getByText("Reiterate couldn’t run the test")).toBeVisible();
  await expect(setup.getByRole("alert")).toContainText("stopped responding at step 2");
  await expect(setup.getByRole("alert")).toContainText("Your steps do not need changing");
  await expect(setup.getByText("None of your steps were tried", { exact: false })).toHaveCount(0);
  await expect(setup.locator(".test-step.failed")).toHaveCount(0);
});

test("explains a service failure without blaming or marking a step", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=service-failure`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();

  await expect(setup.getByText("Reiterate couldn’t run the test")).toBeVisible();
  await expect(setup.getByRole("alert")).toContainText("None of your steps were tried");
  await expect(setup.locator(".test-step.failed")).toHaveCount(0);
  await page.screenshot({ path: "e2e-artifacts/test-service-failure.png" });
  await expect(setup.getByRole("button", { name: "Run test again" })).toBeEnabled();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
});

test("shows a legacy host's failed-run error and keeps scheduling unavailable", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=failed`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("alert")).toContainText("The website rejected the request.");
  await expect(setup.getByRole("alert")).toContainText("Test failed");
  await expect(setup.getByRole("button", { name: "Run test again" })).toBeEnabled();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
});

test("shows the failed step and keeps a multi-character inline edit focused", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=step-failure`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Stuck at step 2")).toBeVisible();
  await expect(setup.getByRole("alert")).toContainText("The button was missing.");
  await expect(setup.locator(".test-step.done")).toHaveCount(1);
  await expect(setup.locator(".test-step.failed")).toHaveCount(1);
  await expectNoSideStripes(setup);
  await page.screenshot({ path: "e2e-artifacts/test-step-failure.png" });
  const instruction = setup.getByLabel("Step 2 instruction");
  await instruction.fill("");
  await instruction.pressSequentially("Find the export option in Reports");
  await expect(instruction).toHaveValue("Find the export option in Reports");
  await expect(instruction).toBeFocused();
  await expect(setup.getByText("Changes require a new test.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await expect(setup.getByAltText("Agent browser screen")).toBeVisible();
  await expect(setup.getByText("I looked for the export button.")).toBeVisible();
  await setup.getByRole("button", { name: "Previous screen" }).click();
  await expect(setup.getByText("I opened Reports.")).toBeVisible();
  await setup.getByRole("button", { name: "Next screen" }).click();
  await expect(setup.getByText("I looked for the export button.")).toBeVisible();
  await setup.getByRole("button", { name: "Run test again" }).click();
  await expect.poll(() => page.evaluate(() => window.__savedAgents.length)).toBe(2);
  const saved = await page.evaluate(() => window.__savedAgents.at(-1));
  expect(saved.draft.steps[1].target).toBeNull();
  expect(saved.config.stages[0].prompt).toContain("2. Complete this action: Find the export option in Reports.");
  expect(saved.config.stages[0].prompt).not.toContain("Click Export");
});

test("replaces a failed select choice with the inline instruction on rerun", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=select-failure`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Stuck at step 2")).toBeVisible();
  await setup.getByLabel("Step 2 instruction").fill("Choose CSV in Format");
  await setup.getByRole("button", { name: "Run test again" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(saved).toHaveLength(2);
  expect(saved.at(-1).draft.steps[1]).toMatchObject({
    type: "agent", description: "Choose CSV in Format", target: null, value: null, url: null,
  });
  expect(saved.at(-1).config.stages[0].prompt).toContain("2. Follow this demonstrated intent: Choose CSV in Format.");
  expect(saved.at(-1).config.stages[0].prompt).not.toContain('choose exactly "PDF"');
});

test("preserves the saved username when rewriting a failed sign-in instruction", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=signin-failure`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("alert")).toContainText("The username field was missing.");
  await expect(setup.locator(".test-step.failed").getByLabel("Step 2 instruction")).toBeVisible();
  await setup.getByLabel("Step 2 instruction").fill("Enter the saved username in the User ID field");
  await setup.getByRole("button", { name: "Run test again" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(saved).toHaveLength(2);
  expect(saved.at(-1).draft.steps[1]).toMatchObject({
    type: "credential", value: "username", target: null,
    description: "Enter the saved username in the User ID field",
  });
  expect(saved.at(-1).config.stages[0].prompt).toContain("$username");
  expect(saved.at(-1).config.stages[0].prompt).toContain("Enter the saved username in the User ID field");
  expect(saved.at(-1).config.stages[0].prompt).not.toContain("into Email");
});

test("accepts a rejected export sender, reruns, and shows the routed file", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=email-flow`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Every step ran, but no file was downloaded")).toBeVisible();
  await setup.getByRole("button", { name: /Send the export to Reiterate instead/ }).click();
  await expect.poll(() => page.evaluate(() => window.__createdRoutes)).toHaveLength(1);
  await expect.poll(() => page.evaluate(() => window.__testArguments)).toHaveLength(2);
  await expect(setup.getByRole("button", { name: "Accept emails from portal@example.test" })).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/test-email-rejected.png" });
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await setup.getByRole("button", { name: "Accept emails from portal@example.test" }).click();
  await expect.poll(() => page.evaluate(() => window.__allowedSenders)).toEqual([{ channelId: "route-1", sender: "portal@example.test" }]);
  await expect.poll(() => page.evaluate(() => window.__testArguments)).toHaveLength(3);
  await expect(setup.getByRole("link", { name: "statement.pdf" })).toHaveAttribute("href", "https://files.example.test/statement.pdf");
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeVisible();
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(saved.at(-1).draft.doneWhen).toEqual({ kind: "email", address: "reports+agent@reiterate.com", channelId: "route-1" });
  expect(saved.at(-1).draft.steps[1].value).toBe("reports+agent@reiterate.com");
  expect(saved.at(-1).config.stages.map((stage: { type: string }) => stage.type)).toEqual(["agent"]);
  await page.screenshot({ path: "e2e-artifacts/test-email-passed.png" });
});

test("rewrites recipient checks with the Reiterate route on the same step", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=email-recipient-check`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await setup.getByRole("button", { name: /Send the export to Reiterate instead/ }).click();
  await expect.poll(() => page.evaluate(() => window.__savedAgents.length)).toBe(2);
  const saved = await page.evaluate(() => window.__savedAgents.at(-1));
  expect(saved.draft.steps[0].expectedOutcome).toBe("Support contact me@example.test is visible");
  expect(saved.draft.steps[1]).toMatchObject({
    value: "reports+agent@reiterate.com",
    expectedOutcome: "The recipient is reports+agent@reiterate.com; confirm reports+agent@reiterate.com appears in the field",
  });
  expect(saved.config.stages[0].prompt).toContain("check that: The recipient is reports+agent@reiterate.com; confirm reports+agent@reiterate.com appears in the field");
});

test("does not offer or apply email routing when multiple email inputs exist", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=email-ambiguous`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await expect(setup.getByRole("button", { name: /Send the export to Reiterate instead/ })).toHaveCount(0);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Every step ran, but no file was downloaded")).toBeVisible();
  await expect(setup.getByRole("button", { name: /Send the export to Reiterate instead/ })).toHaveCount(0);
  expect(await page.evaluate(() => window.__createdRoutes)).toEqual([]);
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(saved.at(-1).draft.steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "billing", value: "billing@example.test" }),
    expect.objectContaining({ id: "recipient", value: "recipient@example.test" }),
  ]));
});

test("waits for email and blocks scheduling when the email has no files", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=email-no-documents`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await setup.getByRole("button", { name: /Send the export to Reiterate instead/ }).click();
  await expect(setup.getByRole("alert")).toContainText("arrived without a file");
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
});

test("passes a described criterion with the agent's on-screen evidence", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=described-success`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByText("Change", { exact: true }).click();
  const criterion = setup.getByLabel("Success criterion");
  await expect(criterion).toHaveAttribute("rows", "2");
  await expect(criterion).toHaveAttribute("maxlength", "300");
  await expect(criterion).toHaveAttribute("placeholder", "For example: a message says the export was emailed to me");
  await criterion.fill("A message says the export was emailed to me");
  await criterion.press("Tab");
  await expect(setup.locator(".done-when > div").first()).toHaveText("The agent confirms: A message says the export was emailed to me");
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await expect(setup.getByText("Agent saw: The green toast says Export sent", { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(saved.at(-1).draft.doneWhen).toEqual({ kind: "described", value: "A message says the export was emailed to me" });
  expect(saved.at(-1).config.stages.map((stage: { type: string }) => stage.type)).toEqual(["agent"]);
  await setup.getByText("Change", { exact: true }).click();
  await expect(setup.getByRole("button", { name: /appears on the page/ })).toHaveCount(0);
  await expect(setup.getByRole("button", { name: /The green toast says Export sent.*checked by the agent/ })).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/free-text/described-success.png" });
});

test("presents an unmet described criterion as a check without blaming a step", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=described-failure`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByText("Change", { exact: true }).click();
  await setup.getByLabel("Success criterion").fill("The export was emailed to me");
  await setup.getByLabel("Success criterion").press("Tab");
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The success criterion wasn’t met", { exact: true })).toBeVisible();
  await expect(setup.getByRole("alert")).toContainText("the page still shows Export pending");
  await expect(setup.locator(".test-step.failed")).toHaveCount(0);
  await expect(setup.getByText(/Rewrite/i)).toHaveCount(0);
  await expect(setup.locator(".done-options")).toHaveAttribute("open", "");
  await expect(setup.locator(".done-when.failed")).toHaveCount(1);
  await expectNoSideStripes(setup);
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await page.screenshot({ path: "e2e-artifacts/free-text/described-failure.png" });
});

test("keeps custom done-when editable after validation fails and requires a fresh test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=text-result`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Every step ran, but no file was downloaded")).toBeVisible();
  const customText = setup.getByLabel("Success criterion");
  await customText.fill("Password: secret123");
  await customText.press("Tab");
  await setup.getByRole("button", { name: /^Run test(?: again)?$/ }).click();
  await expect(setup.getByRole("alert").filter({ hasText: "Remove sign-in details" })).toBeVisible();
  await expect(customText).toBeVisible();
  await expect(customText).toHaveValue("Password: secret123");
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  expect(await page.evaluate(() => window.__testArguments)).toHaveLength(1);
  expect(await page.evaluate(() => window.__savedAgents)).toHaveLength(1);

  await setup.getByRole("button", { name: "Back to review" }).click();
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(setup.getByRole("heading", { name: "Verify agent can follow the process" })).toBeVisible();
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await expect(customText).toHaveValue("Password: secret123");
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("alert").filter({ hasText: "Remove sign-in details" })).toBeVisible();
  expect(await page.evaluate(() => window.__savedAgents)).toHaveLength(1);

  await customText.fill("Export sent");
  await customText.press("Tab");
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await setup.getByRole("button", { name: /^Run test(?: again)?$/ }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeVisible();
  expect(await page.evaluate(() => window.__testArguments)).toHaveLength(2);
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(saved).toHaveLength(2);
  expect(saved.at(-1).draft.doneWhen).toEqual({ kind: "described", value: "Export sent" });
});

test("legacy host hides new done-when options and uses its inline schedule", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=legacy`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("button", { name: /Send the export to Reiterate instead/ })).toHaveCount(0);
  await expect(setup.getByLabel("Success criterion")).toHaveCount(1);
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByRole("heading", { name: "Schedule" })).toBeVisible();
  await setup.getByLabel("Schedule daily").check();
  await setup.getByLabel("Time of day").fill("09:30");
  await setup.getByRole("button", { name: "Schedule agent" }).click();
  await expect.poll(() => page.evaluate(() => window.__savedSchedule)).toEqual("30 9 * * *");
  await expect.poll(() => page.evaluate(() => window.__chooseScheduleCalls)).toEqual([]);
});

test("invalidates a completed test when reviewed instructions change", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByRole("button", { name: "Back to review" }).click();
  await setup.getByLabel("Step 1 description").fill("Open the updated reports section");
  await setup.getByRole("button", { name: "Continue to test" }).click();

  await expect(setup.getByText("Changes require a new test.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
});


test("email arrival cutoff includes an export sent before test startup returns", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=email-cutoff`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await setup.getByRole("button", { name: /Send the export to Reiterate instead/ }).click();
  await expect(setup.getByRole("link", { name: "statement.pdf" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeVisible();
});

test("stops waiting for the export after three minutes and permits a retry", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=email-waiting`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await page.clock.install();
  await setup.getByRole("button", { name: /Send the export to Reiterate instead/ }).click();
  await expect(setup.getByText("Waiting for the export email", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await page.clock.fastForward(180_000);
  await expect(setup.getByRole("alert")).toContainText("didn’t arrive");
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Run test again" })).toBeEnabled();
});

test("hides text completion when the host supports email but not the updated scheduling contract", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=no-text`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByText("Change", { exact: true }).click();
  await expect(setup.getByLabel("Success criterion")).toHaveCount(1);
  await expect(setup.getByRole("button", { name: /Export sent.*appears on the page/ })).toHaveCount(0);
  await expect(setup.getByRole("button", { name: /Export sent.*checked by the agent/ })).toBeVisible();
  await expect(setup.getByRole("button", { name: /The agent clicks/ })).toBeVisible();
});

test("rewrites a fixed date and requires a fresh test before scheduling", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=fixed-dates`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeVisible();
  await setup.getByRole("button", { name: "Use last month" }).click();
  await expect(setup.getByText("Click the first day of last month", { exact: true })).toBeVisible();
  await expect(setup.getByText("Changes require a new test.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await setup.getByRole("button", { name: /^Run test/ }).click();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeVisible();
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(saved.at(-1).config.stages[0].prompt).not.toContain("1 September 2026");
});

test("keeps the browser, final step, and primary action visible at desktop and narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/host?scenario=ten-steps`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  const browser = await setup.getByRole("region", { name: "Agent browser", exact: true }).boundingBox();
  expect(browser?.width ?? 0).toBeGreaterThanOrEqual(1440 * 0.6);
  await expect(setup.getByText("Download the statement", { exact: true })).toBeInViewport();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeInViewport();
  await page.screenshot({ path: "e2e-artifacts/test-passed-desktop.png" });
  await page.setViewportSize({ width: 480, height: 900 });
  await setup.getByRole("button", { name: "Continue to schedule" }).scrollIntoViewIfNeeded();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeInViewport();
  const dimensions = await setup.locator("body").evaluate((body) => ({ width: body.scrollWidth, viewport: innerWidth }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
  await page.screenshot({ path: "e2e-artifacts/test-passed-narrow.png" });
});

test("shows the agent's note for each finished screen as a readable bar", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=agent-notes`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);

  const help = setup.getByRole("button", { name: "How the test works" });
  await expect(setup.getByText("Reiterate runs your steps in a new browser.", { exact: false })).toBeHidden();
  await help.click();
  await expect(setup.getByText("Reiterate runs your steps in a new browser.", { exact: false })).toBeVisible();
  await help.press("Escape");
  await expect(setup.getByText("Reiterate runs your steps in a new browser.", { exact: false })).toBeHidden();

  await setup.getByRole("button", { name: "Run test" }).click();
  const bar = setup.locator(".test-caption");
  await expect(bar.locator(".caption-kind")).toHaveText("Finished");
  await expect(bar.locator(".caption-summary")).toHaveText("Opened Reports, kept the last-month filter, and downloaded the statement.");
  await expect(bar).not.toContainText("{");
  await expect(bar).not.toContainText("Download started: statement.pdf");
  await expect(bar.getByText("3 / 3")).toBeVisible();
  await bar.getByRole("button", { name: "More" }).click();
  await expect(bar).toContainText("Saw “Download started: statement.pdf”");
  await expect(bar).toContainText("Confirming the download The statement download started.");
  await page.screenshot({ path: "e2e-artifacts/test-agent-note-expanded.png" });
  await bar.getByRole("button", { name: "Less" }).click();
  expect((await bar.boundingBox())?.height ?? 0).toBeLessThan(56);
  await page.screenshot({ path: "e2e-artifacts/test-agent-note.png" });

  await bar.getByRole("button", { name: "Previous screen" }).click();
  await expect(bar.locator(".caption-kind")).toHaveText("Actions");
  await expect(bar.locator(".caption-summary")).toHaveText("Click · Type · Press keys");
  await expect(bar.getByRole("button", { name: "More" })).toHaveCount(0);

  await bar.getByRole("button", { name: "Previous screen" }).click();
  await expect(bar.locator(".caption-kind")).toHaveText("Thinking");
  await page.setViewportSize({ width: 480, height: 900 });
  expect((await bar.boundingBox())?.height ?? 0).toBeLessThan(56);
  await expect(bar.getByRole("button", { name: "Next screen" })).toBeInViewport();
  await page.screenshot({ path: "e2e-artifacts/test-agent-note-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(bar.locator(".caption-summary")).toHaveText("Opening the reports The reports menu is in the left navigation.");
  await expect(bar.getByRole("button", { name: "Previous screen" })).toBeDisabled();
  await bar.getByRole("button", { name: "More" }).click();
  await expect(bar).toContainText("Checking the date filter The filter already shows last month.");
});

test("assumes https for a website address typed without a scheme", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("portal.example.test");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();

  await expect(setup.getByRole("heading", { name: "Demonstrate the task" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__startUrls)).toEqual(["https://portal.example.test"]);
});

test.describe("in a time zone ahead of UTC", () => {
  test.use({ timezoneId: "Asia/Kolkata" });

  test("formats the edit header's next run in local time", async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=edit-schedule`);
    const setup = page.frameLocator("iframe");
    await expect(setup.getByText(/Daily 09:00 UTC · next run .*14:30.*GMT\+5:30/)).toBeVisible();
  });

});

test("does not start or save an agent when the setup URL has a credential query", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports?token=synthetic-token");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();

  await expect(setup.getByRole("alert")).toContainText("Remove anything after ? or #.");
  await expect(setup.getByRole("button", { name: "Run test" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__savedAgents)).toEqual([]);
});

test("repeats demonstrated typing and choices as exact values", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=form-entry`);
  const setup = page.frameLocator("iframe");

  await describeAndDemonstrate(setup);
  await expect(setup.getByLabel("Step 2 text")).toHaveValue("September 2026");
  await setup.getByLabel("Step 2 text").fill("October 2026");
  await expect(setup.getByLabel("Step 3 option")).toHaveValue("PDF");
  await setup.getByLabel("Step 3 option").fill("CSV");
  await expect(setup.getByLabel("Step 3 description")).toHaveValue("Choose CSV in Format");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: "e2e-artifacts/review-form-entry.png" });
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  const saved = JSON.stringify(await page.evaluate(() => window.__savedAgents));
  expect(saved).toContain('replace any text in Statement month with exactly \\"October 2026\\"');
  expect(saved).toContain('Choose CSV in Format: in Format, choose exactly \\"CSV\\"');
  expect(saved).not.toContain("PDF");
  await expect.poll(() => page.evaluate(() => window.__credentialRequests)).toEqual([]);
});

test("asks the host for sign-in details before the first test and never handles them itself", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=sign-in`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await expect(setup.getByText("Uses the username saved in Reiterate, stored encrypted.")).toBeVisible();
  await expect(setup.getByText("Uses the password saved in Reiterate, stored encrypted.")).toBeVisible();
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await setup.getByRole("button", { name: "Run test again" }).click();
  await expect.poll(() => page.evaluate(() => window.__credentialRequests)).toEqual([
    { kinds: ["username", "password"], replace: false },
    { kinds: ["username", "password"], replace: false },
  ]);
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(JSON.stringify(saved)).toContain("type exactly $password into Password.");
  expect(saved.every((agent: { config: { parameters: object } }) => Object.keys(agent.config.parameters).length === 0)).toBe(true);
});

test("turns a demonstrated form field into a saved sign-in field", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=form-entry`);
  const setup = page.frameLocator("iframe");

  await describeAndDemonstrate(setup);
  await setup.getByLabel("Step 2 field type").selectOption("password");
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__credentialRequests)).toEqual([{ kinds: ["password"], replace: false }]);
  expect(JSON.stringify(await page.evaluate(() => window.__savedAgents))).toContain("type exactly $password into Statement month.");
});

test("does not test a sign-in agent when the host has no credential support", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=sign-in-unsupported`);
  const setup = page.frameLocator("iframe");

  await describeAndDemonstrate(setup);
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(setup.getByRole("alert")).toContainText("Reload Reiterate");
  await expect.poll(() => page.evaluate(() => window.__savedAgents)).toEqual([]);
});

test("ignores a response posted by the setup iframe instead of its host", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-02T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-10-02T00:01:00Z"));
  await page.goto(`${baseUrl}/host?scenario=delayed-ready`);
  const setup = page.frameLocator("iframe");
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (frame === undefined) {
    throw new Error("Expected the setup iframe.");
  }

  await expect(setup.getByText("Connecting to Reiterate")).toBeVisible();
  await page.waitForFunction(() => window.__requestIds.length === 1);
  const readyId = await page.evaluate(() => window.__requestIds[0]);
  await frame.evaluate((id) => {
    window.postMessage(
      {
        type: "workflow-use:response",
        version: 1,
        id,
        result: { schedule: true },
      },
      window.location.origin,
    );
  }, readyId);
  await expect(setup.getByText("Connecting to Reiterate")).toBeVisible();
  await page.clock.runFor(300);
  await expect(setup.getByLabel("Agent name")).toBeVisible();
});

test("uses new request IDs after the setup iframe reloads", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Set up your agent" })).toBeVisible();

  const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
  if (frame === undefined) {
    throw new Error("Expected the setup iframe.");
  }
  const navigated = page.waitForEvent("framenavigated", (candidate) => candidate === frame);
  await frame.evaluate(() => window.location.reload());
  await navigated;
  await expect(setup.getByRole("heading", { name: "Set up your agent" })).toBeVisible();

  const requestIds = await page.evaluate(() => window.__requestIds);
  expect(requestIds).toHaveLength(2);
  expect(requestIds[0]).not.toBe(requestIds[1]);
});

test("shows the describe form and its primary action without scrolling on a laptop screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await expect(setup.getByRole("button", { name: "Close setup" })).toBeInViewport({ ratio: 1 });
  await expect(setup.getByRole("button", { name: "Continue to demonstration" })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: "e2e-artifacts/describe-laptop.png" });

  await page.setViewportSize({ width: 900, height: 640 });
  await expect(setup.getByRole("button", { name: "Continue to demonstration" })).toBeInViewport({ ratio: 1 });
  const header = await setup.locator(".setup-header").evaluate((element) => element.getBoundingClientRect().height);
  expect(header).toBeLessThan(64);
  await page.screenshot({ path: "e2e-artifacts/describe-900.png" });
});

test("fits a ten-step review on one desktop screen", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/host?scenario=ten-steps`);
  const setup = page.frameLocator("iframe");

  await describeAndDemonstrate(setup);
  await expect(setup.getByLabel("Step 10 description")).toBeInViewport();
  await expect(setup.getByRole("button", { name: "Continue to test" })).toBeInViewport();
  await setup.getByLabel("Step 4 description").hover();
  await page.screenshot({ path: "e2e-artifacts/review-ten-steps.png" });
  await page.setViewportSize({ width: 480, height: 900 });
  await page.screenshot({ path: "e2e-artifacts/review-narrow.png" });
});

test("uses one top bar and the same title row on every stage", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  // The repository is public; the page carries no source or license footer.
  await expect(setup.locator("footer")).toHaveCount(0);
  await expect(setup.getByRole("link", { name: /source code|license/i })).toHaveCount(0);

  const expectStage = async (title: string) => {
    await expect(setup.locator(".stage-title h2")).toHaveText(title);
    const layout = await setup.locator("body").evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const header = box(".setup-topbar"), progress = box(".setup-progress"), back = box(".setup-topbar .setup-nav"), close = box(".setup-close"), heading = box(".stage-title h2");
      const description = document.querySelector(".stage-title p")?.getBoundingClientRect();
      return { headers: document.querySelectorAll("header.setup-header").length, headerHeight: header.height, centreOffset: Math.abs(progress.left + progress.width / 2 - (header.left + header.width / 2)), backLeft: back.left, closeRight: innerWidth - close.right, sameRow: Math.abs(back.top - close.top) < 2 && Math.abs(back.top - progress.top) < 8, headingFont: getComputedStyle(document.querySelector(".stage-title h2")!).font, headingLeft: heading.left, headingTop: heading.top - header.bottom, descriptionGap: description ? description.top - heading.bottom : null, descriptionLeft: description ? description.left - heading.left : null };
    });
    expect(layout.headers).toBe(1);
    expect(layout.headerHeight).toBeLessThan(56);
    expect(layout.centreOffset).toBeLessThan(2);
    expect(layout.sameRow).toBe(true);
    expect(layout.backLeft).toBeLessThan(40);
    expect(layout.closeRight).toBeLessThan(40);
    return { font: layout.headingFont, left: Math.round(layout.headingLeft), top: Math.round(layout.headingTop), descriptionGap: layout.descriptionGap === null ? null : Math.round(layout.descriptionGap), descriptionLeft: layout.descriptionLeft === null ? null : Math.round(layout.descriptionLeft) };
  };

  const formats = [await expectStage("Describe the job")];
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  formats.push(await expectStage("Demonstrate the task"));
  await setup.getByRole("button", { name: "Continue to review" }).click();
  formats.push(await expectStage("Review the draft"));
  await setup.getByRole("button", { name: "Continue to test" }).click();
  // The test stage keeps its explanation behind a (?) next to the heading.
  const testFormat = await expectStage("Verify agent can follow the process");
  expect(testFormat).toEqual({ ...formats[0], descriptionGap: null, descriptionLeft: null });
  for (const format of formats) expect(format).toEqual(formats[0]);
});

test("captures the controlled setup states for visual review", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Set up your agent" })).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/describe.png" });

  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  await page.screenshot({ path: "e2e-artifacts/demonstrate.png" });

  await setup.getByRole("button", { name: "Continue to review" }).click();
  await page.screenshot({ path: "e2e-artifacts/review.png" });

  await setup.getByRole("button", { name: "Continue to test" }).click();
  await page.screenshot({ path: "e2e-artifacts/test.png" });
});

test("clears a load error after successfully retrying", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-load-error`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("alert")).toContainText("Loading failed. Try again.");
  await page.evaluate(() => { window.__loadAvailable = true; });
  await setup.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await expect(setup.getByRole("alert")).toHaveCount(0);
});

test("loads and edits an existing agent through the host contract", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await expect(setup.getByText("Live v3")).toBeVisible();
  await setup.getByLabel("Step 1 description").fill("Open the updated reports section");
  await expect(setup.getByText("Step 1 instruction")).toBeVisible();
});

test("makes instructions the main column and keeps testing visible beside sign-in details", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-schedule`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByText(/Daily 09:00 UTC · next run .*09:00.*UTC/)).toBeVisible();
  const main = await setup.locator(".edit-main").boundingBox();
  const rail = await setup.locator(".edit-rail").boundingBox();
  const grid = await setup.locator(".edit-grid").boundingBox();
  expect(main!.width / grid!.width).toBeGreaterThanOrEqual(.65);
  expect(main!.width / grid!.width).toBeLessThanOrEqual(.75);
  expect(rail!.width / grid!.width).toBeGreaterThanOrEqual(.25);
  expect(rail!.width / grid!.width).toBeLessThanOrEqual(.35);
  expect(rail!.x).toBeGreaterThan(main!.x + main!.width);
  expect(rail!.y).toBe(main!.y);
  await expect(setup.getByRole("button", { name: "Test changes" })).toBeInViewport({ ratio: 1 });
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeInViewport({ ratio: 1 });
  await expect(setup.locator(".edit-publish")).toHaveCSS("position", "sticky");
  await page.screenshot({ path: "e2e-artifacts/edit-loaded.png" });
});

test("only renames when the trimmed name changes and remembers the saved name", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  const name = setup.getByLabel("Agent name");
  await expect(name).toHaveValue("Monthly report agent");
  await name.focus();
  await name.blur();
  await name.fill("  Monthly report agent  ");
  await name.blur();
  await expect(name).toHaveValue("Monthly report agent");
  expect(await page.evaluate(() => window.__renameRequests)).toEqual([]);
  await name.fill("  Renamed report agent  ");
  await name.blur();
  await expect.poll(() => page.evaluate(() => window.__renameRequests)).toEqual(["Renamed report agent"]);
  await expect(name).toBeEnabled();
  await name.focus();
  await name.blur();
  expect(await page.evaluate(() => window.__renameRequests)).toEqual(["Renamed report agent"]);
  expect(await page.evaluate(() => window.__publishRequests)).toEqual([]);
});

test("keeps a passed draft test publishable after a rename", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Step 1 description").fill("Updated reports section");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeEnabled();
  await setup.getByLabel("Agent name").fill("Renamed report agent");
  await setup.getByLabel("Agent name").blur();
  await expect.poll(() => page.evaluate(() => window.__renameRequests)).toEqual(["Renamed report agent"]);
  await expect(setup.getByText("Test completed")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeEnabled();
});

test("shows rename errors beside the name and permits retry", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-rename-error`);
  const setup = page.frameLocator("iframe");
  const name = setup.getByLabel("Agent name");
  await name.fill("Renamed report agent");
  await name.blur();
  await expect(setup.locator(".edit-header").getByRole("alert")).toHaveText("Rename failed. Try again.");
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await name.focus();
  await name.blur();
  await expect(setup.locator(".edit-header").getByRole("alert")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__renameRequests)).toEqual(["Renamed report agent", "Renamed report agent"]);
});

test("labels reordered, added and removed steps and reverts each change", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  const rail = setup.locator(".edit-changes");
  await setup.getByRole("button", { name: "Move step 1 down" }).click();
  await expect(rail.getByText("Step order changed", { exact: true })).toBeVisible();
  await expect(rail.getByText("2 steps → 2 steps", { exact: true })).toHaveCount(0);
  await rail.getByRole("button", { name: "Revert" }).click();
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("Open the reports section");
  await setup.getByRole("button", { name: "Insert step", exact: true }).click();
  await expect(rail.getByText("Step added", { exact: true })).toBeVisible();
  await rail.getByRole("button", { name: "Revert" }).click();
  await expect(setup.getByLabel("Step 3 description")).toHaveCount(0);
  await setup.getByRole("button", { name: "Remove step 1", exact: true }).click();
  await expect(rail.getByText("Step removed", { exact: true })).toBeVisible();
  await rail.getByRole("button", { name: "Revert" }).click();
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("Open the reports section");
  await expect(rail.getByText("No changes yet.")).toBeVisible();
});

test("tests a draft, checks the result, and shows the scheduled publish notice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/host?scenario=edit-schedule`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await setup.getByLabel("Step 1 description").fill("Open the updated reports section");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  const label = await setup.locator(".result-check").boundingBox();
  expect(label!.height).toBeLessThan(25);
  const check = await setup.getByLabel("I checked the result").boundingBox();
  const publish = await setup.getByRole("button", { name: "Publish changes" }).boundingBox();
  expect(Math.abs(check!.y + check!.height / 2 - publish!.y - publish!.height / 2)).toBeLessThan(2);
  await page.screenshot({ path: "e2e-artifacts/edit-tested.png" });
  await setup.getByRole("button", { name: "Publish changes" }).click();
  await expect(setup.getByText(/Scheduled runs will use v4 at .*09:00.*UTC/ )).toBeVisible();
  await expect(setup.getByRole("dialog", { name: "Publish changes?" })).toHaveAccessibleDescription("Publish 1 change to this agent.");
  await setup.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(setup.getByRole("status").filter({ hasText: "Published v4." })).toHaveText(/Published v4\. Scheduled runs use it at .*09:00.*UTC\./);
  await setup.getByLabel("Step 1 description").fill("Another edit");
  await expect(setup.getByText("Published v4.", { exact: false })).toHaveCount(0);
});

test("shows the conflict modal and supports overwrite or discard", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/host?scenario=edit-conflict`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await setup.getByLabel("Step 1 description").fill("Changed locally");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await setup.getByRole("button", { name: "Publish changes" }).click();
  await setup.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(setup.getByRole("heading", { name: "This agent changed while you were editing" })).toBeVisible();
  await expect(setup.getByRole("dialog")).toHaveCount(1);
  await expect(setup.getByText("teammate@example.test saved it at 01.10.2026 at 10:00.", { exact: true })).toBeVisible();
  await expect(setup.getByText("teammate@example.test saved it at 01.10.2026 at 10:00.", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Publish mine anyway" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Reload their version" })).toBeVisible();
  const actions = await setup.getByRole("dialog").getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().y));
  expect(actions).toHaveLength(3);
  expect(Math.max(...actions) - Math.min(...actions)).toBeLessThanOrEqual(2);
  await expect(setup.getByRole("dialog").locator(".edit-actions")).toHaveCSS("justify-content", "flex-end");
  await page.screenshot({ path: "e2e-artifacts/edit-conflict.png" });
  await setup.getByRole("button", { name: "Publish mine anyway" }).click();
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();

  await page.goto(`${baseUrl}/host?scenario=edit-conflict`);
  const discarded = page.frameLocator("iframe");
  await expect(discarded.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await discarded.getByLabel("Step 1 description").fill("Discarded locally");
  await discarded.getByRole("button", { name: "Test changes" }).click();
  await expect(discarded.getByText("Test completed")).toBeVisible();
  await discarded.getByLabel("I checked the result").check();
  await discarded.getByRole("button", { name: "Publish changes" }).click();
  await discarded.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(discarded.getByRole("heading", { name: "This agent changed while you were editing" })).toBeVisible();
  await discarded.getByRole("button", { name: "Reload their version" }).click();
  await expect(discarded.getByLabel("Step 1 description")).toHaveValue("Open the reports section");
  await expect(discarded.getByRole("heading", { name: "Publish changes?" })).toHaveCount(0);
});

test("retries a failed draft test and then enables checked publish", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-fail-pass`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await setup.getByLabel("Step 1 description").fill("Retry the updated reports section");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test failed")).toBeVisible();
  await setup.getByRole("button", { name: "Run test again" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeEnabled();
});

test("reviews raw agent Details changes and enables publishing without editing stages", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Website address").fill("https://portal.example.test/new-reports");
  await setup.getByLabel("Goal", { exact: true }).fill("Download the updated report.");
  const rail = setup.locator(".edit-changes");
  await expect(rail.getByText("Website address", { exact: true })).toBeVisible();
  await expect(rail.getByText("Goal", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeEnabled();
  await rail.locator(".change-item").filter({ hasText: "Website address" }).getByRole("button", { name: "Revert" }).click();
  await expect(setup.getByLabel("Website address")).toHaveValue("https://portal.example.test/reports");
  await rail.getByRole("button", { name: "Revert" }).click();
  await expect(rail.getByText("No changes yet.")).toBeVisible();
});

test("keeps a published raw agent editable when its stored setup has empty steps", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw-empty`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Instructions" })).toBeVisible();
  await expect(setup.locator(".raw-preserved")).toContainText("Sleep stage · 5 s");
  await setup.getByLabel("Agent instructions", { exact: true }).fill("Updated legacy prompt after reopening");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeEnabled();
});

test("lets maximum actions be cleared and typed without changing other raw stages", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw`);
  const setup = page.frameLocator("iframe");
  const limit = setup.getByLabel("Maximum actions", { exact: true });
  await limit.fill("");
  await expect(limit).toHaveValue("");
  await limit.pressSequentially("32");
  await expect(limit).toHaveValue("32");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(saved[0].config.stages[0]).toEqual({ type: "agent", prompt: "Open reports", step_limit: 32 });
  expect(JSON.stringify(saved[0].config.stages.slice(1))).toBe(JSON.stringify([{ type: "download" }, { type: "sleep", sleep_ms: 5000 }, { type: "reload" }]));
  await setup.getByRole("button", { name: "Revert Maximum actions" }).click();
  await expect(limit).toHaveValue("16");
});

test("shows invalid maximum actions on blur or test and never saves them", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw`);
  const setup = page.frameLocator("iframe");
  const limit = setup.getByLabel("Maximum actions", { exact: true });
  for (const value of ["", "0", "1.5", "abc", "129"]) {
    await limit.fill(value);
    await limit.blur();
    await expect(limit).toHaveValue(value);
    await expect(limit).toHaveAttribute("aria-invalid", "true");
    await expect(setup.getByRole("alert")).toHaveText("Enter a whole number from 1 to 128.");
    await setup.getByRole("button", { name: "Test changes" }).click();
    expect(await page.evaluate(() => window.__savedAgents)).toEqual([]);
  }
  await limit.fill("32");
  await expect(setup.getByRole("alert")).toHaveCount(0);
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
});

test("keeps raw stages and internal agents safe", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Instructions" })).toBeVisible();
  await expect(setup.locator(".raw-preserved")).toHaveText("Then: Download stage · Sleep stage · 5 s · Reload stage — kept as is");
  await expect(setup.locator("pre.raw-preserved")).toHaveCount(0);
  await page.screenshot({ path: "e2e-artifacts/edit-raw.png" });
  await setup.getByLabel("Agent instructions", { exact: true }).fill("Updated legacy prompt");
  await expect(setup.locator(".edit-changes p")).toHaveText("1 unpublished change");
  await page.screenshot({ path: "e2e-artifacts/edit-raw-changed.png" });
  await expect(setup.locator(".edit-changes").getByText("Agent instructions", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  const rawSaved = await page.evaluate(() => window.__savedAgents);
  expect(JSON.stringify(rawSaved)).toContain("Updated legacy prompt");
  expect(rawSaved[0].config.stages.slice(1)).toEqual([{ type: "download" }, { type: "sleep", sleep_ms: 5000 }, { type: "reload" }]);
  await page.goto(`${baseUrl}/host?scenario=edit-internal`);
  const internal = page.frameLocator("iframe");
  await expect(internal.getByText("Read-only internal agent")).toBeVisible();
  await expect(internal.getByLabel("Agent name")).toBeDisabled();
  await expect(internal.getByRole("button", { name: "Publish changes" })).toBeDisabled();
});

test("renames without creating a version and re-demonstrates from a selected step", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await setup.getByLabel("Agent name").fill("Renamed report agent");
  await setup.getByLabel("Agent name").blur();
  const redemonstrateFrom = setup.getByLabel("Re-demonstrate from step");
  await redemonstrateFrom.selectOption({ value: "1" });
  await expect(redemonstrateFrom).toHaveValue("1");
  await setup.getByRole("button", { name: "Re-demonstrate" }).click();
  await expect(setup.getByTitle("Virtual browser")).toBeVisible();
  await expect(setup.getByTitle("Virtual browser")).toHaveAttribute("src", "https://live.browserbase.com/session");
  await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("Open the reports section");
  await expect(setup.getByLabel("Step 2 description")).toHaveValue("Download the refreshed statement");
  await expect.poll(() => page.evaluate(() => window.__renameRequests)).toEqual(["Renamed report agent"]);
  await expect.poll(() => page.evaluate(() => window.__publishRequests)).toEqual([]);
  await expect(setup.getByRole("button", { name: "Re-demonstrate" })).toBeEnabled();
  await setup.getByRole("button", { name: "Re-demonstrate" }).click();
  await expect(setup.getByTitle("Virtual browser")).toBeVisible();
  await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
  await expect(setup.getByRole("alert")).toHaveCount(0);
});

test("guards leaving edits and closes immediately without changes", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Close edit page" }).click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{ agentId: "agent-1" }]);
  await expect(setup.getByRole("dialog")).toHaveCount(0);
  await page.goto(`${baseUrl}/host?scenario=edit`);
  await setup.getByLabel("Step 1 description").fill("Unsaved instruction");
  const back = setup.getByRole("button", { name: "Back to web agents" });
  await back.click();
  await expect(setup.getByRole("dialog", { name: "Discard your changes?" })).toBeVisible();
  expect(await page.evaluate(() => window.__closeRequests)).toEqual([]);
  await setup.getByRole("button", { name: "Keep editing" }).click();
  await expect(back).toBeFocused();
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("Unsaved instruction");
  await setup.getByRole("button", { name: "Close edit page" }).click();
  await setup.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{ agentId: "agent-1" }]);
});

test("guards leaving a running test or re-demonstration with no draft changes", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-watch`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByRole("status").filter({ hasText: "Test is running." })).toBeVisible();
  await expect(setup.getByLabel("Step 1 description")).toBeDisabled();
  await expect(setup.getByRole("button", { name: "Insert step" })).toBeDisabled();
  await expect(setup.getByRole("button", { name: "Move step 1 down" })).toBeDisabled();
  await expect(setup.getByRole("link", { name: "Watch the test" })).toHaveAttribute("target", "_blank");
  await expect(setup.getByRole("link", { name: "Watch the test" })).toHaveAttribute("rel", "noreferrer");
  await setup.getByRole("button", { name: "Close edit page" }).click();
  await expect(setup.getByRole("dialog", { name: "Discard your changes?" })).toBeVisible();
  await setup.getByRole("button", { name: "Keep editing" }).click();
  expect(await page.evaluate(() => window.__closeRequests)).toEqual([]);
  await page.goto(`${baseUrl}/host?scenario=edit`);
  await setup.getByRole("button", { name: "Re-demonstrate", exact: true }).click();
  await setup.getByRole("button", { name: "Back to web agents" }).click();
  await expect(setup.getByRole("dialog", { name: "Discard your changes?" })).toBeVisible();
  await setup.getByRole("button", { name: "Keep editing" }).click();
  await expect(setup.getByRole("button", { name: "Finish re-demonstration" })).toBeVisible();
  expect(await page.evaluate(() => window.__closeRequests)).toEqual([]);
});

test("explains publish availability and moves primary emphasis after a passed test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-fail-pass`);
  const setup = page.frameLocator("iframe");
  const publish = setup.getByRole("button", { name: "Publish changes" });
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveAccessibleDescription("Make a change to publish.");
  await expect(setup.getByRole("button", { name: "Test changes" })).toHaveClass(/button-primary/);
  await setup.getByLabel("Step 1 description").fill("Updated instruction");
  await expect(publish).toHaveAccessibleDescription("Test your changes before publishing.");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByRole("alert")).toContainText("The website rejected the request.");
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveAccessibleDescription("Test your changes before publishing.");
  await setup.getByRole("button", { name: "Run test again" }).click();
  await expect(publish).toHaveAccessibleDescription("Confirm you checked the result.");
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveClass(/button-primary/);
  await expect(setup.getByRole("button", { name: "Test again" })).toHaveClass(/button-quiet/);
  await setup.getByLabel("I checked the result").check();
  await expect(publish).toBeEnabled();
  await setup.getByLabel("Step 1 expected outcome").fill("Updated outcome");
  await expect(setup.getByLabel("I checked the result")).toHaveCount(0);
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveAccessibleDescription("Test your changes before publishing.");
  await page.goto(`${baseUrl}/host?scenario=edit-internal`);
  await expect(publish).toHaveAccessibleDescription("Managed by Operations. Publishing changes is disabled.");
  await expect(setup.getByRole("button", { name: "Test changes" })).toBeDisabled();
  await expect(setup.getByLabel("Step 1 description")).toBeDisabled();
});

test("inserts an empty focused instruction and blocks testing until it is filled", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Insert step" }).click();
  const instruction = setup.getByLabel("Step 3 description");
  await expect(instruction).toHaveValue("");
  await expect(instruction).toBeFocused();
  await expect(instruction).toHaveAttribute("placeholder", "Describe the action");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByRole("alert")).toHaveText("Add an instruction for step 3 before testing.");
  expect(await page.evaluate(() => window.__savedAgents)).toEqual([]);
  expect(await page.evaluate(() => window.__testArguments)).toEqual([]);
  await instruction.fill("Open the downloaded file");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
});

test("commits a rename with Enter and reverts it with Escape", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  const name = setup.getByLabel("Agent name");
  await name.fill("Keyboard rename");
  await name.press("Enter");
  await expect(setup.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__renameRequests)).toEqual(["Keyboard rename"]);
  await name.fill("Revert this name");
  await name.press("Escape");
  await expect(name).toHaveValue("Keyboard rename");
  await name.blur();
  expect(await page.evaluate(() => window.__renameRequests)).toEqual(["Keyboard rename"]);
  await expect(setup.getByText("Live v3")).toBeVisible();
  expect(await page.evaluate(() => window.__publishRequests)).toEqual([]);
});

test("cancels publish and conflict dialogs and returns focus to Publish changes", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-conflict`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Step 1 description").fill("My changes");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  const publish = setup.getByRole("button", { name: "Publish changes" });
  await publish.click();
  const cancel = setup.getByRole("button", { name: "Cancel", exact: true });
  await expect(cancel).toBeFocused();
  await expect(setup.getByRole("dialog").locator(".edit-actions")).toHaveCSS("justify-content", "flex-end");
  await cancel.press("Escape");
  await expect(setup.getByRole("dialog")).toHaveCount(0);
  await expect(publish).toBeFocused();
  await publish.click();
  await setup.getByRole("button", { name: "Publish", exact: true }).click();
  const conflict = setup.getByRole("dialog", { name: "This agent changed while you were editing" });
  await expect(conflict).toHaveAccessibleDescription(/teammate@example.test saved it at .*permanently/);
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(conflict).toHaveCount(0);
  await expect(publish).toBeFocused();
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("My changes");
  await expect(publish).toBeEnabled();
});

test("keeps keyboard focus inside the publish dialog while the host is busy", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-slow-publish`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Step 1 description").fill("My changes");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await setup.getByRole("button", { name: "Publish changes" }).click();
  const dialog = setup.getByRole("dialog", { name: "Publish changes?" });
  await dialog.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Publishing…" })).toBeDisabled();
  await expect(setup.getByRole("button", { name: "Close edit page" })).toBeDisabled();
  await dialog.locator(".edit-modal-card").press("Tab");
  expect(await dialog.evaluate((element) => element.contains(element.ownerDocument.activeElement))).toBe(true);
  await dialog.locator(".edit-modal-card").press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(element.ownerDocument.activeElement))).toBe(true);
  await expect(setup.getByRole("status").filter({ hasText: "Published v4." })).toHaveText("Published v4.");
});

test("announces an unscheduled publish without claiming scheduled runs", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Step 1 description").fill("My changes");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await setup.getByRole("button", { name: "Publish changes" }).click();
  await setup.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(setup.getByRole("status").filter({ hasText: "Published v4." })).toHaveText("Published v4.");
});

async function expectNoSideStripes(setup: FrameLocator): Promise<void> {
  const violations = await setup.locator(".test-rail").evaluate((root) => [root, ...root.querySelectorAll("*")].flatMap((element) => {
    const style = getComputedStyle(element);
    return parseFloat(style.borderLeftWidth) > 1 || parseFloat(style.borderRightWidth) > 1 ? [element.className] : [];
  }));
  expect(violations).toEqual([]);
}

for (const scenario of ["edit", "edit-raw"]) {
  test(`uses full borders rather than accent side stripes in ${scenario}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    await setup.getByLabel("Goal", { exact: true }).fill("Changed goal");
    const checkBorders = async () => {
      const violations = await setup.locator(".edit-agent").evaluate((root) => [root, ...root.querySelectorAll("*")].flatMap((element) => {
        const style = getComputedStyle(element);
        return parseFloat(style.borderLeftWidth) > 1 || parseFloat(style.borderRightWidth) > 1 ? [element.className] : [];
      }));
      expect(violations).toEqual([]);
    };
    await checkBorders();
    await setup.getByRole("button", { name: "Test changes" }).click();
    await expect(setup.getByText("Test completed")).toBeVisible();
    await checkBorders();
    await setup.getByLabel("I checked the result").check();
    await setup.getByRole("button", { name: "Publish changes" }).click();
    await expect(setup.getByRole("dialog", { name: "Publish changes?" })).toBeVisible();
    await checkBorders();
  });
}

test("shows failure evidence and enlarges the final screen with keyboard focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/host?scenario=edit-fail-evidence`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.locator(".edit-result-failed > b")).toHaveText(["Test failed", "Website problem"]);
  await expect(setup.getByText("Failure kind:", { exact: false })).toHaveCount(0);
  await expect(setup.getByText("Stopped at step 2: Download the statement", { exact: true })).toBeVisible();
  await expect(setup.getByText("The reports list opened, but no file was downloaded.")).toBeVisible();
  const thumbnail = setup.getByRole("button", { name: "Enlarge final screen" });
  await expect(thumbnail.getByRole("img")).toHaveAttribute("alt", "I looked for the export button.");
  await expect(thumbnail.getByRole("img")).toHaveJSProperty("naturalWidth", 1);
  await setup.locator(".edit-result-failed").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "e2e-artifacts/edit-failed.png" });
  await thumbnail.click();
  const dialog = setup.getByRole("dialog", { name: "Final screen", exact: true });
  await expect(dialog.getByRole("img")).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close screenshot" });
  await expect(close).toBeFocused();
  await close.press("Tab");
  await expect(close).toBeFocused();
  await close.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(thumbnail).toBeFocused();
});

test("shows success files, confirmation and a final screen, or honest empty evidence", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByRole("link", { name: "statement.pdf" })).toBeVisible();
  await expect(setup.getByText("Export sent", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Enlarge final screen" }).getByRole("img")).toBeVisible();
  await page.goto(`${baseUrl}/host?scenario=edit-empty-result`);
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("The test finished successfully. No result details were returned.")).toBeVisible();
});

test("keeps the edit header and a way back for loading errors and missing agents", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-load-error`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Edit web agent", exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Back to web agents" }).click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{}]);
  await page.goto(`${baseUrl}/host?scenario=edit-missing`);
  await expect(setup.getByRole("heading", { name: "Edit web agent", exact: true })).toBeVisible();
  await expect(setup.getByRole("alert")).toContainText("This agent no longer exists. It may have been deleted.");
  await expect(setup.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await setup.getByRole("button", { name: "Back to web agents" }).click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{}]);
});

for (const [kind, label] of [
  ["signin", "Sign-in problem"],
  ["website", "Website problem"],
  ["steps", "A step didn't work"],
  ["result", "Result problem"],
  ["check", "Completion check failed"],
  ["service", "Reiterate service problem"],
  ["unknown", "Cause unknown"],
  ["missing", "Cause unknown"],
  ["unrecognized", "Cause unknown"],
]) {
  test(`shows a plain edit failure label for ${kind}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=edit-failure-label-${kind}`);
    const setup = page.frameLocator("iframe");
    await setup.getByRole("button", { name: "Test changes" }).click();
    const result = setup.getByRole("alert");
    await expect(result.locator("> b")).toHaveText(["Test failed", label]);
    await expect(result).not.toContainText("Failure kind:");
    await expect(result).not.toContainText(`: ${kind}`);
  });
}

test("reviews and reverts raw fields independently and announces only changed counts", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw`);
  const setup = page.frameLocator("iframe");
  const prompt = setup.getByLabel("Agent instructions", { exact: true });
  const limit = setup.getByLabel("Maximum actions", { exact: true });
  const rail = setup.locator(".edit-changes");
  const status = rail.getByRole("status");
  await expect(status).toHaveText("No unpublished changes");
  await expect(rail.locator("p")).toHaveText("No changes yet.");
  await prompt.fill("Open updated reports\nDownload the report");
  await expect(status).toHaveText("1 unpublished change");
  await expect(rail.locator("p")).toHaveText("1 unpublished change");
  await expect(rail.getByText("Open reports → Open updated reports", { exact: true })).toBeVisible();
  await prompt.pressSequentially(" now");
  await expect(status).toHaveText("1 unpublished change");
  await limit.fill("32");
  await expect(status).toHaveText("2 unpublished changes");
  await expect(rail.locator("p")).toHaveText("2 unpublished changes");
  await expect(rail.getByText("16 → 32", { exact: true })).toBeVisible();
  await rail.getByRole("button", { name: "Revert Agent instructions", exact: true }).click();
  await expect(prompt).toHaveValue("Open reports");
  await expect(prompt).toBeFocused();
  await expect(limit).toHaveValue("32");
  await expect(status).toHaveText("1 unpublished change");
  await rail.getByRole("button", { name: "Revert Maximum actions", exact: true }).click();
  await expect(limit).toHaveValue("16");
  await expect(limit).toBeFocused();
  await expect(status).toHaveText("No unpublished changes");
  await expect(rail.locator("p")).toHaveText("No changes yet.");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  expect(JSON.stringify((await page.evaluate(() => window.__savedAgents))[0].config.stages)).toBe(JSON.stringify([{ type: "agent", prompt: "Open reports", step_limit: 16 }, { type: "download" }, { type: "sleep", sleep_ms: 5000 }, { type: "reload" }]));
});

test("moves focus to reverted structured fields and to Changes after removing an addition", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  const goal = setup.getByLabel("Goal", { exact: true });
  await goal.fill("Changed goal");
  await setup.getByRole("button", { name: "Revert Goal", exact: true }).click();
  await expect(goal).toBeFocused();
  const instruction = setup.getByLabel("Step 1 description");
  await instruction.fill("Changed instruction");
  await setup.getByRole("button", { name: "Revert Step 1 instruction", exact: true }).click();
  await expect(instruction).toBeFocused();
  await setup.getByRole("button", { name: "Insert step" }).click();
  await setup.getByRole("button", { name: "Revert Step added", exact: true }).click();
  await expect(setup.getByRole("heading", { name: "Changes", exact: true })).toBeFocused();
});

for (const scenario of ["edit", "edit-raw"]) {
  for (const width of [1024, 960]) {
    for (const inset of [0, 64]) {
      test(`keeps instructions beside the rail at ${width}px with ${inset}px host inset in ${scenario}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${baseUrl}/host?scenario=${scenario}`);
        await page.locator("iframe").evaluate((frame, inset) => { frame.style.width = `calc(100% - ${inset}px)`; frame.style.marginInline = `${inset / 2}px`; }, inset);
        const setup = page.frameLocator("iframe");
        await expect(setup.getByRole("heading", { name: "Sign-in details", exact: true })).toBeVisible();
        const instructions = (await setup.locator(".edit-instructions").boundingBox())!;
        const rail = (await setup.locator(".edit-rail").boundingBox())!;
        expect(rail.x).toBeGreaterThanOrEqual(instructions.x + instructions.width);
        expect(rail.y).toBe(instructions.y);
        expect(rail.width).toBeGreaterThanOrEqual(280);
        expect((await page.locator("iframe").boundingBox())!.width).toBe(width - inset);
        await expect(setup.getByRole("button", { name: "Test changes" })).toBeInViewport({ ratio: 1 });
        expect(await setup.locator("html").evaluate((element) => element.scrollTop)).toBe(0);
        expect(await setup.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await page.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        if (scenario === "edit-raw" && width === 1024 && inset === 64) await page.screenshot({ path: "e2e-artifacts/edit-narrow.png" });
      });
    }
  }

  test(`puts testing directly after instructions in one column at 860px in ${scenario}`, async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 900 });
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    await expect(setup.getByRole("heading", { name: "Sign-in details", exact: true })).toBeVisible();
    const selectors = [".edit-instructions", ".edit-publish", ".edit-credentials", ".edit-changes", ".edit-details"];
    const boxes = await Promise.all(selectors.map((selector) => setup.locator(selector).boundingBox()));
    boxes.forEach((box, index) => {
      expect(box!.x).toBe(boxes[0]!.x);
      expect(box!.width).toBe(boxes[0]!.width);
      if (index > 0) expect(box!.y).toBeGreaterThanOrEqual(boxes[index - 1]!.y + boxes[index - 1]!.height);
    });
    expect(await setup.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(setup.getByRole("button", { name: "Close edit page" })).toBeInViewport();
  });
}

test("gives raw instructions most of the screen and grows for a long prompt", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw`);
  const setup = page.frameLocator("iframe");
  const prompt = setup.getByLabel("Agent instructions", { exact: true });
  await expect(prompt).toBeVisible();
  const height = (await prompt.boundingBox())!.height;
  expect(height).toBeGreaterThanOrEqual(900 * .5);
  const textareaHeights = await setup.locator("textarea").evaluateAll((fields) => fields.map((field) => field.getBoundingClientRect().height));
  expect(height).toBe(Math.max(...textareaHeights));
  const main = (await setup.locator(".edit-main").boundingBox())!.width;
  const grid = (await setup.locator(".edit-grid").boundingBox())!.width;
  expect(main / grid).toBeGreaterThanOrEqual(.65);
  expect(main / grid).toBeLessThanOrEqual(.75);
  await expect(setup.getByRole("button", { name: "Test changes" })).toBeInViewport({ ratio: 1 });
  const longPrompt = Array.from({ length: 37 }, (_, index) => `${index + 1}. Open the reports page, check the period, and download the monthly statement. Confirm that the download succeeds before continuing.`).join("\n\n");
  await prompt.fill(longPrompt);
  expect((await prompt.boundingBox())!.height).toBeGreaterThan(height);
  expect(await prompt.evaluate((field) => field.scrollHeight <= field.clientHeight + 2)).toBe(true);
  await prompt.hover();
  await page.mouse.wheel(0, 1400);
  await expect.poll(() => setup.locator("html").evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
  await expect(setup.getByRole("button", { name: "Test changes" })).toBeInViewport({ ratio: 1 });
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed", { exact: true })).toBeVisible();
  expect((await page.evaluate(() => window.__savedAgents))[0].config.stages[0].prompt).toBe(longPrompt);
});

test("changes saved sign-in kinds, invalidates the test, and requires a fresh checked test to publish", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw`);
  const setup = page.frameLocator("iframe");
  const card = setup.getByRole("region", { name: "Sign-in details" });
  await expect(card.locator("li")).toHaveText(["Username · saved", "Password · saved"]);
  await expect(card.locator("input, textarea")).toHaveCount(0);
  await setup.getByRole("button", { name: "Test changes" }).click();
  await setup.getByLabel("I checked the result").check();
  await card.getByRole("button", { name: "Change sign-in details", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__credentialRequests)).toEqual([{ kinds: ["username", "password"], replace: true }]);
  await expect(card.getByRole("status")).toHaveText("Changed — test before publishing");
  await expect(setup.getByText("Test completed", { exact: true })).toHaveCount(0);
  await expect(setup.getByLabel("I checked the result")).toHaveCount(0);
  const change = setup.locator(".change-item").filter({ hasText: "Sign-in details: updated" });
  await expect(change).toContainText("Leave without publishing to undo");
  await expect(change.getByRole("button")).toHaveCount(0);
  await expect(setup.locator(".edit-changes").getByRole("status")).toHaveText("1 unpublished change");
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeDisabled();
  await page.screenshot({ path: "e2e-artifacts/edit-credentials.png" });
  await setup.getByRole("button", { name: "Close edit page" }).click();
  await expect(setup.getByRole("dialog", { name: "Discard your changes?" })).toBeVisible();
  await setup.getByRole("button", { name: "Keep editing" }).click();
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByLabel("I checked the result")).not.toBeChecked();
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeDisabled();
  await setup.getByLabel("I checked the result").check();
  await setup.getByRole("button", { name: "Publish changes" }).click();
  await expect(setup.getByRole("dialog")).toContainText("Publish 1 change to this agent.");
  await setup.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(setup.getByText("Published v4.", { exact: true })).toBeVisible();
  await expect(setup.locator(".edit-changes").getByRole("status")).toHaveText("No unpublished changes");
  await expect(card.getByRole("status")).toHaveCount(0);
});

for (const [scenario, kinds] of [
  ["edit-raw-placeholders", ["username", "password", "otp"]],
  ["edit-credentials-placeholders", ["username", "password", "otp"]],
] as const) {
  test(`requests saved kinds and instruction placeholders in ${scenario}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    await expect(setup.locator(".edit-credentials li")).toHaveText(scenario === "edit-raw-placeholders"
      ? ["Username · saved", "Password · saved", "Authenticator key · Not saved"]
      : ["Username · saved", "Password · Not saved", "Authenticator key · Not saved"]);
    await setup.getByRole("button", { name: "Change sign-in details", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__credentialRequests)).toEqual([{ kinds: [...kinds], replace: true }]);
    await expect(setup.locator(".edit-credentials li")).toHaveText(["Username · saved", "Password · saved", "Authenticator key · saved"]);
  });
}

for (const scenario of ["edit-credentials-empty", "edit-raw-no-signin"]) {
  test(`offers a quiet add action without unsaved rows in ${scenario}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    const card = setup.getByRole("region", { name: "Sign-in details" });
    await expect(card.getByText("No sign-in details saved.", { exact: true })).toBeVisible();
    await expect(card.locator("li")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Change sign-in details", exact: true })).toHaveCount(0);
    const add = card.getByRole("button", { name: "Add sign-in details", exact: true });
    await expect(add).toHaveClass("button button-quiet");
    if (scenario === "edit-raw-no-signin") await page.screenshot({ path: "e2e-artifacts/edit-no-signin.png" });
    await add.click();
    await expect.poll(() => page.evaluate(() => window.__credentialRequests)).toEqual([{ kinds: ["username", "password"], replace: true }]);
    await expect(card.locator("li")).toHaveText(["Username · saved", "Password · saved"]);
    await expect(card.getByRole("button", { name: "Change sign-in details", exact: true })).toBeVisible();
    await expect(card.getByText("No sign-in details saved.", { exact: true })).toHaveCount(0);
    await expect(setup.locator(".edit-changes").getByRole("status")).toHaveText("1 unpublished change");
  });
}

test("lists only referenced sign-in kinds as instructions change", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw-no-signin`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Agent instructions", { exact: true }).fill("Sign in with $otp.");
  await expect(setup.locator(".edit-credentials li")).toHaveText(["Authenticator key · Not saved"]);
  await setup.getByRole("button", { name: "Change sign-in details", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__credentialRequests)).toEqual([{ kinds: ["otp"], replace: true }]);
  await setup.getByLabel("Agent instructions", { exact: true }).fill("Sign in with $username and $password.");
  await expect(setup.locator(".edit-credentials li")).toHaveText(["Username · Not saved", "Password · Not saved", "Authenticator key · saved"]);
});

for (const scenario of ["edit-old-host", "edit-credentials-unsupported"]) {
  test(`keeps sign-in details compatible with ${scenario}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    await expect(setup.getByText("Sign-in details: managed in the agent settings", { exact: true })).toBeVisible();
    await expect(setup.getByRole("button", { name: "Change sign-in details", exact: true })).toHaveCount(0);
  });
}

test("shows credential host errors inline and keeps internal agents read-only", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-credentials-error`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Change sign-in details", exact: true }).click();
  await expect(setup.locator(".edit-credentials").getByRole("alert")).toHaveText("Sign-in details belong to a different website. Restore the website address first.");
  await expect(setup.locator(".edit-changes").getByRole("status")).toHaveText("No unpublished changes");
  await expect(setup.getByRole("button", { name: "Change sign-in details", exact: true })).toBeEnabled();
  await page.goto(`${baseUrl}/host?scenario=edit-internal`);
  await expect(setup.locator(".edit-credentials li")).toHaveText(["Username · saved", "Password · saved"]);
  await expect(setup.getByRole("button", { name: "Change sign-in details", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__credentialRequests)).toEqual([]);
});

async function describeAndDemonstrate(setup: FrameLocator): Promise<void> {
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();
}

async function completeToTest(setup: FrameLocator): Promise<void> {
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();
  await setup.getByRole("button", { name: "Continue to test" }).click();
}

function hostPage(url: string): string {
  const encodedOrigin = encodeURIComponent(url);
  return `<!doctype html>
<html><body><iframe src="${url}/?parentOrigin=${encodedOrigin}" title="Agent setup"></iframe>
<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{overflow:hidden}</style>
<script>
  const scenario = new URLSearchParams(location.search).get("scenario");
  const legacy = scenario === "legacy" || scenario === "legacy-lost-schedule-reply";
  window.__requestIds = [];
  window.__testArguments = [];
  window.__chooseScheduleCalls = [];
  window.__createdRoutes = [];
  window.__allowedSenders = [];
  window.__emailArrivals = [];
  window.__scheduleArguments = [];
  window.__scheduleRequests = [];
  window.__closeRequests = [];
  window.__savedAgents = [];
  window.__credentialRequests = [];
  window.__startUrls = [];
  window.__renameRequests = [];
  window.__publishRequests = [];
  let recordingActive = false;
  let exportSentAt = 0;
  const signIn = scenario === "sign-in" || scenario === "sign-in-unsupported" || scenario === "signin-failure";
  const emailScenario = scenario?.startsWith("email-");
  const screen = { image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S8sAAAAASUVORK5CYII=", thought: "I looked for the export button." };
  // Thought shapes as the web agent stores them: reasoning summaries, proposed actions, the final JSON outcome.
  const agentNoteScreens = [
    { ...screen, thought: "**Opening the reports**\\n\\nThe reports menu is in the left navigation.\\n**Checking the date filter**\\n\\nThe filter already shows last month." },
    { ...screen, thought: "Proposed computer actions: click, type, keypress." },
    { ...screen, thought: '**Confirming the download**\\n\\nThe statement download started.\\n{"status":"completed","reason":"Opened Reports, kept the last-month filter, and downloaded the statement.","step":2,"confirmation":"Download started: statement.pdf"}' },
  ];
  let recordingExists = false;
  let publishedConflict = false;
  let testAttempts = 0;
  let editVersion = 3;
  let editName = "Monthly report agent";
  let publishedDraft = null;
  window.__loadAvailable = scenario !== "edit-load-error";
  const edit = scenario.startsWith("edit");
  const editSteps = [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: "The reports list is visible" },
    { id: "download", type: "click", description: "Download the statement", target: "Download statement" },
  ];
  const redemonstrationSteps = [{ id: "download-refreshed", type: "click", description: "Download the refreshed statement", target: "Download statement" }];
  const internal = scenario === "edit-internal";
  let savedCredentials = ["edit-credentials-empty", "edit-raw-no-signin"].includes(scenario) ? [] : ["username", "password"];
  if (scenario === "edit-credentials-placeholders") {
    savedCredentials = ["username"];
    editSteps[0].description += " with $password";
    editSteps[0].expectedOutcome += " after $otp";
  }
  const steps = [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: scenario === "email-recipient-check" ? "Support contact me@example.test is visible" : "The reports list is visible" },
    ...(scenario === "email-ambiguous" ? [
      { id: "billing", type: "input", description: "Enter billing contact", target: "Billing email", value: "billing@example.test" },
      { id: "recipient", type: "input", description: "Enter export recipient", target: "Send export to", value: "recipient@example.test" },
    ] : emailScenario ? [{ id: "email-address", type: "input", description: "Enter the export email", target: "Email address", value: "me@example.test", ...(scenario === "email-recipient-check" ? { expectedOutcome: "The recipient is me@example.test; confirm me@example.test appears in the field" } : {}) }] : []),
    ...(scenario === "form-entry" ? [
      { id: "choose-month", type: "input", description: "Fill in Statement month", target: "Statement month", value: "September 2026" },
      { id: "choose-format", type: "select_change", description: "Choose PDF in Format", target: "Format", value: "PDF" },
    ] : []),
    ...(scenario === "select-failure" ? [{ id: "choose-format", type: "select_change", description: "Choose PDF in Format", target: "Format", value: "PDF" }] : []),
    ...(scenario === "many-steps" ? Array.from({ length: 60 }, (_, index) => ({ id: "scroll-" + index, type: "click", description: "Recorded action " + (index + 1), target: "Item " + (index + 1) })) : []),
    ...(["ten-steps", "fixed-dates"].includes(scenario) ? Array.from({ length: 8 }, (_, index) => ({ id: "filter-" + index, type: "click", description: "Apply report filter " + (index + 1), target: "Filter " + (index + 1), expectedOutcome: index % 2 ? "The filtered list is visible" : null })) : []),
    ...(signIn ? [
      { id: "user", type: "credential", description: "Enter the saved username in Email", target: "Email", value: "username" },
      { id: "pass", type: "credential", description: "Enter the saved password in Password", target: "Password", value: "password" },
    ] : []),
    ...(scenario === "fixed-dates" ? [{ id: "first-day", type: "click", description: "Click 1 September 2026", target: "1 September 2026" }] : []),
    ...(["step-failure", "unknown-failure"].includes(scenario) ? [{ id: "export", type: "click", description: "Find the export button", target: "Export" }] : []),
    emailScenario
      ? { id: "send-export", type: "click", description: "Send the export", target: "Send export" }
      : { id: "download", type: "click", description: "Download the statement", target: "Download statement" }
  ];
  addEventListener("message", (event) => {
    const request = event.data;
    if (request?.type !== "workflow-use:request") return;
    window.__requestIds.push(request.id);
    const send = (result) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, result }, event.origin);
    const fail = (error) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, error }, event.origin);
    if (request.method === "ready") {
      if (scenario === "delayed-ready") setTimeout(() => send({ schedule: true }), 300);
      else send({ schedule: true, mode: edit ? "edit" : "create", credentials: !["sign-in-unsupported", "edit-credentials-unsupported"].includes(scenario), emailRoutes: !legacy, chooseSchedule: !legacy && scenario !== "no-text" });
    } else if (request.method === "loadAgent") {
      if (scenario === "edit-missing") { fail("This agent no longer exists. It may have been deleted."); return; }
      if (!window.__loadAvailable) { fail("Loading failed. Try again."); return; }
      send({ agentId: "agent-1", name: editName, url: publishedDraft?.draft.url ?? "https://portal.example.test/reports", goal: publishedDraft?.draft.goal ?? "Download the monthly report.", steps: publishedDraft?.draft.steps ?? (scenario.startsWith("edit-raw") && scenario !== "edit-raw-empty" ? null : scenario === "edit-raw-empty" ? [] : editSteps), stages: publishedDraft?.config.stages ?? [{ type: "agent", prompt: scenario === "edit-raw-placeholders" ? "Sign in with $username and $otp. Open reports." : "Open reports", step_limit: 16 }, { type: "download" }, { type: "sleep", sleep_ms: 5000 }, { type: "reload" }], ...(scenario === "edit-old-host" ? {} : { credentials: { saved: savedCredentials } }), liveConfigId: "config-3", version: editVersion, internal, schedule: scenario === "edit-schedule" ? "Daily 09:00 UTC" : null, nextRunAt: scenario === "edit-schedule" ? "2026-10-02T09:00:00Z" : null });
    } else if (request.method === "renameAgent") { window.__renameRequests.push(request.params.name); if (scenario === "edit-rename-error" && window.__renameRequests.length === 1) fail("Rename failed. Try again."); else { editName = request.params.name; send(null); }
    } else if (request.method === "saveDraft") { window.__savedAgents.push(request.params); send({ draftId: "draft-1" });
    } else if (request.method === "publishDraft") {
      window.__publishRequests.push(request.params);
      if (scenario === "edit-conflict" && !request.params.overwrite && !publishedConflict) { publishedConflict = true; send({ conflict: { updatedBy: "teammate@example.test", updatedAt: "2026-10-01T10:00:00Z" } }); }
      else { editVersion += 1; publishedDraft = window.__savedAgents.at(-1); if (scenario === "edit-slow-publish") setTimeout(() => send({ version: editVersion }), 2000); else send({ version: editVersion }); }
    } else if (request.method === "requestCredentials") { window.__credentialRequests.push(request.params); if (scenario === "edit-credentials-error") { fail("Sign-in details belong to a different website. Restore the website address first."); return; } savedCredentials = request.params.kinds; send({ saved: savedCredentials }); } else if (request.method === "startRecording") { window.__startUrls.push(request.params.url); if (edit ? recordingExists : recordingActive) { fail("Finish the current demonstration first."); return; } recordingActive = true; recordingExists = true; send({ id: "recording-1", status: "recording", liveViewUrl: "https://live.browserbase.com/session", steps: edit ? [] : steps, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null }); }
    else if (request.method === "getRecording" || request.method === "stopRecording") { if (request.method === "stopRecording") recordingActive = false; send({ id: "recording-1", status: request.method === "getRecording" && recordingActive ? "recording" : "stopped", liveViewUrl: "https://live.browserbase.com/session", steps: edit ? (request.method === "stopRecording" ? redemonstrationSteps : []) : steps, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null }); }
    else if (request.method === "cancelRecording") { recordingActive = false; recordingExists = false; send(undefined); }
    else if (request.method === "saveAgent") { if (window.__savedSchedule || scenario === "rerun-save-rejection" && window.__savedAgents.length > 0) fail("This agent is scheduled. Edit it in agent settings."); else { window.__savedAgents.push(request.params); send({ id: "agent-1" }); } }
    else if (request.method === "testAgent") { testAttempts += 1; window.__testArguments.push(request.params.arguments); exportSentAt = Date.now(); if (scenario === "email-cutoff" && window.__testArguments.length > 1) setTimeout(() => send({ id: "run-" + window.__testArguments.length }), 1000); else send({ id: "run-" + window.__testArguments.length }); }
    else if (request.method === "getTestRun") {
      if (scenario === "edit-fail-evidence") send({ status: "failed", failure: { kind: "website", message: "The download button was missing." }, stoppedAtStep: 2, confirmation: "The reports list opened, but no file was downloaded.", screens: [{ ...screen, thought: "Earlier screen" }, screen] });
      else if (scenario.startsWith("edit-failure-label-")) {
        const kind = scenario.slice("edit-failure-label-".length);
        send({ status: "failed", failure: kind === "missing" ? null : { kind, message: "The test could not finish." } });
      }
      else if (scenario === "edit-empty-result") send({ status: "succeeded", files: [], screens: [], confirmation: null });
      else if (scenario === "service-failure") send({ status: "failed", failure: { kind: "service", message: "The AI service did not respond." }, stoppedAtStep: null, screens: [] });
      if (scenario === "service-failure-midrun") send({ status: "failed", failure: { kind: "service", message: "The AI service did not respond." }, stoppedAtStep: 2, screens: [] });
      else if (scenario === "described-failure") send({ status: "failed", failure: { kind: "steps", message: "Success criterion not met: the page still shows Export pending" }, stoppedAtStep: 2, screens: [screen] });
      else if (scenario === "unknown-failure") send({ status: "failed", error: "The test stopped, but its cause is unknown. Try again.", failure: { kind: "unknown", message: "The test stopped, but its cause is unknown. Try again." }, stoppedAtStep: 2, confirmation: null, files: [], screens: [screen] });
      else if (scenario === "step-failure") send({ status: "failed", failure: { kind: "steps", message: "The button was missing." }, stoppedAtStep: 2, screens: [{ ...screen, thought: "I opened Reports." }, screen] });
      else if (scenario === "select-failure" && window.__testArguments.length === 1) send({ status: "failed", failure: { kind: "steps", message: "The PDF option was missing." }, stoppedAtStep: 2, screens: [screen] });
      else if (scenario === "signin-failure" && window.__testArguments.length === 1) send({ status: "failed", failure: { kind: "signin", message: "The username field was missing." }, stoppedAtStep: 2, screens: [screen] });
      else if ((emailScenario || scenario === "text-result") && window.__testArguments.length === 1) send({ status: "failed", failure: { kind: "result", message: "No file was downloaded." }, stoppedAtStep: null, screens: [screen] });
      else if (scenario === "agent-notes") send({ status: "succeeded", files: [{ name: "statement.pdf", url: "https://files.example.test/statement.pdf" }], screens: agentNoteScreens, confirmation: "Download started: statement.pdf" });
      else if (scenario === "failed" || (scenario === "edit-fail-pass" && testAttempts === 1)) send({ status: "failed", error: "The website rejected the request." });
      else if (scenario === "watch" || scenario === "edit-watch") send({ status: "running", liveViewUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html" });
      else send({ status: "succeeded", files: emailScenario || scenario === "described-success" ? [] : [{ name: "statement.pdf", url: "https://files.example.test/statement.pdf" }], screens: [screen], confirmation: scenario === "described-success" ? "The green toast says Export sent" : "Export sent" });
    } else if (request.method === "createEmailRoute") { window.__createdRoutes.push(request.params); send({ channelId: "route-1", address: "reports+agent@reiterate.com" }); }
    else if (request.method === "getEmailArrival") {
      window.__emailArrivals.push(request.params);
      if (scenario === "email-no-documents") send({ status: "no_documents", from: "portal@example.test" });
      else if (scenario === "email-cutoff") send(Date.parse(request.params.since) <= exportSentAt ? { status: "routed", files: [{ name: "statement.pdf", url: "https://files.example.test/statement.pdf" }] } : { status: "waiting" });
      else if (scenario === "email-waiting") send({ status: "waiting" });
      else if (window.__allowedSenders.length === 0) send({ status: "rejected", from: "portal@example.test" });
      else send({ status: "routed", from: "portal@example.test", files: [{ name: "statement.pdf", url: "https://files.example.test/statement.pdf" }] });
    } else if (request.method === "allowEmailSender") { window.__allowedSenders.push(request.params); send(undefined); }
    else if (request.method === "chooseSchedule") {
      window.__chooseScheduleCalls.push(request.params);
      if (window.__savedSchedule) fail("This agent is already scheduled.");
      else if (scenario === "slow-schedule") setTimeout(() => send({ cron: "30 9 * * *" }), 90_000);
      else send(scenario === "cancel-schedule" ? null : { cron: scenario === "manual-schedule" ? "" : "30 9 * * *" });
    } else if (request.method === "scheduleAgent") {
      window.__scheduleRequests.push(request.params);
      if (window.__savedSchedule) {
        const first = window.__scheduleRequests[0];
        if (first.runId === request.params.runId && first.cron === request.params.cron) send(undefined);
        else fail("This agent is already scheduled.");
      } else if (scenario === "schedule-save-failure" && window.__scheduleRequests.length === 1) fail("Schedule save failed.");
      else {
        window.__savedSchedule = request.params.cron;
        window.__scheduleArguments.push(request.params.arguments);
        if (scenario !== "lost-schedule-reply" && scenario !== "legacy-lost-schedule-reply") send(undefined);
      }
    }
    else if (request.method === "close") { window.__closeRequests.push(request.params); send(undefined); }
    else fail("Unknown request");
  });
</script></body></html>`;
}
