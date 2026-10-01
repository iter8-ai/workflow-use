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
  await expect(setup.getByRole("link", { name: "Source code" })).toHaveAttribute("href", "https://github.com/iter8-ai/workflow-use");
  await expect(setup.getByRole("link", { name: "AGPL-3.0 license" })).toHaveAttribute("href", "https://github.com/iter8-ai/workflow-use/blob/main/LICENSE");
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
  await expect(setup.getByLabel("Custom done-when text")).toBeDisabled();
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
  await setup.getByLabel("Custom done-when text").fill("Export sent");
  await setup.getByLabel("Custom done-when text").press("Tab");
  await expect(setup.getByText("Test passed", { exact: true })).toHaveCount(0);
  await expect(setup.locator(".done-when.done")).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await setup.getByLabel("Custom done-when text").focus();
  await setup.getByLabel("Custom done-when text").press("Tab");
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toBeVisible();
  await setup.getByLabel("Custom done-when text").fill("Export delivered");
  await setup.getByLabel("Custom done-when text").press("Tab");
  await expect(setup.getByText("Test passed", { exact: true })).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
});

test("retains the file criterion and passing test after unchanged stale custom text blurs", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await setup.getByLabel("Custom done-when text").fill("Export sent");
  await setup.getByLabel("Custom done-when text").press("Tab");
  await expect(setup.locator(".done-when > div").first()).toHaveText("“Export sent” appears on the page");
  await setup.getByRole("button", { name: "A file is downloaded in the browser" }).click();
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await setup.locator("summary").filter({ hasText: "Change" }).click();
  await expect(setup.getByLabel("Custom done-when text")).toHaveValue("Export sent");
  await setup.getByLabel("Custom done-when text").focus();
  await setup.getByLabel("Custom done-when text").press("Tab");
  await expect(setup.locator(".done-when > div").first()).toHaveText("A file is downloaded in the browser");
  await expect(setup.getByText("Test passed", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Continue to schedule" }).click();
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toBeVisible();
  expect(await page.evaluate(() => window.__testArguments)).toHaveLength(1);
  expect(await page.evaluate(() => window.__savedAgents[0].draft.doneWhen)).toEqual({ kind: "file" });
  expect(await page.evaluate(() => window.__scheduleRequests[0].runId)).toBe("run-1");
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

test("uses custom text as the completion stage", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=text-result`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await setup.getByLabel("Custom done-when text").fill("Export sent");
  await setup.getByLabel("Custom done-when text").press("Tab");
  await setup.getByRole("button", { name: /^Run test(?: again)?$/ }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  const saved = await page.evaluate(() => window.__savedAgents);
  expect(saved.at(-1).draft.doneWhen).toEqual({ kind: "text", value: "Export sent" });
  expect(saved.at(-1).config.stages.at(-1)).toEqual({ type: "expect_text", text: "Export sent" });
});

test("keeps custom done-when editable after validation fails and requires a fresh test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=text-result`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Every step ran, but no file was downloaded")).toBeVisible();
  const customText = setup.getByLabel("Custom done-when text");
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
  await expect(setup.getByRole("heading", { name: "Test a fresh run" })).toBeVisible();
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
  expect(saved.at(-1).draft.doneWhen).toEqual({ kind: "text", value: "Export sent" });
});

test("legacy host hides new done-when options and uses its inline schedule", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=legacy`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("button", { name: /Send the export to Reiterate instead/ })).toHaveCount(0);
  await expect(setup.getByLabel("Custom done-when text")).toHaveCount(0);
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
  await expect(setup.getByLabel("Custom done-when text")).toHaveCount(0);
  await expect(setup.getByRole("button", { name: /Export sent/ })).toHaveCount(0);
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
  let recordingActive = false;
  let exportSentAt = 0;
  const signIn = scenario === "sign-in" || scenario === "sign-in-unsupported" || scenario === "signin-failure";
  const emailScenario = scenario?.startsWith("email-");
  const screen = { image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S8sAAAAASUVORK5CYII=", thought: "I looked for the export button." };
  const steps = [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: "The reports list is visible" },
    ...(scenario === "email-ambiguous" ? [
      { id: "billing", type: "input", description: "Enter billing contact", target: "Billing email", value: "billing@example.test" },
      { id: "recipient", type: "input", description: "Enter export recipient", target: "Send export to", value: "recipient@example.test" },
    ] : emailScenario ? [{ id: "email-address", type: "input", description: "Enter the export email", target: "Email address", value: "me@example.test" }] : []),
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
      else send({ schedule: true, credentials: scenario !== "sign-in-unsupported", emailRoutes: !legacy, chooseSchedule: !legacy && scenario !== "no-text" });
    } else if (request.method === "requestCredentials") { window.__credentialRequests.push(request.params); send({ saved: request.params.kinds }); } else if (request.method === "startRecording") { window.__startUrls.push(request.params.url); if (recordingActive) { fail("Finish the current demonstration first."); return; } recordingActive = true; send({ id: "recording-1", status: "recording", liveViewUrl: "https://live.browserbase.com/session", steps, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null }); }
    else if (request.method === "getRecording" || request.method === "stopRecording") send({ id: "recording-1", status: request.method === "getRecording" && recordingActive ? "recording" : "stopped", liveViewUrl: "https://live.browserbase.com/session", steps, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null });
    else if (request.method === "cancelRecording") { recordingActive = false; send(undefined); }
    else if (request.method === "saveAgent") { if (window.__savedSchedule || scenario === "rerun-save-rejection" && window.__savedAgents.length > 0) fail("This agent is scheduled. Edit it in agent settings."); else { window.__savedAgents.push(request.params); send({ id: "agent-1" }); } }
    else if (request.method === "testAgent") { window.__testArguments.push(request.params.arguments); exportSentAt = Date.now(); if (scenario === "email-cutoff" && window.__testArguments.length > 1) setTimeout(() => send({ id: "run-" + window.__testArguments.length }), 1000); else send({ id: "run-" + window.__testArguments.length }); }
    else if (request.method === "getTestRun") {
      if (scenario === "service-failure") send({ status: "failed", failure: { kind: "service", message: "The AI service did not respond." }, stoppedAtStep: null, screens: [] });
      if (scenario === "service-failure-midrun") send({ status: "failed", failure: { kind: "service", message: "The AI service did not respond." }, stoppedAtStep: 2, screens: [] });
      else if (scenario === "unknown-failure") send({ status: "failed", error: "The test stopped, but its cause is unknown. Try again.", failure: { kind: "unknown", message: "The test stopped, but its cause is unknown. Try again." }, stoppedAtStep: 2, confirmation: null, files: [], screens: [screen] });
      else if (scenario === "step-failure") send({ status: "failed", failure: { kind: "steps", message: "The button was missing." }, stoppedAtStep: 2, screens: [{ ...screen, thought: "I opened Reports." }, screen] });
      else if (scenario === "select-failure" && window.__testArguments.length === 1) send({ status: "failed", failure: { kind: "steps", message: "The PDF option was missing." }, stoppedAtStep: 2, screens: [screen] });
      else if (scenario === "signin-failure" && window.__testArguments.length === 1) send({ status: "failed", failure: { kind: "signin", message: "The username field was missing." }, stoppedAtStep: 2, screens: [screen] });
      else if ((emailScenario || scenario === "text-result") && window.__testArguments.length === 1) send({ status: "failed", failure: { kind: "result", message: "No file was downloaded." }, stoppedAtStep: null, screens: [screen] });
      else if (scenario === "failed") send({ status: "failed", error: "The website rejected the request." });
      else if (scenario === "watch") send({ status: "running", liveViewUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html" });
      else send({ status: "succeeded", files: emailScenario ? [] : [{ name: "statement.pdf", url: "https://files.example.test/statement.pdf" }], screens: [screen], confirmation: "Export sent" });
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
