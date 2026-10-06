import { readFileSync } from "node:fs";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";
const clockStart = new Date("2026-10-04T09:00:00Z");
const clockPaused = new Date("2026-10-04T09:00:30Z");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/^https:\/\/(?:[^/]+\.)?browserbase\.com\//, (route) => route.fulfill({ contentType: "text/html", body: "<p>Recorded browser</p>" }));
  await page.route(/\/host\?scenario=/, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: hostPage(baseUrl, new URL(route.request().url()).searchParams.get("scenario")),
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

test("keeps a newly added expected outcome open in Review", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);

  const row = setup.locator(".review-step").nth(1);
  const disclosure = row.getByRole("button", { name: "Add expected outcome" });
  await expect(row.getByLabel("Step 2 expected outcome")).toHaveCount(0);
  await disclosure.click();
  await row.getByLabel("Step 2 expected outcome").fill("The statement is downloaded");
  await expect(row.getByLabel("Step 2 expected outcome")).toHaveValue("The statement is downloaded");
  await expect(disclosure).toHaveCount(0);
});

test("shows the demonstration's download and groups the finished steps into stages", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${baseUrl}/host?scenario=organized`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Agent name").fill("Monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();

  await page.clock.runFor(2_100);
  await expect(setup.getByRole("status").filter({ hasText: "Downloading statement-2026-09.csv…" })).toBeVisible();
  await page.clock.runFor(2_100);
  await expect(setup.getByRole("status").filter({ hasText: "Downloaded statement-2026-09.csv" })).toBeVisible();
  await expect(setup.getByLabel("Recorded steps list")).toContainText("Download statement-2026-09.csv");

  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();
  await expect(setup.getByText("Grouping your steps into stages")).toBeVisible();
  await expect(setup.getByLabel("Step 2 description")).toHaveValue("Click Continue with GoogleorEmailPasswordLog in");
  await page.clock.runFor(1_600);
  await expect(setup.getByText("Grouping your steps into stages")).toHaveCount(0);
  await expect(setup.getByLabel("Step 2 description")).toHaveValue("Click Email login");
  await expect(setup.getByLabel("Stage name for steps 1–2")).toHaveValue("Sign in");
  await expect(setup.getByLabel("Stage name for steps 3–5")).toHaveValue("Download the statement");
  await setup.getByLabel("Stage name for steps 1–2").fill("Log in");

  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(setup.locator(".test-stage")).toHaveText(["Log in", "Download the statement"]);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect.poll(() => page.evaluate(() => window.__savedAgents.length)).toBe(1);
  const saved = await page.evaluate(() => window.__savedAgents[0]);
  expect(saved.draft.steps.map((step: { stage?: string }) => step.stage)).toEqual(["Log in", "Log in", "Download the statement", "Download the statement", "Download the statement"]);
  expect(saved.config.stages[0].prompt).toContain("Log in:\n1. Navigate to");
  expect(saved.config.stages[0].prompt).toContain("Download the statement:\n3. Click Reports.");
  expect(saved.config.stages[0].prompt).toContain("Do not start the download again.");
  expect(saved.config.stages[0].prompt).toContain('2. Click Email login. Its recorded label was "Continue with GoogleorEmailPasswordLog in".');
});

test("edits stage names and keeps a moved step in the stage it moves into", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-staged`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByLabel("Stage name for step 1")).toHaveValue("Open reports");
  await setup.getByLabel("Stage name for step 2").fill("Download the statement");
  await setup.getByRole("button", { name: "Move step 2 up" }).click();
  await expect(setup.getByLabel("Stage name for step 1")).toHaveValue("Open reports");
  await expect(setup.getByLabel("Stage name for step 2")).toHaveCount(0);
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect.poll(() => page.evaluate(() => window.__savedAgents.length)).toBe(1);
  const saved = await page.evaluate(() => window.__savedAgents[0]);
  expect(saved.draft.steps.map((step: { id: string; stage?: string }) => [step.id, step.stage])).toEqual([["download", "Open reports"], ["open-reports", "Open reports"]]);
  expect(saved.config.stages[0].prompt).toContain("Open reports:\n1. ");
});

test("merges recorded date fields and asks a goal-driven question", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=date-create`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);
  await expect(setup.getByLabel("Step 2 description")).toHaveValue("Enter the From date");
  await expect(setup.getByLabel("Step 4 description")).toHaveValue("Download the statement");
  await expect(setup.locator(".review-step-number")).toHaveCount(0);
  await expect(setup.locator(".step-number-prefix")).toHaveCount(4);
  await expect(setup.locator(".review-columns")).toHaveCount(0);
  await expect(setup.getByText("1 question to answer before testing", { exact: true })).toBeVisible();
  if (!process.env.CI) {
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots/review-date-open-1440.png" });
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots2/review-date-open-1440.png" });
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots2/review-date-open-1024.png" });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await expect(setup.getByRole("button", { name: "Continue to test" })).toBeDisabled();
  await expect(setup.getByText("Answer all open questions before testing.", { exact: true })).toBeVisible();
  await expect(setup.locator(".review-list")).not.toContainText(/[{}]/);
  await setup.getByRole("radio", { name: /End of last month/ }).click();
  if (!process.env.CI) await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots/review-date-answered-1440.png" });
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect.poll(() => page.evaluate(() => window.__savedAgents.length)).toBe(1);
  const saved = await page.evaluate(() => window.__savedAgents[0]);
  expect(saved.draft.steps).toHaveLength(4);
  expect(saved.draft.steps[1].date.rule).toEqual({ kind: "end_of_last_month" });
  expect(saved.config.stages[0].prompt).toContain("{end_of_last_month|");
  expect(saved.config.stages[0].prompt).not.toContain("2026");
});

test("answers a date question in Edit and records a revertable change", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-date`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("Enter the To date");
  await expect(setup.locator(".edit-step > b")).toHaveCount(0);
  await expect(setup.locator(".step-number-prefix")).toHaveCount(1);
  await expect(setup.getByText("1 question to answer before testing", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Test changes" })).toBeDisabled();
  await expect(setup.locator(".edit-steps")).not.toContainText(/[{}]/);
  await setup.getByRole("radio", { name: /End of last month/ }).click();
  await expect(setup.getByText("Step 1 date", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Revert Step 1 date", exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Test changes" })).toBeEnabled();
  await setup.getByRole("heading", { name: "Changes", exact: true }).evaluate((element) => element.scrollIntoView({ block: "center" }));
  if (!process.env.CI) {
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots/edit-date-change-1440.png", fullPage: true });
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots2/edit-1440.png", fullPage: true });
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  if (!process.env.CI) {
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots/edit-date-change-1024.png", fullPage: true });
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots2/edit-1024.png", fullPage: true });
  }
});

test("offers the OTP question in Review and requests an authenticator key", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=otp-create`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);
  await expect(setup.getByText("needs a one-time code", { exact: false })).toBeVisible();
  await setup.getByRole("radio", { name: "Authenticator app or email code set up in Reiterate" }).click();
  await expect.poll(() => page.evaluate(() => window.__credentialRequests)).toContainEqual({ kinds: ["otp"], replace: false });
  await expect(setup.getByText("needs a one-time code", { exact: false })).toHaveCount(0);
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

  const browser = setup.getByTitle("Virtual browser");
  await expect(browser).toHaveAttribute("allow", "clipboard-read; clipboard-write");
  const grid = await setup.locator(".demonstration-grid").boundingBox();
  expect(grid?.width ?? 0).toBeGreaterThan(1440 - 60);
  const browserBox = await browser.boundingBox();
  expect(browserBox?.width ?? 0).toBeGreaterThan(1000);
  expect(browserBox?.height ?? 0).toBeGreaterThan(560);
  await setup.getByRole("button", { name: "Finish demonstration" }).click();

  const list = setup.getByLabel("Recorded steps list");
  const sizes = await list.evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  await list.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect(setup.getByText("Recorded action 60")).toBeInViewport();
  await expect(setup.getByRole("button", { name: "Continue to review" })).toBeInViewport();
  await page.screenshot({ path: "e2e-artifacts/demonstrate-many-steps.png" });
});

for (const [width, height] of [[1440, 900], [1366, 768], [1280, 720], [1024, 768]]) {
  test(`shows the demonstration actions without scrolling at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${baseUrl}/host?scenario=many-steps`);
    const setup = page.frameLocator("iframe");
    await setup.getByLabel("Agent name").fill("Reports");
    await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
    await setup.getByLabel("What should the agent do?").fill("Get the report.");
    await setup.getByRole("button", { name: "Continue to demonstration" }).click();

    // Fully on screen with the page still at the top: nobody has to scroll to find the way out of recording.
    await expect(setup.getByRole("button", { name: "Finish demonstration" })).toBeInViewport({ ratio: 1 });
    await expect(setup.getByRole("button", { name: "Start over" })).toBeInViewport({ ratio: 1 });
    const page0 = await setup.locator("html").evaluate((element) => ({ top: element.scrollTop, scroll: element.scrollHeight, client: element.clientHeight }));
    expect(page0.top).toBe(0);
    expect(page0.scroll).toBeLessThanOrEqual(page0.client);
    const browserBox = (await setup.getByTitle("Virtual browser").boundingBox())!;
    expect(browserBox.height).toBeGreaterThan(height * 0.55);

    await setup.getByRole("button", { name: "Finish demonstration" }).click();
    await expect(setup.getByRole("button", { name: "Continue to review" })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `e2e-artifacts/demonstrate-actions-${width}x${height}.png` });
  });
}

test("keeps keyboard focus on the demonstration's next action and shows what was recorded", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Agent name").fill("Reports");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Get the report.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).press("Enter");

  // The new stage starts on its heading, and the recording controls come before the remote browser.
  await expect(setup.getByRole("heading", { name: "Demonstrate the task" })).toBeFocused();
  await expect(setup.getByRole("navigation", { name: "Agent setup progress" }).locator('[aria-current="step"]')).toHaveText(/Demonstrate/);
  await page.keyboard.press("Tab");
  await expect(setup.getByRole("button", { name: "Start over" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(setup.getByRole("button", { name: "Finish demonstration" })).toBeFocused();

  // The sign-in note moves out of the way into the steps rail; the steps are numbered like the review list.
  await expect(setup.locator(".credential-warning")).toHaveCount(0);
  await expect(setup.getByRole("complementary", { name: "Captured demonstration steps" })).toContainText("Sign in here if the site asks.");
  // Google's default number challenge in the Gmail app can't be repeated later; steer users to an authenticator code.
  await expect(setup.getByRole("complementary", { name: "Captured demonstration steps" })).toContainText("When Google asks you to confirm on your phone or tap a number in the Gmail app, choose More ways to verify (or Try another way) and enter the code from your authenticator app.");
  await expect(setup.getByRole("link", { name: "Add an authenticator app to your Google Account" })).toHaveAttribute("href", "https://myaccount.google.com/two-step-verification/authenticator");
  await expect(setup.getByRole("link", { name: "Add an authenticator app to your Google Account" })).toHaveAttribute("target", "_blank");
  await expect(setup.getByLabel("Recorded steps list").locator("ol")).toHaveCSS("list-style-type", "decimal");

  await page.keyboard.press("Enter");
  await expect(setup.getByRole("button", { name: "Continue to review" })).toBeFocused();
  // The recording service drops the live view when it stops; the summary still shows what was recorded.
  await expect(setup.getByTitle("Virtual browser")).toHaveCount(0);
  await expect(setup.getByText("2 steps recorded", { exact: true })).toBeVisible();
  await expect(setup.getByText("Continue to review to check and edit them.", { exact: true })).toBeVisible();
  await expect(setup.getByRole("status").filter({ hasText: "Demonstration finished" })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(setup.getByRole("heading", { name: "Review and complete the setup" })).toBeFocused();
});

test("shows the running test's latest screen without embedding the provider's viewer", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=watch`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();

  await expect(setup.getByText("Test is running", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Running…" })).toBeDisabled();
  const browser = setup.getByRole("region", { name: "Agent browser", exact: true });
  await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toBeVisible();
  await expect(browser.getByText("Live · view only")).toBeVisible();
  await expect(setup.locator("iframe")).toHaveCount(0);
});

test("follows the agent, shows its own closed screen while the run finishes, then keeps the evidence and activity", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.goto(`${baseUrl}/host?scenario=activity-success`);
  // Polls advance only with runFor, one status check per two seconds.
  await page.clock.pauseAt(clockPaused);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  const browser = setup.getByRole("region", { name: "Agent browser", exact: true });
  const activity = setup.getByRole("log", { name: "Agent activity" });

  await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
  await expect(setup.getByRole("tab", { name: "Activity" })).toHaveAttribute("aria-selected", "true");
  await page.clock.runFor(2_000);
  await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toBeVisible();
  await expect(activity.getByText("Browser opened")).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(activity.getByText("Type text")).toBeVisible();
  await expect(activity.getByText("Working")).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/test-activity-live.png" });
  await page.clock.runFor(2_000);
  await expect(browser.getByText("Agent is closing the browser")).toBeVisible();
  await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toHaveCount(0);
  await page.clock.runFor(2_000);
  await expect(browser.getByText("Agent closed the browser")).toBeVisible();
  await expect(browser.getByText("Last screen", { exact: true })).toBeVisible();
  await expect(setup.getByText("Test is running", { exact: true })).toBeVisible();
  await expect(setup.locator("iframe")).toHaveCount(0);
  await page.screenshot({ path: "e2e-artifacts/test-activity-closed.png" });

  await page.clock.runFor(2_000);
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await expect(browser.getByRole("img", { name: "Agent browser screen" })).toBeVisible();
  await expect(browser.getByText("Final screen", { exact: true })).toBeVisible();
  await expect(browser).not.toContainText("Downloaded the September statement.");
  await expect(setup.getByRole("tab", { name: /Steps/ })).toHaveAttribute("aria-selected", "true");
  await setup.getByRole("tab", { name: "Activity" }).click();
  await expect(activity.getByText("Browser closed")).toBeVisible();
  await expect(activity.getByText("Working")).toHaveCount(0);
  await page.screenshot({ path: "e2e-artifacts/test-activity-finished.png" });

  await setup.getByRole("button", { name: "Run test again" }).click();
  await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
  await expect(activity.getByText("Browser closed")).toHaveCount(0);
  await expect(activity.getByText("Type text")).toHaveCount(0);
  for (let poll = 0; poll < 5; poll += 1) await page.clock.runFor(2_000);
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  await expect(setup.getByRole("link", { name: "statement-run-2.pdf" })).toBeVisible();
  await expect(setup.getByRole("link", { name: "statement.pdf" })).toHaveCount(0);
});

test("marks the blocked action and keeps the failed run's last screen", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.goto(`${baseUrl}/host?scenario=activity-failure`);
  // Polls advance only with runFor, one status check per two seconds.
  await page.clock.pauseAt(clockPaused);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  // The first status check runs as soon as the test starts; later ones need the clock.
  await expect(setup.getByRole("region", { name: "Agent browser", exact: true }).getByText("Opening the virtual browser.")).toBeVisible();
  for (let poll = 0; poll < 5; poll += 1) await page.clock.runFor(2_000);
  await expect(setup.getByText("Stuck at step 2")).toBeVisible();
  const browser = setup.getByRole("region", { name: "Agent browser", exact: true });
  await expect(browser.getByText("Final screen", { exact: true })).toBeVisible();
  await expect(browser).not.toContainText("The Export button was missing.");
  await setup.getByRole("tab", { name: "Activity" }).click();
  const activity = setup.getByRole("log", { name: "Agent activity" });
  await expect(activity.getByText("Blocked", { exact: true })).toBeVisible();
  await expect(activity.getByText("Failed", { exact: true })).toBeVisible();
});

test("reports an unexpected browser loss without claiming the agent closed it", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.goto(`${baseUrl}/host?scenario=activity-lost`);
  // Polls advance only with runFor, one status check per two seconds.
  await page.clock.pauseAt(clockPaused);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  // The first status check runs as soon as the test starts; later ones need the clock.
  await expect(setup.getByRole("region", { name: "Agent browser", exact: true }).getByText("Opening the virtual browser.")).toBeVisible();
  for (let poll = 0; poll < 3; poll += 1) await page.clock.runFor(2_000);
  const browser = setup.getByRole("region", { name: "Agent browser", exact: true });
  await expect(browser.getByText("Browser connection lost")).toBeVisible();
  await expect(browser.getByText("Last screen", { exact: true })).toBeVisible();
  await expect(browser.getByText("Agent closed the browser")).toHaveCount(0);
  await expect(setup.getByText("Test is running", { exact: true })).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/test-activity-lost.png" });
});

for (const scenario of ["activity-poll-lost", "edit-activity-poll-lost"]) {
  test(`${scenario}: says the connection was lost while status checks fail, then reconnects`, async ({ page }) => {
    await page.clock.install({ time: clockStart });
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    // Polls advance only with runFor, one status check per two seconds.
    await page.clock.pauseAt(clockPaused);
    const setup = page.frameLocator("iframe");
    if (scenario.startsWith("edit-")) {
      await setup.getByLabel("Step 1 description").fill("Open the reports page");
      await setup.getByRole("button", { name: "Test changes" }).click();
    } else {
      await completeToTest(setup);
      await setup.getByRole("button", { name: "Run test" }).click();
    }
    const browser = setup.getByRole("region", { name: "Agent browser", exact: true });
    const activity = setup.getByRole("log", { name: "Agent activity" });
    await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
    for (let poll = 0; poll < 3; poll += 1) await page.clock.runFor(2_000);
    await expect(browser.getByText("Browser connection lost")).toBeVisible();
    await expect(browser.getByText(/^Reconnecting/)).toBeVisible();
    await expect(activity.getByText("Reconnecting…")).toBeVisible();
    await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toHaveCount(0);
    await expect(setup.getByText("The connection to Reiterate was lost.")).toHaveCount(0);
    for (let poll = 0; poll < 4; poll += 1) await page.clock.runFor(2_000);
    await expect(browser.getByText("Browser connection lost")).toBeVisible();
    await page.clock.runFor(2_000);
    await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toBeVisible();
    await expect(browser.getByText("Browser connection lost")).toHaveCount(0);
    await expect(activity.getByText("Working")).toBeVisible();
    await expect(setup.getByText("The connection to Reiterate was lost.")).toHaveCount(0);
  });
}

for (const scenario of ["activity-final-unreadable", "edit-activity-final-unreadable"]) {
  test(`${scenario}: keeps the last activity and says it may be incomplete when the final update can't be read`, async ({ page }) => {
    await page.clock.install({ time: clockStart });
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    // Polls advance only with runFor, one status check per two seconds.
    await page.clock.pauseAt(clockPaused);
    const setup = page.frameLocator("iframe");
    if (scenario.startsWith("edit-")) {
      await setup.getByLabel("Step 1 description").fill("Open the reports page");
      await setup.getByRole("button", { name: "Test changes" }).click();
    } else {
      await completeToTest(setup);
      await setup.getByRole("button", { name: "Run test" }).click();
    }
    await expect(setup.getByRole("region", { name: "Agent browser", exact: true }).getByText("Opening the virtual browser.")).toBeVisible();
    for (let poll = 0; poll < 5; poll += 1) await page.clock.runFor(2_000);
    if (!scenario.startsWith("edit-")) {
      await expect(setup.getByText("The agent completed every step")).toBeVisible();
      await setup.getByRole("tab", { name: "Activity" }).click();
    } else {
      await expect(setup.getByText("Test completed", { exact: true })).toBeVisible();
    }
    const activity = setup.getByRole("log", { name: "Agent activity" });
    await expect(activity.getByText("Type text")).toBeVisible();
    await expect(activity.getByText(/may be incomplete/)).toBeVisible();
  });
}

test("ignores a late reply with an older activity revision", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.goto(`${baseUrl}/host?scenario=activity-stale`);
  // Polls advance only with runFor, one status check per two seconds.
  await page.clock.pauseAt(clockPaused);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  // The first status check runs as soon as the test starts; later ones need the clock.
  await expect(setup.getByRole("region", { name: "Agent browser", exact: true }).getByText("Opening the virtual browser.")).toBeVisible();
  for (let poll = 0; poll < 3; poll += 1) await page.clock.runFor(2_000);
  const browser = setup.getByRole("region", { name: "Agent browser", exact: true });
  await expect(browser.getByText("Agent is closing the browser")).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(browser.getByText("Agent is closing the browser")).toBeVisible();
  await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toHaveCount(0);
  await page.clock.runFor(2_000);
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
});

test("never embeds the provider's viewer for a host without activity data", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=activity-unavailable`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("region", { name: "Agent browser", exact: true }).getByText("No live view for this test")).toBeVisible();
  await expect(setup.getByText("Live activity isn’t available for this test. The result appears when it finishes.")).toBeVisible();
  await expect(setup.locator("iframe")).toHaveCount(0);
});

for (const width of [1440, 1024]) {
  test(`gives the browser about 70% of the testing workbench at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: clockStart });
    await page.goto(`${baseUrl}/host?scenario=activity-closed-hold`);
    // Polls advance only with runFor, one status check per two seconds.
    await page.clock.pauseAt(clockPaused);
    const setup = page.frameLocator("iframe");
    await completeToTest(setup);
    await setup.getByRole("button", { name: "Run test" }).click();
    await expect(setup.getByRole("region", { name: "Agent browser", exact: true }).getByText("Opening the virtual browser.")).toBeVisible();
  // The first status check runs as soon as the test starts; later ones need the clock.
  await expect(setup.getByRole("region", { name: "Agent browser", exact: true }).getByText("Opening the virtual browser.")).toBeVisible();
    await page.clock.runFor(2_000);
    const browser = (await setup.getByRole("region", { name: "Agent browser", exact: true }).boundingBox())!;
    const rail = (await setup.getByRole("complementary", { name: "Test steps" }).boundingBox())!;
    const share = browser.width / (browser.width + rail.width);
    expect(share).toBeGreaterThan(0.6);
    expect(share).toBeLessThan(0.76);
    expect(Math.abs(browser.y - rail.y)).toBeLessThan(2);
    await page.screenshot({ path: `e2e-artifacts/test-activity-${width}.png` });
  });
}

test("stacks the browser above the activity on a narrow screen without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 900 });
  await page.clock.install({ time: clockStart });
  await page.goto(`${baseUrl}/host?scenario=activity-closed-hold`);
  // Polls advance only with runFor, one status check per two seconds.
  await page.clock.pauseAt(clockPaused);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  // The first status check runs as soon as the test starts; later ones need the clock.
  await expect(setup.getByRole("region", { name: "Agent browser", exact: true }).getByText("Opening the virtual browser.")).toBeVisible();
  for (let poll = 0; poll < 4; poll += 1) await page.clock.runFor(2_000);
  const browser = (await setup.getByRole("region", { name: "Agent browser", exact: true }).boundingBox())!;
  const rail = (await setup.getByRole("complementary", { name: "Test steps" }).boundingBox())!;
  expect(rail.y).toBeGreaterThanOrEqual(browser.y + browser.height - 1);
  const dimensions = await setup.locator("body").evaluate((body) => ({ width: body.scrollWidth, viewport: innerWidth }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
  await page.screenshot({ path: "e2e-artifacts/test-activity-narrow.png", fullPage: true });
});

test("edit: tests changes in the same workbench and keeps the last test on screen after an edit", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.goto(`${baseUrl}/host?scenario=edit-activity-success`);
  // Polls advance only with runFor, one status check per two seconds.
  await page.clock.pauseAt(clockPaused);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Step 1 description").fill("Open the reports page");
  await setup.getByRole("button", { name: "Test changes" }).click();
  const workbench = setup.getByRole("region", { name: "Test run" });
  const browser = workbench.getByRole("region", { name: "Agent browser", exact: true });
  const activity = workbench.getByRole("log", { name: "Agent activity" });
  await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toBeVisible();
  const browserBox = (await browser.boundingBox())!;
  const railBox = (await workbench.getByRole("complementary", { name: "Test activity" }).boundingBox())!;
  const share = browserBox.width / (browserBox.width + railBox.width);
  expect(share).toBeGreaterThan(0.6);
  expect(share).toBeLessThan(0.76);
  await page.screenshot({ path: "e2e-artifacts/edit-activity-live.png" });
  for (let poll = 0; poll < 3; poll += 1) await page.clock.runFor(2_000);
  await expect(browser.getByText("Agent closed the browser")).toBeVisible();
  await expect(setup.getByRole("status").filter({ hasText: "Test is running." })).toBeVisible();
  await expect(setup.locator("iframe")).toHaveCount(0);
  await expect(setup.getByRole("link", { name: "Watch the test" })).toHaveCount(0);
  await page.screenshot({ path: "e2e-artifacts/edit-activity-closed.png" });
  await page.clock.runFor(2_000);
  await expect(setup.getByText("Test completed", { exact: true })).toBeVisible();
  await expect(browser.getByRole("img", { name: "Agent browser screen" })).toBeVisible();
  await expect(activity.getByText("Browser closed")).toBeVisible();
  await expect(browser.getByText("The page when the test passed.")).toBeVisible();
  await setup.getByLabel("Goal", { exact: true }).fill("Download the October statement.");
  await expect(workbench.getByText("Changed since this test")).toBeVisible();
  await expect(activity.getByText("Browser closed")).toBeVisible();
  // The kept run still passed; only the draft is newer than it.
  await expect(browser.getByText("The page when the test passed.")).toBeVisible();
  await expect(browser.getByText("The page when the test stopped.")).toHaveCount(0);
});

for (const width of [1440, 1024]) {
  test(`edit: keeps the test action on screen while the test runs and after it fails at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: clockStart });
    await page.goto(`${baseUrl}/host?scenario=edit-activity-website-failure`);
    // Polls advance only with runFor, one status check per two seconds.
    await page.clock.pauseAt(clockPaused);
    const setup = page.frameLocator("iframe");
    const workbench = setup.getByRole("region", { name: "Test run" });
    const browser = workbench.getByRole("region", { name: "Agent browser", exact: true });
    // On screen means inside the 900 px viewport with the page still at the top, so nobody had to scroll.
    const expectOnScreen = async (name: string): Promise<void> => {
      const box = (await setup.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      expect(await setup.locator("html").evaluate((element) => element.scrollTop)).toBe(0);
    };

    await expectOnScreen("Test changes");
    await setup.getByRole("button", { name: "Test changes", exact: true }).click();
    await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
    await expect(setup.getByRole("button", { name: "Test changes", exact: true })).toBeDisabled();
    // The card moved into the workbench with the pressed button; focus moved with it.
    await expect(setup.getByRole("heading", { name: "Test & publish" })).toBeFocused();
    await expectOnScreen("Test changes");
    await expectOnScreen("Publish changes");

    await page.clock.runFor(2_000);
    await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toBeVisible();
    await expect(setup.getByRole("status").filter({ hasText: "Test is running." })).toBeVisible();
    await expectOnScreen("Test changes");
    const browserBox = (await browser.boundingBox())!;
    const railBox = (await workbench.getByRole("complementary", { name: "Test activity" }).boundingBox())!;
    if (width === 1440) {
      const share = browserBox.width / (browserBox.width + railBox.width);
      expect(share).toBeGreaterThan(0.6);
      expect(share).toBeLessThan(0.76);
    }
    expect(railBox.width).toBeGreaterThanOrEqual(359);
    expect(Math.abs(browserBox.y - railBox.y)).toBeLessThan(2);
    await expect(setup.locator("iframe")).toHaveCount(0);

    for (let poll = 0; poll < 4; poll += 1) await page.clock.runFor(2_000);
    await expect(setup.getByText("Test failed", { exact: true })).toBeVisible();
    await expect(setup.getByText("Website problem", { exact: true })).toBeVisible();
    await expect(browser.getByText("The page when the test stopped.")).toBeVisible();
    await expect(workbench.getByRole("log", { name: "Agent activity" }).getByText("Browser closed")).toBeVisible();
    await expect(setup.getByRole("button", { name: "Run test again", exact: true })).toBeEnabled();
    await expectOnScreen("Run test again");
    await expectOnScreen("Publish changes");
    await expect(setup.locator("iframe")).toHaveCount(0);
    expect(await setup.locator("html").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `e2e-artifacts/edit-action-visible-${width}.png` });
  });

  test(`edit: keeps the page at the top with Close visible when a failed test runs again at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: clockStart });
    await page.goto(`${baseUrl}/host?scenario=edit-activity-website-failure`);
    // Polls advance only with runFor, one status check per two seconds.
    await page.clock.pauseAt(clockPaused);
    const setup = page.frameLocator("iframe");
    const browser = setup.getByRole("region", { name: "Test run" }).getByRole("region", { name: "Agent browser", exact: true });
    // The retry starts from inside the workbench, so the page must stay where it was: at the top, Close and the action on screen.
    const expectAtTop = async (action: string): Promise<void> => {
      expect(await setup.locator("html").evaluate((element) => element.scrollTop)).toBe(0);
      for (const name of ["Close edit page", action]) {
        const box = (await setup.getByRole("button", { name, exact: true }).boundingBox())!;
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(900);
      }
    };

    await setup.getByRole("button", { name: "Test changes", exact: true }).click();
    // The first status check runs as soon as the test starts; later ones need the clock.
    await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
    for (let poll = 0; poll < 5; poll += 1) await page.clock.runFor(2_000);
    await expect(setup.getByText("Test failed", { exact: true })).toBeVisible();
    await expectAtTop("Run test again");

    await setup.getByRole("button", { name: "Run test again", exact: true }).click();
    await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
    await expect(setup.getByRole("button", { name: "Test changes", exact: true })).toBeDisabled();
    await expectAtTop("Test changes");
    await page.clock.runFor(2_000);
    await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toBeVisible();
    await expectAtTop("Test changes");
    for (let poll = 0; poll < 4; poll += 1) await page.clock.runFor(2_000);
    await expect(setup.getByText("Test failed", { exact: true })).toBeVisible();
    await expect(browser.getByText("The page when the test stopped.")).toBeVisible();
    await expectAtTop("Run test again");
  });
}

// Shorter than the workbench, whose top is still on screen: scrolling it "into view" would move the page 72 px and hide Close.
test("edit: does not scroll an on-screen workbench when a test starts or runs again", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 450 });
  await page.clock.install({ time: clockStart });
  await page.goto(`${baseUrl}/host?scenario=edit-activity-website-failure`);
  // Polls advance only with runFor, one status check per two seconds.
  await page.clock.pauseAt(clockPaused);
  const setup = page.frameLocator("iframe");
  const browser = setup.getByRole("region", { name: "Test run" }).getByRole("region", { name: "Agent browser", exact: true });
  const expectAtTop = async (): Promise<void> => {
    expect(await setup.locator("html").evaluate((element) => element.scrollTop)).toBe(0);
    const close = (await setup.getByRole("button", { name: "Close edit page" }).boundingBox())!;
    expect(close.y).toBeGreaterThanOrEqual(0);
  };

  await setup.getByRole("button", { name: "Test changes", exact: true }).click();
  await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
  await expectAtTop();
  for (let poll = 0; poll < 5; poll += 1) await page.clock.runFor(2_000);
  await expect(setup.getByText("Test failed", { exact: true })).toBeVisible();
  await expectAtTop();
  // A plain click event, so Playwright does not scroll the button into view first.
  await setup.getByRole("button", { name: "Run test again", exact: true }).dispatchEvent("click");
  await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
  await expectAtTop();
});

test("edit: brings the workbench into view when a test starts after scrolling away", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.clock.install({ time: clockStart });
  await page.goto(`${baseUrl}/host?scenario=edit-activity-website-failure`);
  // Polls advance only with runFor, one status check per two seconds.
  await page.clock.pauseAt(clockPaused);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Changes" })).toBeVisible();
  await setup.locator("html").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await setup.locator("html").evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await setup.getByRole("button", { name: "Test changes", exact: true }).click();
  const workbench = setup.getByRole("region", { name: "Test run" });
  await expect(workbench.getByText("Opening the virtual browser.")).toBeVisible();
  const box = (await workbench.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeLessThan(500);
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
  const screenBar = setup.getByRole("group", { name: "Screens" });
  await expect(screenBar.getByText("2 / 2")).toBeVisible();
  await setup.getByRole("button", { name: "Previous screen" }).click();
  await expect(screenBar.getByText("1 / 2")).toBeVisible();
  await expect(setup.getByText("Earlier screen", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Next screen" }).click();
  await expect(setup.getByText("Final screen", { exact: true })).toBeVisible();
  await expect(setup.locator("body")).not.toContainText("I opened Reports.");
  await expect(setup.locator("body")).not.toContainText("I looked for the export button.");
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

for (const mode of ["create", "edit"]) {
  for (const outcome of ["connected", "cancel", "old-host"]) {
    test(`${mode} Google failure handles ${outcome}`, async ({ page }) => {
      await page.goto(`${baseUrl}/host?scenario=${mode === "edit" ? "edit-" : ""}google-${outcome}`);
      const setup = page.frameLocator("iframe");
      if (mode === "create") await completeToTest(setup);
      await setup.getByRole("button", { name: mode === "edit" ? "Test changes" : "Run test" }).click();
      const result = setup.locator(mode === "edit" ? ".edit-result-failed" : ".run-status");
      await expect(result).toContainText("Google sign-in needed");
      await expect(result).toContainText("The agent needs a Google sign-in");
      await expect(result).toContainText("Connect the Google account this website uses, then run the test again.");
      await expect(result).not.toContainText("Change sign-in details");
      await expect(result.getByRole("button", { name: "Set up Google sign-in" })).toHaveCount(0);
      if (mode === "create") await expect(setup.locator(".test-step.failed")).toHaveCount(1);
      if (outcome === "old-host") {
        await expect(result).toContainText("Open Credentials → Connect Google for this agent.");
        await expect(result.getByRole("button", { name: "Connect Google" })).toHaveCount(0);
        return;
      }
      if (outcome === "connected") {
        if (mode === "edit") await result.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `e2e-artifacts/google-failure-${mode}.png` });
      }
      await result.getByRole("button", { name: "Connect Google" }).click();
      await expect.poll(() => page.evaluate(() => window.__googleRequests)).toEqual([{ agentId: "agent-1" }]);
      if (outcome === "connected") {
        if (mode === "create") {
          await expect(setup.getByText("Changes require a new test.")).toBeVisible();
          await expect(result).toContainText("Not tested yet");
        } else {
          await expect(setup.getByText("Changed since this test")).toBeVisible();
          await expect(result).toHaveCount(0);
        }
      } else {
        await expect(result).toContainText("Google sign-in needed");
        await expect(setup.getByText(mode === "edit" ? "Changed since this test" : "Changes require a new test.")).toHaveCount(0);
      }
    });
  }
}

for (const mode of ["create", "edit"]) {
  for (const outcome of ["saved", "cancel"]) {
    test(`${mode} Google failure on a host with the Google sign-in dialog handles ${outcome}`, async ({ page }) => {
      await page.goto(`${baseUrl}/host?scenario=${mode === "edit" ? "edit-" : ""}google-signin-${outcome}`);
      const setup = page.frameLocator("iframe");
      if (mode === "create") await completeToTest(setup);
      await setup.getByRole("button", { name: mode === "edit" ? "Test changes" : "Run test" }).click();
      const result = setup.locator(mode === "edit" ? ".edit-result-failed" : ".run-status");
      await expect(result).toContainText("The agent needs a Google sign-in");
      // The host's message, once: not repeated as what the agent said.
      await expect(result.getByText("Set up the Google sign-in with an authenticator key, then run the test again.")).toHaveCount(1);
      await expect(result).not.toContainText("Connect the Google account this website uses");
      await expect(result.getByRole("button", { name: "Connect Google" })).toHaveCount(0);
      const setUp = result.getByRole("button", { name: "Set up Google sign-in" });
      await expect(setUp).toHaveClass(/button-primary/);
      if (outcome === "saved") {
        await googleShots(page, `test-result-${mode}`, result);
      }
      await setUp.click();
      await expect.poll(() => page.evaluate(() => window.__googleSignInRequests)).toEqual([{ method: "setUpGoogleSignIn", params: { reason: "test" } }]);
      expect(await page.evaluate(() => window.__googleRequests)).toEqual([]);
      if (outcome === "saved") {
        if (mode === "create") {
          await expect(setup.getByText("Changes require a new test.")).toBeVisible();
          await expect(result).toContainText("Not tested yet");
        } else {
          await expect(setup.getByText("Changed since this test")).toBeVisible();
          await expect(result).toHaveCount(0);
        }
      } else {
        await expect(result).toContainText("Google sign-in needed");
        await expect(setup.getByText(mode === "edit" ? "Changed since this test" : "Changes require a new test.")).toHaveCount(0);
      }
    });
  }
}

const googleSignInPanelBody = "You signed in with Google during the demonstration. Google asks for a verification code every time the agent signs in, so the agent needs your Google password and an authenticator key. It takes about two minutes.";
const googleSignInSkipNote = "Test runs will stop at Google's verification until the Google sign-in is set up.";

test("offers the Google sign-in setup in Review after a demonstration that signed in with Google", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=google-demo-missing`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);
  const panel = setup.getByRole("region", { name: "Finish the Google sign-in setup" });
  await expect(panel).toContainText(googleSignInPanelBody);
  await expect(panel.getByRole("button", { name: "Skip for now" })).toBeVisible();
  // The offer sits at the top of Review, above the steps.
  const panelBox = await panel.boundingBox();
  const stepBox = await setup.getByLabel("Step 1 description").boundingBox();
  expect(panelBox!.y).toBeLessThan(stepBox!.y);
  await googleShots(page, "panel", panel);
  await panel.getByRole("button", { name: "Set up Google sign-in" }).click();
  await expect(panel).toHaveCount(0);
  await expect(setup.getByText(googleSignInSkipNote)).toHaveCount(0);
  expect(await page.evaluate(() => window.__googleSignInRequests)).toEqual([
    { method: "getGoogleSignIn", params: {} },
    { method: "setUpGoogleSignIn", params: { reason: "demonstration" } },
  ]);
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(setup.getByRole("button", { name: "Run test" })).toBeVisible();
});

for (const [scenario, action] of [["google-demo-missing", "Skip for now"], ["google-demo-needs", "Set up Google sign-in"]]) {
  test(`${scenario === "google-demo-needs" ? "cancelling" : "skipping"} the Google sign-in setup leaves the skip note and keeps setup moving`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    await describeAndDemonstrate(setup);
    await setup.getByRole("button", { name: action }).click();
    const note = setup.getByRole("status").filter({ hasText: googleSignInSkipNote });
    await expect(note).toHaveText(googleSignInSkipNote);
    await expect(note).toBeFocused();
    await expect(setup.getByRole("region", { name: "Finish the Google sign-in setup" })).toHaveCount(0);
    if (scenario === "google-demo-missing") await googleShots(page, "skip-note", note);
    await setup.getByRole("button", { name: "Continue to test" }).click();
    await expect(setup.getByRole("button", { name: "Run test" })).toBeVisible();
  });
}

for (const [scenario, requests] of [["google-demo-ready", [{ method: "getGoogleSignIn", params: {} }]], ["google-demo-signedout", []], ["google-demo-nocap", []]] as const) {
  test(`shows no Google sign-in offer for ${scenario}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    await describeAndDemonstrate(setup);
    await expect(setup.getByLabel("Step 1 description")).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__googleSignInRequests)).toEqual(requests);
    await expect(setup.getByText("Finish the Google sign-in setup")).toHaveCount(0);
    await expect(setup.getByText(googleSignInSkipNote)).toHaveCount(0);
  });
}

test("edit re-demonstration that signed in with Google offers the Google sign-in setup", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-google-demo-missing`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Re-demonstrate" }).click();
  await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
  const panel = setup.getByRole("region", { name: "Finish the Google sign-in setup" });
  await expect(panel).toContainText(googleSignInPanelBody);
  await googleShots(page, "panel-edit", panel);
  await panel.getByRole("button", { name: "Skip for now" }).click();
  await expect(setup.getByRole("status").filter({ hasText: googleSignInSkipNote })).toBeFocused();
  expect(await page.evaluate(() => window.__googleSignInRequests)).toEqual([{ method: "getGoogleSignIn", params: {} }]);
});

test("saving the Google sign-in from the Review offer after a test requires a new test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=google-demo-missing`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);
  const panel = setup.getByRole("region", { name: "Finish the Google sign-in setup" });
  await expect(panel).toBeVisible();
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await setup.getByRole("button", { name: "Run test" }).click();
  const result = setup.locator(".run-status");
  await expect(result).toContainText("Google sign-in needed");
  await setup.getByRole("button", { name: "Back to review" }).click();
  await panel.getByRole("button", { name: "Set up Google sign-in" }).click();
  await expect(panel).toHaveCount(0);
  // The offer is gone; focus moves to the Review heading instead of falling back to the page.
  await expect(setup.getByRole("heading", { name: "Review and complete the setup" })).toBeFocused();
  await expect(setup.getByText("Changes require a new test.")).toBeVisible();
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(result).toContainText("Not tested yet");
});

test("Google sign-in offer appears when the demonstration's stop is seen by polling", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=google-demo-polled`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  // No Finish: the next read reports the demonstration stopped.
  await setup.getByRole("button", { name: "Continue to review" }).click();
  await expect(setup.getByRole("region", { name: "Finish the Google sign-in setup" })).toBeVisible();
  await setup.getByRole("button", { name: "Skip for now" }).click();
  await expect(setup.getByRole("status").filter({ hasText: googleSignInSkipNote })).toBeVisible();
  // Organizing reads and returning to Review don't ask again after Skip.
  await setup.getByRole("button", { name: "Back to demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();
  await expect(setup.getByRole("status").filter({ hasText: googleSignInSkipNote })).toBeVisible();
  expect(await page.evaluate(() => window.__googleSignInRequests)).toEqual([{ method: "getGoogleSignIn", params: {} }]);
});

test("edit Google sign-in offer appears when the re-demonstration's stop is seen by polling", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-google-demo-polled`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Re-demonstrate" }).click();
  await expect(setup.getByRole("region", { name: "Finish the Google sign-in setup" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Finish re-demonstration" })).toHaveCount(0);
  expect(await page.evaluate(() => window.__googleSignInRequests)).toEqual([{ method: "getGoogleSignIn", params: {} }]);
});

test("Review opens without a Google sign-in offer when the host can't report the Google sign-in", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=google-demo-error`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);
  await expect(setup.getByLabel("Step 1 description")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__googleSignInRequests)).toEqual([{ method: "getGoogleSignIn", params: {} }]);
  await expect(setup.getByText("Finish the Google sign-in setup")).toHaveCount(0);
  await expect(setup.getByText(googleSignInSkipNote)).toHaveCount(0);
  await expect(setup.getByRole("alert")).toHaveCount(0);
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(setup.getByRole("button", { name: "Run test" })).toBeVisible();
});

for (const outcome of ["offer", "skip note"]) {
  test(`a new edit re-demonstration clears the earlier Google sign-in ${outcome}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=edit-google-demo-missing`);
    const setup = page.frameLocator("iframe");
    await setup.getByRole("button", { name: "Re-demonstrate" }).click();
    await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
    const panel = setup.getByRole("region", { name: "Finish the Google sign-in setup" });
    await expect(panel).toBeVisible();
    if (outcome === "skip note") await panel.getByRole("button", { name: "Skip for now" }).click();
    await setup.getByRole("button", { name: "Re-demonstrate" }).click();
    await expect(setup.getByRole("button", { name: "Finish re-demonstration" })).toBeVisible();
    await expect(panel).toHaveCount(0);
    await expect(setup.getByText(googleSignInSkipNote)).toHaveCount(0);
    // The next demonstration is checked on its own.
    await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
    await expect(panel).toBeVisible();
    expect(await page.evaluate(() => window.__googleSignInRequests)).toEqual([{ method: "getGoogleSignIn", params: {} }, { method: "getGoogleSignIn", params: {} }]);
  });
}

test("a create demonstration after Start over doesn't keep the earlier Google sign-in skip note", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=google-demo-polled`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();
  await setup.getByRole("button", { name: "Skip for now" }).click();
  await setup.getByRole("button", { name: "Back to demonstration" }).click();
  await setup.getByRole("button", { name: "Start over" }).click();
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();
  // A fresh offer for the new demonstration, not the skip note from the last one.
  await expect(setup.getByRole("region", { name: "Finish the Google sign-in setup" })).toBeVisible();
  await expect(setup.getByText(googleSignInSkipNote)).toHaveCount(0);
});

test("edit saving the Google sign-in from the offer after a test requires a new test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-google-demo-missing`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Re-demonstrate" }).click();
  await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
  const panel = setup.getByRole("region", { name: "Finish the Google sign-in setup" });
  await expect(panel).toBeVisible();
  await setup.getByRole("button", { name: "Test changes" }).click();
  const result = setup.locator(".edit-result-failed");
  await expect(result).toContainText("Google sign-in needed");
  await panel.getByRole("button", { name: "Set up Google sign-in" }).click();
  await expect(panel).toHaveCount(0);
  await expect(setup.getByText(googleSignInSkipNote)).toHaveCount(0);
  await expect(setup.getByRole("heading", { name: "Steps", exact: true })).toBeFocused();
  await expect(setup.getByText("Changed since this test")).toBeVisible();
  await expect(result).toHaveCount(0);
  expect(await page.evaluate(() => window.__googleSignInRequests)).toEqual([
    { method: "getGoogleSignIn", params: {} },
    { method: "setUpGoogleSignIn", params: { reason: "demonstration" } },
  ]);
});

test("edit cancelling the Google sign-in setup leaves the skip note and keeps the test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-google-demo-needs`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Re-demonstrate" }).click();
  await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
  await setup.getByRole("button", { name: "Test changes" }).click();
  const result = setup.locator(".edit-result-failed");
  await expect(result).toContainText("Google sign-in needed");
  await setup.getByRole("region", { name: "Finish the Google sign-in setup" }).getByRole("button", { name: "Set up Google sign-in" }).click();
  await expect(setup.getByRole("status").filter({ hasText: googleSignInSkipNote })).toBeFocused();
  await expect(result).toContainText("Google sign-in needed");
  await expect(setup.getByText("Changed since this test")).toHaveCount(0);
});

for (const [scenario, requests] of [["edit-google-demo-ready", [{ method: "getGoogleSignIn", params: {} }]], ["edit-google-demo-signedout", []], ["edit-google-demo-nocap", []]] as const) {
  test(`shows no Google sign-in offer for ${scenario}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    await setup.getByRole("button", { name: "Re-demonstrate" }).click();
    await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
    await expect(setup.getByRole("button", { name: "Re-demonstrate" })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => window.__googleSignInRequests)).toEqual(requests);
    await expect(setup.getByText("Finish the Google sign-in setup")).toHaveCount(0);
    await expect(setup.getByText(googleSignInSkipNote)).toHaveCount(0);
  });
}

for (const mode of ["create", "edit"]) {
  test(`${mode} shows the opening-window overlay without removing the browser`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${mode === "edit" ? "edit-" : ""}window-switch`);
    const setup = page.frameLocator("iframe");
    if (mode === "create") {
      await setup.getByLabel("Agent name").fill("Download statement");
      await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
      await setup.getByLabel("What should the agent do?").fill("Download the statement.");
      await setup.getByRole("button", { name: "Continue to demonstration" }).click();
    } else await setup.getByRole("button", { name: "Re-demonstrate", exact: true }).click();
    const frame = setup.locator(mode === "edit" ? ".edit-recording" : ".demonstrate .browser-frame");
    await expect(frame.getByRole("status")).toHaveText("Opening the new window…");
    await expect(frame.locator("iframe[title='Virtual browser']")).toBeAttached();
    if (mode === "create") await page.screenshot({ path: "e2e-artifacts/opening-window-overlay.png" });
    await page.evaluate(() => { window.__liveViewSwitching = false; });
    await expect(frame.getByRole("status")).toHaveCount(0);
    await expect(frame.locator("iframe[title='Virtual browser']")).toBeAttached();
  });
}

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

test("pages through finished screens with fixed labels and never shows the agent's notes", async ({ page }) => {
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
  const notes = /Opened Reports|Confirming the download|Opening the reports|Checking the date filter|Click · Type|\{/;
  await expect(bar.locator(".caption-kind")).toHaveText("Final screen");
  await expect(bar.getByText("3 / 3")).toBeVisible();
  await expect(bar).not.toContainText(notes);
  await expect(bar.getByRole("button", { name: "More" })).toHaveCount(0);
  await page.screenshot({ path: "e2e-artifacts/test-final-screen.png" });

  await bar.getByRole("button", { name: "Previous screen" }).click();
  await expect(bar.locator(".caption-kind")).toHaveText("Earlier screen");
  await expect(bar.getByText("2 / 3")).toBeVisible();
  await expect(bar).not.toContainText(notes);

  await bar.getByRole("button", { name: "Previous screen" }).click();
  await page.setViewportSize({ width: 480, height: 900 });
  expect((await bar.boundingBox())?.height ?? 0).toBeLessThan(56);
  await expect(bar.getByRole("button", { name: "Next screen" })).toBeInViewport();
  await page.screenshot({ path: "e2e-artifacts/test-final-screen-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(bar.getByRole("button", { name: "Previous screen" })).toBeDisabled();
  await expect(setup.locator("body")).not.toContainText(notes);
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
  if (!process.env.CI) {
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots2/review-typed-1440.png" });
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots2/review-typed-1024.png" });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
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

  await describeAndDemonstrate(setup);
  if (!process.env.CI) {
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots2/review-credential-1440.png" });
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.screenshot({ path: "/Users/joonatan/.hermes/cache/scratch/date-steps/shots2/review-credential-1024.png" });
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  await setup.getByRole("button", { name: "Continue to test" }).click();
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

test("keeps the instruction when a field with a recorded selector becomes a saved sign-in field and back", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=hidden-field-target`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);
  const instruction = setup.getByLabel("Step 2 description");
  const kind = setup.getByLabel("Step 2 field type");

  await kind.selectOption("username");
  await expect(instruction).toHaveValue("Enter Email");
  await kind.selectOption("");
  await expect(instruction).toHaveValue("Enter Email");
  await kind.selectOption("username");
  await expect(instruction).toHaveValue("Enter Email");
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(setup.getByRole("heading", { name: "Verify agent can follow the process" })).toBeVisible();
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  const saved = JSON.stringify(await page.evaluate(() => window.__savedAgents));
  expect(saved).toContain("Enter Email: type exactly $username into the sign-in field.");
  expect(saved).not.toContain("saved username in input[");
});

test("edit: keeps the instruction when a field with a recorded selector switches to a saved sign-in field and back", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-hidden-field-target`);
  const setup = page.frameLocator("iframe");
  const instruction = setup.getByLabel("Step 2 description");
  const kind = setup.getByLabel("Step 2 field type");

  await kind.selectOption("username");
  await expect(instruction).toHaveValue("Enter Email");
  await kind.selectOption("");
  await expect(instruction).toHaveValue("Enter Email");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await expect(setup.getByRole("alert").filter({ hasText: "Go to step" })).toHaveCount(0);
  const prompt = (await page.evaluate(() => window.__savedAgents)).at(-1).config.stages[0].prompt;
  expect(prompt).toContain("2. Enter Email: clear the field so it is empty.");
  expect(prompt).not.toContain("input[");
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
  formats.push(await expectStage("Review and complete the setup"));
  await setup.getByRole("button", { name: "Continue to test" }).click();
  // The test stage keeps its explanation behind a (?) next to the heading.
  const testFormat = await expectStage("Verify agent can follow the process");
  expect(formats[1].left).toBe(24);
  expect(formats[2].font).toBe(formats[0].font);
  expect(formats[2].top).toBe(formats[0].top);
  expect(formats[2].descriptionGap).toBe(formats[0].descriptionGap);
  expect(formats[2].descriptionLeft).toBe(formats[0].descriptionLeft);
  expect(testFormat.left).toBe(24);
});

test("centres the create-flow content under the stepper at desktop widths", async ({ page }) => {
  for (const width of [1440, 1200, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseUrl}/host?scenario=success`);
    const setup = page.frameLocator("iframe");
    const measure = async () => setup.locator("body").evaluate(() => {
      const content = document.querySelector(".setup-content")!.getBoundingClientRect();
      const panel = document.querySelector(".setup-panel")!.getBoundingClientRect();
      const progress = document.querySelector(".setup-progress")!.getBoundingClientRect();
      const heading = document.querySelector(".stage-title h2")!.getBoundingClientRect();
      return { contentOffset: Math.abs(content.left + content.width / 2 - innerWidth / 2), panelOffset: Math.abs(panel.left + panel.width / 2 - progress.left - progress.width / 2), headingLeft: heading.left, contentLeft: content.left };
    });
    const describe = await measure();
    expect(describe.contentOffset).toBeLessThan(2);
    expect(describe.panelOffset).toBeLessThan(2);
    expect(describe.headingLeft).toBeGreaterThan(describe.contentLeft);
    await setup.getByLabel("Agent name").fill("Download monthly statement");
    await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
    await setup.getByLabel("What should the agent do?").fill("Download the monthly statement.");
    await setup.getByRole("button", { name: "Continue to demonstration" }).click();
    await setup.getByRole("button", { name: "Finish demonstration" }).click();
    await setup.getByRole("button", { name: "Continue to review" }).click();
    const review = await measure();
    expect(review.contentOffset).toBeLessThan(2);
    expect(review.panelOffset).toBeLessThan(2);
  }
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
  // Publishing clears the test, so the card returns to the rail and keeps focus.
  await expect(setup.getByRole("heading", { name: "Test & publish" })).toBeFocused();
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
  await expect(setup.getByRole("link", { name: "Watch the test" })).toHaveCount(0);
  await expect(setup.locator("iframe")).toHaveCount(0);
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

test("points a step error at the current step, goes to it, and clears it once the step is rewritten", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=selector-step`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);

  await setup.getByRole("button", { name: "Continue to test" }).click();
  const alert = setup.getByRole("alert").filter({ hasText: "Go to step" });
  await expect(alert).toHaveText("Step 3: Rewrite the instruction using what the control shows on screen, not a selector or screen coordinates.Go to step");
  await expect(setup.getByRole("heading", { name: "Review and complete the setup" })).toBeVisible();
  const instruction = setup.getByLabel("Step 3 description");
  await expect(instruction).toHaveAttribute("aria-invalid", "true");
  await expect(instruction).toHaveAccessibleDescription(/^Step 3: Rewrite the instruction/);
  await expect(setup.locator(".review-step.step-invalid")).toHaveCount(1);
  await expect(setup.getByLabel("Step 2 description")).not.toHaveAttribute("aria-invalid", "true");

  await alert.getByRole("button", { name: "Go to step" }).click();
  await expect(instruction).toBeFocused();
  await expect(instruction).toBeInViewport();

  await instruction.fill("Click Export");
  await expect(alert).toHaveCount(0);
  await expect(instruction).not.toHaveAttribute("aria-invalid", "true");
  await expect(setup.locator(".step-invalid")).toHaveCount(0);
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(setup.getByRole("heading", { name: "Verify agent can follow the process" })).toBeVisible();
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("The agent completed every step")).toBeVisible();
  const prompt = (await page.evaluate(() => window.__savedAgents)).at(-1).config.stages[0].prompt;
  expect(prompt).toContain("2. Click the account selector.");
  expect(prompt).not.toContain("#account");
});

test("removing the step a validation error is about clears the error and focuses the next step", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=selector-step`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(setup.getByRole("alert").filter({ hasText: "Go to step" })).toBeVisible();
  await setup.getByRole("button", { name: "Remove step 3", exact: true }).click();
  await expect(setup.getByRole("alert")).toHaveCount(0);
  await expect(setup.getByLabel("Step 3 description")).toHaveValue("Download the statement");
  await expect(setup.getByLabel("Step 3 description")).toBeFocused();
  await expect(setup.locator("[aria-invalid=\"true\"]")).toHaveCount(0);
});

test("sends a step error found on Test back to that step in Review", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=step-failure`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Stuck at step 2")).toBeVisible();
  await setup.getByLabel("Step 2 instruction").fill("Click #export > button");
  await setup.getByRole("button", { name: "Run test again" }).click();
  const alert = setup.getByRole("alert").filter({ hasText: "Go to step" });
  await expect(alert).toHaveText("Step 2: Rewrite the instruction using what the control shows on screen, not a selector or screen coordinates.Go to step");
  expect(await page.evaluate(() => window.__testArguments)).toHaveLength(1);

  await alert.getByRole("button", { name: "Go to step" }).click();
  await expect(setup.getByRole("heading", { name: "Review and complete the setup" })).toBeVisible();
  const instruction = setup.getByLabel("Step 2 description");
  await expect(instruction).toBeFocused();
  await expect(instruction).toHaveValue("Click #export > button");
  await expect(instruction).toHaveAttribute("aria-invalid", "true");
});

test("edit: names the current step for a validation error, goes to it, and clears it when the step is removed", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-selector-step`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Test changes" }).click();
  const alert = setup.getByRole("alert").filter({ hasText: "Go to step" });
  await expect(alert).toHaveText("Step 3: Rewrite the instruction using what the control shows on screen, not a selector or screen coordinates.Go to step");
  expect(await page.evaluate(() => window.__savedAgents)).toEqual([]);
  const instruction = setup.getByLabel("Step 3 description");
  await expect(instruction).toHaveAttribute("aria-invalid", "true");
  await expect(instruction).toHaveAccessibleDescription(/^Step 3: Rewrite the instruction/);
  await expect(setup.locator(".edit-step.step-invalid")).toHaveCount(1);

  await alert.getByRole("button", { name: "Go to step" }).click();
  await expect(instruction).toBeFocused();
  await expect(instruction).toBeInViewport();

  await setup.getByRole("button", { name: "Remove step 3", exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(setup.getByLabel("Step 3 description")).toHaveValue("Download the statement");
  await expect(setup.getByLabel("Step 3 description")).toBeFocused();
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  const prompt = (await page.evaluate(() => window.__savedAgents)).at(-1).config.stages[0].prompt;
  expect(prompt).toContain("2. Click the account selector.");
  expect(prompt).not.toContain("#account");
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
  const alert = setup.getByRole("alert");
  await expect(alert).toHaveText("Step 3: Add an instruction for this step.Go to step");
  await expect(instruction).toHaveAttribute("aria-invalid", "true");
  await expect(instruction).toHaveAccessibleDescription("Step 3: Add an instruction for this step.");
  await expect(setup.locator(".edit-step.step-invalid")).toHaveCount(1);
  expect(await page.evaluate(() => window.__savedAgents)).toEqual([]);
  expect(await page.evaluate(() => window.__testArguments)).toEqual([]);
  await alert.getByRole("button", { name: "Go to step" }).click();
  await expect(instruction).toBeFocused();
  await expect(instruction).toBeInViewport();
  await instruction.fill("Open the downloaded file");
  await expect(alert).toHaveCount(0);
  await expect(instruction).not.toHaveAttribute("aria-invalid", "true");
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
  await expect(thumbnail.getByRole("img")).toHaveAttribute("alt", "Final screen");
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

test("saves sign-in details with the same kinds, invalidates the test, and requires a fresh checked test to publish", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-raw-credentials-save`);
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
  await expect(setup.getByRole("button", { name: "Publish changes" })).toHaveAccessibleDescription("Test your changes before publishing.");
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

for (const scenario of ["edit-credentials-cancel", "edit-credentials-legacy-same", "edit-credentials-legacy-reordered"]) {
  test(`keeps changes and a checked test intact for ${scenario}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    const card = setup.getByRole("region", { name: "Sign-in details" });
    const change = card.getByRole("button", { name: "Change sign-in details", exact: true });
    const publish = setup.getByRole("button", { name: "Publish changes" });
    await change.click();
    await expect(change).toBeEnabled();
    await expect(card.locator("li")).toHaveText(["Username · saved", "Password · saved"]);
    await expect(card.getByRole("status")).toHaveCount(0);
    await expect(setup.getByText("Sign-in details: updated", { exact: true })).toHaveCount(0);
    await expect(setup.getByText("No changes yet.", { exact: true })).toBeVisible();
    await expect(setup.locator(".edit-changes").getByRole("status")).toHaveText("No unpublished changes");
    await expect(publish).toBeDisabled();
    await expect(publish).toHaveAccessibleDescription("Make a change to publish.");

    await setup.getByRole("button", { name: "Test changes" }).click();
    await setup.getByLabel("I checked the result").check();
    await change.click();
    await expect(change).toBeEnabled();
    await expect(setup.getByText("Test completed", { exact: true })).toBeVisible();
    await expect(setup.getByLabel("I checked the result")).toBeChecked();
    await expect(setup.getByText("No changes yet.", { exact: true })).toBeVisible();
    await expect(publish).toHaveAccessibleDescription("Make a change to publish.");

    await setup.getByLabel("Goal", { exact: true }).fill("Download the latest report.");
    await setup.getByRole("button", { name: "Test changes" }).click();
    await setup.getByLabel("I checked the result").check();
    await change.click();
    await expect(change).toBeEnabled();
    await expect(setup.getByLabel("I checked the result")).toBeChecked();
    await expect(setup.locator(".edit-changes").getByRole("status")).toHaveText("1 unpublished change");
    await expect(setup.getByText("Sign-in details: updated", { exact: true })).toHaveCount(0);
    await expect(publish).toBeEnabled();
    await expect(publish).toHaveAccessibleDescription("Ready to publish your changes.");
  });
}

test("infers a sign-in change when an older host returns a new saved kind", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-credentials-legacy-add`);
  const setup = page.frameLocator("iframe");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await setup.getByLabel("I checked the result").check();
  await setup.getByRole("button", { name: "Add sign-in details", exact: true }).click();
  await expect(setup.locator(".edit-credentials li")).toHaveText(["Username · saved", "Password · saved"]);
  await expect(setup.getByText("Sign-in details: updated", { exact: true })).toBeVisible();
  await expect(setup.locator(".edit-changes").getByRole("status")).toHaveText("1 unpublished change");
  await expect(setup.getByText("Test completed", { exact: true })).toHaveCount(0);
  await expect(setup.getByLabel("I checked the result")).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeDisabled();
  await expect(setup.getByRole("button", { name: "Publish changes" })).toHaveAccessibleDescription("Test your changes before publishing.");
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

/** Review screenshots of the Google sign-in states, taken only when GOOGLE_SIGNIN_SHOTS names a directory. */
async function googleShots(page: Page, name: string, subject?: Locator): Promise<void> {
  const dir = process.env.GOOGLE_SIGNIN_SHOTS;
  if (!dir) return;
  for (const [width, height] of [[1440, 900], [1280, 640]]) {
    await page.setViewportSize({ width, height });
    // The setup page is an iframe; let it lay out at the new size before capturing.
    await page.waitForTimeout(300);
    await subject?.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${dir}/${name}-${width}x${height}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

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

test("stops a create test and presents neutral evidence", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=stop-test`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("button", { name: "Stop test" })).toBeVisible();
  await setup.getByRole("button", { name: "Stop test" }).click();
  await expect(setup.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  const result = setup.locator(".run-status");
  await expect(result).toContainText("Test stopped");
  await expect(result).toContainText("You stopped the test at step 2");
  await expect(result).toContainText("Nothing needs changing. Run the test again when you are ready.");
  await expect(result).toHaveAttribute("role", "status");
  await expect(result).not.toHaveClass(/bad|good/);
  await expect(result.locator("blockquote")).toHaveCount(0);
  await expect(setup.getByRole("tab", { name: /Steps/ })).toHaveAttribute("aria-selected", "true");
  const steps = setup.locator(".test-step");
  await expect(steps.nth(0)).toHaveClass(/done/);
  await expect(steps.nth(1)).toHaveClass(/stopped/);
  await expect(steps.nth(1)).toContainText("Stopped here");
  await expect(steps.nth(1).locator("textarea")).toHaveCount(0);
  await expect(setup.getByText("The page when you stopped the test.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Run test again" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Continue to schedule" })).toHaveCount(0);
  await expect.poll(() => page.locator('[data-testid="stop-requests"]').textContent()).toBe('[{"agentId":"agent-1","runId":"run-1"}]');
  await page.screenshot({ path: "e2e-artifacts/stop-create.png" });
});

test("stops an edit test and keeps publishing unavailable", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-stop-test`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Step 1 description").fill("Open the reports page");
  await setup.getByRole("button", { name: "Test changes" }).click();
  await expect(setup.getByRole("button", { name: "Stop test" })).toBeVisible();
  await expect(setup.getByLabel("Step 1 description")).toBeDisabled();
  await setup.getByRole("button", { name: "Stop test" }).click();
  await expect(setup.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  await expect(setup.getByRole("status").filter({ hasText: "Stopping the test…" })).toBeVisible();
  await expect(setup.locator(".edit-result-stopped")).toContainText("Stopped by you");
  await expect(setup.locator(".edit-result-stopped")).toHaveAttribute("role", "status");
  await expect(setup.getByRole("complementary", { name: "Test activity" }).locator("header span")).toHaveText("Stopped");
  await expect(setup.getByRole("log", { name: "Agent activity" }).getByText("Failed")).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Publish changes" })).toHaveAccessibleDescription("Test your changes before publishing.");
  await expect.poll(() => page.locator('[data-testid="stop-requests"]').textContent()).toBe('[{"agentId":"agent-1","runId":"run-1"}]');
  await page.screenshot({ path: "e2e-artifacts/stop-edit.png" });
});

test("recovers when an older host rejects Stop test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=stop-rejected`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await setup.getByRole("button", { name: "Stop test" }).click();
  await expect(setup.getByRole("alert")).toContainText("Stopping this test is not available.");
  await expect(setup.getByRole("button", { name: "Stop test" })).toBeEnabled();
  await setup.getByRole("button", { name: "Close setup" }).click();
  await setup.getByRole("button", { name: "Close setup" }).last().click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests.length)).toBe(1);
});

for (const scenario of ["stop-test", "edit-stop-test"]) {
  test(`stops the running ${scenario} run before closing`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    if (scenario === "stop-test") {
      await completeToTest(setup);
      await setup.getByRole("button", { name: "Run test" }).click();
      await setup.getByRole("button", { name: "Close setup" }).click();
      await setup.getByRole("button", { name: "Close setup" }).last().click();
    } else {
      await setup.getByRole("button", { name: "Test changes" }).click();
      await setup.getByRole("button", { name: "Close edit page" }).click();
      await setup.getByRole("button", { name: "Discard changes" }).click();
    }
    await expect.poll(() => page.locator('[data-testid="stop-requests"]').textContent()).toBe('[{"agentId":"agent-1","runId":"run-1"}]');
    await expect.poll(() => page.evaluate(() => window.__closeRequests.length)).toBe(1);
    expect(await page.evaluate(() => window.__requestIds.map((id) => id.split(":").at(-1).split("-")[0]).filter((method) => method === "stopTest" || method === "close").slice(-2))).toEqual(["stopTest", "close"]);
  });
}

for (const scenario of ["stop-test", "edit-stop-test"]) {
  test(`does not repeat Stop when closing a stopping ${scenario} run`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    if (scenario === "stop-test") {
      await completeToTest(setup);
      await setup.getByRole("button", { name: "Run test" }).click();
    } else {
      await setup.getByRole("button", { name: "Test changes" }).click();
    }
    await setup.getByRole("button", { name: "Stop test" }).click();
    await expect(setup.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    if (scenario === "stop-test") {
      await setup.getByRole("button", { name: "Close setup" }).first().click();
      await setup.getByRole("button", { name: "Close setup" }).last().click();
    } else {
      await setup.getByRole("button", { name: "Close edit page" }).click();
      await setup.getByRole("button", { name: "Discard changes" }).click();
    }
    await expect.poll(() => page.evaluate(() => window.__closeRequests.length)).toBe(1);
    await expect.poll(() => page.locator('[data-testid="stop-requests"]').textContent()).toBe('[{"agentId":"agent-1","runId":"run-1"}]');
  });
}

const watchRequests = ["ready", "loadRun", "getTestRun", "close"];

async function expectOnlyWatchRequests(page: Page): Promise<void> {
  const methods = await page.evaluate(() => window.__requestMethods);
  expect(methods.filter((method: string) => !watchRequests.includes(method))).toEqual([]);
  const reads: Array<{ agentId: string; runId: string }> = await page.evaluate(() => window.__runReads);
  expect(reads.filter((read) => read.agentId !== "agent-1" || read.runId !== "run-7")).toEqual([]);
  expect(await page.evaluate(() => window.__stopRequests)).toEqual([]);
}

for (const failure of ["rejected", "timeout"] as const) {
  test(`keeps a run read-only when ready ${failure}, including retry and failed close`, async ({ page }) => {
    await page.clock.install({ time: clockStart });
    await page.clock.pauseAt(clockPaused);
    await page.goto(`${baseUrl}/host?scenario=run-ready-${failure}`);
    const run = page.frameLocator("iframe");
    if (failure === "timeout") {
      await expect(run.getByText("Opening the run…")).toBeVisible();
      await expect(run.getByRole("navigation", { name: "Agent setup progress" })).toHaveCount(0);
      await page.clock.runFor(45_000);
    }
    const problem = run.getByRole("alert").filter({ hasText: "The run couldn’t be opened" });
    await expect(problem).toBeVisible();
    await expect(run.getByRole("navigation", { name: "Agent setup progress" })).toHaveCount(0);
    expect(await page.evaluate(() => window.__requestMethods)).toEqual(["ready"]);
    await problem.getByRole("button", { name: "Try again", exact: true }).click();
    if (failure === "timeout") {
      await expect(run.getByText("Opening the run…")).toBeVisible();
      await page.clock.runFor(45_000);
    }
    await expect(problem).toBeVisible();
    await expect(run.getByRole("navigation", { name: "Agent setup progress" })).toHaveCount(0);
    expect(await page.evaluate(() => window.__requestMethods)).toEqual(["ready", "ready"]);
    await run.getByRole("button", { name: "Close run", exact: true }).click();
    await expect(run.getByRole("alert").filter({ hasText: "Closing failed. Try again." })).toBeVisible();
    await expect(problem).toBeVisible();
    await problem.getByRole("button", { name: "Back to web agents", exact: true }).click();
    await expect(run.getByRole("alert").filter({ hasText: "Closing failed. Try again." })).toHaveCount(0);
    await problem.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(run.getByRole("heading", { name: "Monthly statement", level: 1 })).toBeVisible();
    const methods = await page.evaluate(() => window.__requestMethods);
    expect(methods.filter((method: string) => method !== "loadRun")).toEqual(["ready", "ready", "close", "close", "ready"]);
    expect(methods).toContain("loadRun");
    expect(await page.evaluate(() => window.__closeRequests)).toEqual([{}, {}]);
    await expectOnlyWatchRequests(page);
  });
}

test("watches an existing run to its result in the setup's browser and activity, using only read requests", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockPaused);
  await page.goto(`${baseUrl}/host?scenario=run-activity-success`);
  const run = page.frameLocator("iframe");
  const browser = run.getByRole("region", { name: "Agent browser", exact: true });
  const activity = run.getByRole("log", { name: "Agent activity" });

  await expect(run.getByRole("heading", { name: "Monthly statement", level: 1 })).toBeVisible();
  await expect(run.getByRole("navigation", { name: "Agent setup progress" })).toHaveCount(0);
  await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toBeVisible();
  await expect(browser.getByText("Live · view only")).toBeVisible();
  await expect(activity.getByText("Browser opened")).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(activity.getByText("Type text")).toBeVisible();
  await expect(activity.getByText("Working")).toBeVisible();
  await expect(run.getByText("Closing this page leaves the run going.")).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/run-watch-live.png" });
  await page.clock.runFor(2_000);
  await expect(browser.getByText("Agent is closing the browser")).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(browser.getByText("Agent closed the browser")).toBeVisible();
  await expect(browser.getByText("Reiterate is saving the result of this run.")).toBeVisible();
  await expect(browser.getByText("Last screen", { exact: true })).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(run.getByText("Run completed", { exact: true })).toBeVisible();
  await expect(browser.getByText("Final screen", { exact: true })).toBeVisible();
  await expect(browser.getByText("The page when the run completed.")).toBeVisible();
  await expect(run.getByRole("link", { name: "statement-run-7.pdf" })).toHaveAttribute("href", "https://files.example.test/statement-run-7.pdf");
  await expect(activity.getByText("Browser closed")).toBeVisible();
  await expect(activity.getByText("Working")).toHaveCount(0);
  await expect(run.locator("iframe")).toHaveCount(0);
  await page.screenshot({ path: "e2e-artifacts/run-watch-finished.png" });

  const requests = await page.evaluate(() => window.__requestMethods.length);
  await page.clock.runFor(20_000);
  expect(await page.evaluate(() => window.__requestMethods.length)).toBe(requests);
  await expect(run.getByRole("button", { name: /stop|test|publish|schedule|save|sign-in|demonstrat/i })).toHaveCount(0);
  await run.getByRole("button", { name: "Back to web agents" }).click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{}]);
  await expectOnlyWatchRequests(page);
});

test("reloading a watched run resumes watching the same run without changing it", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockPaused);
  await page.goto(`${baseUrl}/host?scenario=run-activity-success`);
  const run = page.frameLocator("iframe");
  const browser = run.getByRole("region", { name: "Agent browser", exact: true });
  await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toBeVisible();

  await page.frames()[1]!.goto(page.frames()[1]!.url());
  await expect(run.getByRole("heading", { name: "Monthly statement", level: 1 })).toBeVisible();
  const activity = run.getByRole("log", { name: "Agent activity" });
  await expect(activity.getByText("Browser opened")).toBeVisible();
  await expect(activity.getByText("Type text")).toHaveCount(0);
  await page.clock.runFor(2_000);
  await expect(activity.getByText("Type text")).toBeVisible();
  expect(await page.evaluate(() => window.__closeRequests)).toEqual([]);
  await expectOnlyWatchRequests(page);
});

test("shows why a watched run failed, with its last screen and blocked action", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockPaused);
  await page.goto(`${baseUrl}/host?scenario=run-activity-failure`);
  const run = page.frameLocator("iframe");
  await expect(run.getByRole("region", { name: "Agent browser", exact: true }).getByText("Opening the virtual browser.")).toBeVisible();
  for (let poll = 0; poll < 5; poll += 1) await page.clock.runFor(2_000);
  const result = run.getByRole("alert").filter({ hasText: "Run failed" });
  await expect(result).toContainText("A step didn't work");
  await expect(result).toContainText("The Export button was missing.");
  await expect(result).toContainText("Stopped at step 2");
  await expect(run.getByRole("region", { name: "Agent browser", exact: true }).getByText("Final screen", { exact: true })).toBeVisible();
  await expect(run.getByRole("log", { name: "Agent activity" }).getByText("Blocked", { exact: true })).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/run-watch-failed.png" });
  await expectOnlyWatchRequests(page);
});

test("reports a lost browser in a watched run without claiming the agent closed it", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockPaused);
  await page.goto(`${baseUrl}/host?scenario=run-activity-lost`);
  const run = page.frameLocator("iframe");
  const browser = run.getByRole("region", { name: "Agent browser", exact: true });
  await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
  for (let poll = 0; poll < 3; poll += 1) await page.clock.runFor(2_000);
  await expect(browser.getByText("Browser connection lost")).toBeVisible();
  await expect(browser.getByText("Its state is unknown. The run keeps running, and its result appears here when it finishes.")).toBeVisible();
  await expect(browser.getByText("Agent closed the browser")).toHaveCount(0);
  await expectOnlyWatchRequests(page);
});

test("says why a watched run's updates fail while it reconnects, then recovers", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockPaused);
  await page.goto(`${baseUrl}/host?scenario=run-activity-poll-lost`);
  const run = page.frameLocator("iframe");
  const browser = run.getByRole("region", { name: "Agent browser", exact: true });
  await expect(browser.getByText("Opening the virtual browser.")).toBeVisible();
  for (let poll = 0; poll < 3; poll += 1) await page.clock.runFor(2_000);
  await expect(browser.getByText("Browser connection lost")).toBeVisible();
  await expect(run.getByText("Reconnecting to the run…")).toBeVisible();
  await expect(run.getByText("The latest update couldn’t be read: The connection to Reiterate was lost.")).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/run-watch-reconnecting.png" });
  for (let poll = 0; poll < 5; poll += 1) await page.clock.runFor(2_000);
  await expect(browser.getByRole("img", { name: "Latest screen of the agent’s browser" })).toBeVisible();
  await expect(run.getByText(/couldn’t be read/)).toHaveCount(0);
  await expectOnlyWatchRequests(page);
});

test("opens a finished run without reading it again", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockPaused);
  await page.goto(`${baseUrl}/host?scenario=run-finished`);
  const run = page.frameLocator("iframe");
  await expect(run.getByText("Run completed", { exact: true })).toBeVisible();
  await expect(run.getByText("Download started: statement-run-7.pdf")).toBeVisible();
  const requests = await page.evaluate(() => window.__requestMethods);
  await page.clock.runFor(20_000);
  expect(await page.evaluate(() => window.__requestMethods)).toEqual(requests);
  await expectOnlyWatchRequests(page);
});

test("explains a run that no longer exists and lets the user retry or leave", async ({ page }) => {
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockPaused);
  await page.goto(`${baseUrl}/host?scenario=run-missing`);
  const run = page.frameLocator("iframe");
  const problem = run.getByRole("alert").filter({ hasText: "The run couldn’t be opened" });
  await expect(problem).toContainText("This run no longer exists. It may have been deleted.");
  await page.screenshot({ path: "e2e-artifacts/run-watch-missing.png" });
  const loads = await page.evaluate(() => window.__requestMethods.filter((method: string) => method === "loadRun").length);
  await problem.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => page.evaluate(() => window.__requestMethods.filter((method: string) => method === "loadRun").length)).toBe(loads + 1);
  await expect(problem).toContainText("This run no longer exists. It may have been deleted.");
  await problem.getByRole("button", { name: "Back to web agents" }).click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{}]);
  await expectOnlyWatchRequests(page);
});

function hostPage(url: string, scenario: string | null): string {
  const encodedOrigin = encodeURIComponent(url);
  // Like the Reiterate host, a run page names only its mode; the host keeps the agent and run ids.
  const mode = scenario?.startsWith("run-") ? "&mode=run" : "";
  return `<!doctype html>
<html><body><iframe src="${url}/?parentOrigin=${encodedOrigin}${mode}" title="Agent setup"></iframe>
<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{overflow:hidden}</style>
<script>
  const scenario = new URLSearchParams(location.search).get("scenario");
  const legacy = scenario === "legacy" || scenario === "legacy-lost-schedule-reply";
  window.__requestIds = [];
  window.__requestMethods = [];
  window.__runReads = [];
  window.__testArguments = [];
  window.__chooseScheduleCalls = [];
  window.__createdRoutes = [];
  window.__allowedSenders = [];
  window.__emailArrivals = [];
  window.__scheduleArguments = [];
  window.__scheduleRequests = [];
  window.__closeRequests = [];
  window.__stopRequests = [];
  const stopLog = document.createElement("pre");
  stopLog.dataset.testid = "stop-requests";
  stopLog.hidden = true;
  document.body.append(stopLog);
  let stopPolls = 0;
  window.__savedAgents = [];
  window.__credentialRequests = [];
  window.__googleRequests = [];
  window.__googleSignInRequests = [];
  // Hosts with the Google sign-in dialog; "google-demo-*" demonstrations end signed in to Google unless "signedout".
  const googleSignInHost = /google-(demo|signin)-/.test(scenario) && !scenario.endsWith("nocap");
  const googleDemo = scenario.includes("google-demo-") && !scenario.endsWith("signedout");
  let googleSignInStatus = scenario.endsWith("-ready") ? "ready" : scenario.endsWith("-needs") ? "needs_authenticator" : "missing";
  window.__liveViewSwitching = true;
  window.__startUrls = [];
  window.__renameRequests = [];
  window.__publishRequests = [];
  let recordingActive = false;
  let exportSentAt = 0;
  const signIn = scenario === "sign-in" || scenario === "sign-in-unsupported" || scenario === "signin-failure";
  const emailScenario = scenario?.startsWith("email-");
  const screen = { image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S8sAAAAASUVORK5CYII=", thought: "I looked for the export button." };
  // Thought shapes as the web agent stores them: reasoning summaries, proposed actions, the final JSON outcome.
  // Activity scenarios replay one run frame per status poll; a new run starts over. Screens are drawn PNGs of a fake portal.
  const activityScenario = scenario.replace(/^(edit|run)-/, "");
  // Run scenarios stand in for the host watching agent-1's existing run-7; it answers only for that run.
  const watch = scenario.startsWith("run-");
  const drawnScreens = {};
  let activityRun = null;
  let activityPolls = 0;
  const portalScreen = (label) => {
    if (drawnScreens[label]) return drawnScreens[label];
    const canvas = document.createElement("canvas");
    canvas.width = 1440; canvas.height = 900;
    const c = canvas.getContext("2d");
    c.fillStyle = "#ffffff"; c.fillRect(0, 0, 1440, 900);
    c.fillStyle = "#1f3a5f"; c.fillRect(0, 0, 1440, 72);
    c.fillStyle = "#ffffff"; c.font = "600 28px sans-serif"; c.fillText("Example portal", 40, 46);
    c.fillStyle = "#17233d"; c.font = "600 36px sans-serif"; c.fillText(label, 40, 150);
    for (let row = 0; row < 8; row++) {
      c.fillStyle = row % 2 ? "#f4f6fa" : "#ffffff"; c.fillRect(40, 190 + row * 64, 1360, 64);
      c.fillStyle = "#5f667c"; c.font = "22px sans-serif"; c.fillText("Statement " + (row + 1) + " \u00b7 September 2026", 64, 230 + row * 64);
    }
    drawnScreens[label] = canvas.toDataURL("image/png");
    return drawnScreens[label];
  };
  const activityFrame = (runId, advance = true) => {
    if (runId !== activityRun) { activityRun = runId; activityPolls = 0; }
    if (advance || activityPolls === 0) activityPolls += 1;
    const n = activityPolls;
    const runLabel = runId === "run-1" ? "" : " (" + runId + ")";
    const first = { image: portalScreen("Reports" + runLabel), sequence: 1 };
    const second = { image: portalScreen("Monthly statements" + runLabel), sequence: 2 };
    const opened = [
      { sequence: 1, kind: "lifecycle", status: "completed", text: "Browser opened" },
      { sequence: 2, kind: "stage", status: "started", text: "Follow the steps" },
    ];
    const acted = opened.concat([
      { sequence: 3, kind: "action", status: "executed", text: "Click" },
      { sequence: 4, kind: "action", status: "executed", text: "Type text" },
    ]);
    const failed = acted.concat([
      { sequence: 5, kind: "action", status: "blocked", text: "Click" },
      { sequence: 6, kind: "stage", status: "failed", text: "Follow the steps" },
    ]);
    const finished = acted.concat([
      { sequence: 5, kind: "action", status: "executed", text: "Scroll" },
      { sequence: 6, kind: "stage", status: "completed", text: "Follow the steps" },
    ]);
    const closing = (items) => items.concat([{ sequence: 7, kind: "lifecycle", status: "started", text: "Closing the browser" }]);
    const closed = (items) => closing(items).concat([{ sequence: 8, kind: "lifecycle", status: "completed", text: "Browser closed" }]);
    const running = (revision, browser, snapshot, items) => ({ status: "running", activity: { revision, browser, snapshot, items } });
    if (activityScenario === "activity-unavailable") return { status: "running", liveViewUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html" };
    if (n === 1) return running(1, "starting", null, []);
    if (n === 2) return running(2, "live", first, opened);
    if (n === 3) return running(3, "live", second, acted);
    const items = activityScenario === "activity-failure" || activityScenario === "activity-website-failure" ? failed : finished;
    if (activityScenario === "activity-lost") return running(4, "unknown", second, finished.concat([{ sequence: 7, kind: "lifecycle", status: "failed", text: "Browser connection lost" }]));
    // Status checks fail for ten seconds, long enough to watch in a real browser, then recover.
    if (activityScenario === "activity-poll-lost" && n <= 8) return null;
    if (activityScenario === "activity-poll-lost") return running(4, "live", second, finished);
    if (activityScenario === "activity-stale" && n === 5) return running(2, "live", first, opened);
    if (n === 4) return running(4, "closing", second, closing(items));
    if (n === 5 || activityScenario === "activity-closed-hold") return running(5, "closed", second, closed(items));
    const evidence = activityScenario === "activity-final-unreadable" ? null : { revision: 6, browser: "closed", snapshot: second, items: closed(items) };
    if (activityScenario === "activity-failure") return { status: "failed", failure: { kind: "steps", message: "The Export button was missing." }, stoppedAtStep: 2, screens: [{ image: second.image, thought: '{"status":"failed","reason":"The Export button was missing.","step":2,"confirmation":null}' }], activity: evidence };
    if (activityScenario === "activity-website-failure") return { status: "failed", failure: { kind: "website", message: "The website security check remained unresolved after multiple waits and a retry, so the monthly statements page could not be reached." }, stoppedAtStep: 1, screens: [{ image: first.image, thought: "" }, { image: second.image, thought: "" }], activity: evidence };
    const file = runId === "run-1" ? "statement.pdf" : "statement-" + runId + ".pdf";
    return { status: "succeeded", files: [{ name: file, url: "https://files.example.test/" + file }], screens: [{ image: second.image, thought: '{"status":"completed","reason":"Downloaded the September statement.","step":3,"confirmation":"Download started: statement.pdf"}' }], confirmation: "Download started: statement.pdf", activity: evidence };
  };
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
  const staged = scenario === "edit-staged";
  // A legitimate "selector" label with a recorded selector target, then an instruction written as a selector.
  const selectorSteps = [
    { id: "account", type: "click", description: "Click the account selector", target: "#account > button" },
    { id: "4c793770-6a98-4bc5-b4f9-7fb4d4bcc847", type: "click", description: "Click #export > button", target: "Export" },
  ];
  // A form field the recorder kept only as a selector; the instruction names it.
  const hiddenFieldSteps = [{ id: "email-field", type: "input", description: "Enter Email", target: "input[name=email]", value: "reports@example.test" }];
  const editSteps = scenario === "edit-date" ? [
    { id: "to-date", type: "date", description: "Enter the To date", target: "To", date: { value: "2026-09-06", format: "parts", rule: null }, parts: [{ id: "to-day", type: "input", description: "Enter the To day", target: "day", value: "06" }, { id: "to-month", type: "input", description: "Enter the To month", target: "month", value: "09" }, { id: "to-year", type: "input", description: "Enter the To year", target: "year", value: "2026" }] },
  ] : [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: "The reports list is visible", ...(staged ? { stage: "Open reports" } : {}) },
    ...(scenario === "edit-selector-step" ? selectorSteps : []),
    ...(scenario === "edit-hidden-field-target" ? hiddenFieldSteps : []),
    { id: "download", type: "click", description: "Download the statement", target: "Download statement", ...(staged ? { stage: "Download" } : {}) },
  ];
  const redemonstrationSteps = [{ id: "download-refreshed", type: "click", description: "Download the refreshed statement", target: "Download statement" }];
  const internal = scenario === "edit-internal";
  let savedCredentials = ["edit-credentials-empty", "edit-raw-no-signin", "edit-credentials-legacy-add"].includes(scenario) ? [] : ["username", "password"];
  if (scenario === "edit-credentials-placeholders") {
    savedCredentials = ["username"];
    editSteps[0].description += " with $password";
    editSteps[0].expectedOutcome += " after $otp";
  }
  const steps = scenario === "date-create" ? [
    { id: "from", type: "click", description: "Click From", target: "From" },
    { id: "from-day", type: "input", description: "Enter the From day", target: "day", value: "06" },
    { id: "from-month", type: "input", description: "Enter the From month", target: "month", value: "09" },
    { id: "from-year", type: "input", description: "Enter the From year", target: "year", value: "2026" },
    { id: "apply", type: "click", description: "Click Apply", target: "Apply" },
    { id: "download", type: "download", description: "Download the statement", value: "statement.pdf" },
  ] : scenario === "otp-create" ? [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports" },
    { id: "otp", type: "credential", description: "Enter the saved one-time code in Code", target: "Code", value: "otp" },
    { id: "download", type: "download", description: "Download the statement", value: "statement.pdf" },
  ] : [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: scenario === "email-recipient-check" ? "Support contact me@example.test is visible" : "The reports list is visible" },
    ...(scenario === "email-ambiguous" ? [
      { id: "billing", type: "input", description: "Enter billing contact", target: "Billing email", value: "billing@example.test" },
      { id: "recipient", type: "input", description: "Enter export recipient", target: "Send export to", value: "recipient@example.test" },
    ] : emailScenario ? [{ id: "email-address", type: "input", description: "Enter the export email", target: "Email address", value: "me@example.test", ...(scenario === "email-recipient-check" ? { expectedOutcome: "The recipient is me@example.test; confirm me@example.test appears in the field" } : {}) }] : []),
    ...(scenario === "form-entry" ? [
      { id: "choose-month", type: "input", description: "Fill in Statement month", target: "Statement month", value: "September 2026" },
      { id: "choose-format", type: "select_change", description: "Choose PDF in Format", target: "Format", value: "PDF" },
    ] : []),
    ...(scenario === "selector-step" ? selectorSteps : []),
    ...(scenario === "hidden-field-target" ? hiddenFieldSteps : []),
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
    window.__requestMethods.push(request.method);
    const send = (result) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, result }, event.origin);
    const fail = (error) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, error }, event.origin);
    if (request.method === "ready") {
      if (scenario.startsWith("run-ready-") && window.__requestMethods.filter((method) => method === "ready").length <= 2) {
        if (scenario === "run-ready-rejected") fail("The connection to Reiterate was lost.");
        return;
      }
      if (scenario === "delayed-ready") setTimeout(() => send({ schedule: true }), 300);
      else send({ schedule: true, mode: watch ? "run" : edit ? "edit" : "create", credentials: !["sign-in-unsupported", "edit-credentials-unsupported"].includes(scenario), google: !scenario.endsWith("old-host"), ...(googleSignInHost ? { googleSignIn: true } : {}), emailRoutes: !legacy, chooseSchedule: !legacy && scenario !== "no-text" });
    } else if (request.method === "loadRun") {
      if (scenario === "run-missing") { fail("This run no longer exists. It may have been deleted."); return; }
      const finished = { status: "succeeded", files: [{ name: "statement-run-7.pdf", url: "https://files.example.test/statement-run-7.pdf" }], screens: [{ image: portalScreen("Monthly statements (run-7)") }], confirmation: "Download started: statement-run-7.pdf", activity: { revision: 6, browser: "closed", snapshot: null, items: [{ sequence: 1, kind: "lifecycle", status: "completed", text: "Browser opened" }, { sequence: 2, kind: "lifecycle", status: "completed", text: "Browser closed" }] } };
      send({ agentId: "agent-1", runId: "run-7", name: "Monthly statement", url: "https://portal.example.test/reports", run: scenario === "run-finished" ? finished : activityFrame("run-7", false) });
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
    } else if (request.method === "requestCredentials") {
      window.__credentialRequests.push(request.params);
      if (scenario === "edit-credentials-error") { fail("Sign-in details belong to a different website. Restore the website address first."); return; }
      if (scenario === "edit-credentials-cancel") { send({ saved: savedCredentials, changed: false }); return; }
      if (scenario === "edit-credentials-legacy-same") { send({ saved: savedCredentials }); return; }
      if (scenario === "edit-credentials-legacy-reordered") { savedCredentials = [...savedCredentials].reverse(); send({ saved: savedCredentials }); return; }
      savedCredentials = request.params.kinds;
      send({ saved: savedCredentials, ...(edit && scenario !== "edit-credentials-legacy-add" ? { changed: true } : {}) });
    } else if (request.method === "connectGoogle") { window.__googleRequests.push(request.params); send({ connected: !scenario.endsWith("cancel") });
    } else if (request.method === "getGoogleSignIn") { window.__googleSignInRequests.push({ method: request.method, params: request.params }); if (scenario.endsWith("google-demo-error")) { fail("Reiterate couldn't load the Google sign-in."); return; } send({ status: googleSignInStatus, email: googleSignInStatus === "missing" ? null : "ops@example.test" });
    } else if (request.method === "setUpGoogleSignIn") {
      window.__googleSignInRequests.push({ method: request.method, params: request.params });
      // "cancel" and "needs" scenarios close the dialog without saving.
      const saved = !scenario.endsWith("cancel") && !scenario.endsWith("-needs");
      if (saved) googleSignInStatus = "ready";
      send({ status: googleSignInStatus, email: googleSignInStatus === "missing" ? null : "ops@example.test", changed: saved });
    } else if (request.method === "startRecording") { window.__startUrls.push(request.params.url); if (edit ? recordingExists : recordingActive) { fail("Finish the current demonstration first."); return; } recordingActive = true; recordingExists = true; send({ id: "recording-1", status: "recording", liveViewUrl: "https://live.browserbase.com/session", liveViewSwitching: scenario.endsWith("window-switch"), steps: edit ? [] : steps, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null }); }
    else if (scenario === "organized" && (request.method === "getRecording" || request.method === "stopRecording")) {
      // Polls: one while recording (download started), then completed; stop starts organizing; the next read has stages.
      window.__organizedReads = (window.__organizedReads ?? 0) + 1;
      if (request.method === "stopRecording") { recordingActive = false; window.__stoppedAt = window.__organizedReads; }
      const stopped = !recordingActive;
      const organizing = stopped && window.__organizedReads === window.__stoppedAt;
      const recorded = [
        { id: "open", type: "navigation", description: "Open portal.example.test", url: "https://portal.example.test/reports" },
        { id: "garbled", type: "click", description: "Click Continue with GoogleorEmailPasswordLog in", target: "Continue with GoogleorEmailPasswordLog in" },
        { id: "reports", type: "click", description: "Click Reports", target: "Reports" },
        { id: "export", type: "click", description: "Click Export", target: "Export" },
        { id: "file", type: "download", description: "Download statement-2026-09.csv", value: "statement-2026-09.csv" },
      ];
      const organized = [["Sign in", "Open the portal"], ["Sign in", "Click Email login"], ["Download the statement", "Click Reports"], ["Download the statement", "Click Export"], ["Download the statement", "Download the statement CSV"]];
      const downloadState = window.__organizedReads === 1 && !stopped ? "started" : "completed";
      send({ id: "recording-1", status: stopped ? "stopped" : "recording", liveViewUrl: stopped ? null : "https://live.browserbase.com/session",
        steps: stopped && !organizing ? recorded.map((step, index) => ({ ...step, stage: organized[index][0], description: organized[index][1] })) : recorded,
        downloads: [{ id: "file", name: "statement-2026-09.csv", state: downloadState }], organizing, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null });
    }
    // "polled" demonstrations end in the virtual browser, so the next read reports them stopped.
    else if (request.method === "getRecording" || request.method === "stopRecording") { if (request.method === "stopRecording" || scenario.endsWith("google-demo-polled")) recordingActive = false; send({ id: "recording-1", status: request.method === "getRecording" && recordingActive ? "recording" : "stopped", liveViewUrl: request.method === "getRecording" && recordingActive ? "https://live.browserbase.com/session" : null, liveViewSwitching: scenario.endsWith("window-switch") && window.__liveViewSwitching, steps: edit ? (request.method === "stopRecording" ? redemonstrationSteps : []) : steps, ...(scenario.includes("google-demo-") ? { google: { signedIn: googleDemo } } : {}), expiresAt: "2026-09-11T12:00:00Z", blockedReason: null }); }
    else if (request.method === "cancelRecording") { recordingActive = false; recordingExists = false; send(undefined); }
    else if (request.method === "saveAgent") { if (window.__savedSchedule || scenario === "rerun-save-rejection" && window.__savedAgents.length > 0) fail("This agent is scheduled. Edit it in agent settings."); else { window.__savedAgents.push(request.params); send({ id: "agent-1" }); } }
    else if (request.method === "testAgent") { testAttempts += 1; window.__testArguments.push(request.params.arguments); exportSentAt = Date.now(); if (scenario === "email-cutoff" && window.__testArguments.length > 1) setTimeout(() => send({ id: "run-" + window.__testArguments.length }), 1000); else send({ id: "run-" + window.__testArguments.length }); }
    else if (request.method === "stopTest") {
      if (scenario === "stop-rejected") { fail("Stopping this test is not available."); return; }
      window.__stopRequests.push(request.params);
      stopLog.textContent = JSON.stringify(window.__stopRequests);
      stopPolls = 0;
      send(null);
    }
    else if (request.method === "getTestRun") {
      if (watch) {
        window.__runReads.push(request.params);
        if (request.params.agentId !== "agent-1" || request.params.runId !== "run-7") { fail("This page watches a different run."); return; }
      }
      if (scenario === "stop-test" || scenario === "edit-stop-test") {
        const activity = { revision: 1, browser: "live", snapshot: { image: portalScreen("Reports"), sequence: 1 }, items: [{ sequence: 1, kind: "lifecycle", status: "completed", text: "Browser opened" }] };
        if (!window.__stopRequests.some((item) => item.runId === request.params.runId)) send({ status: "running", activity });
        else if (++stopPolls === 1) send({ status: "running", stopping: true, activity });
        else send({ status: "failed", failure: { kind: "stopped", message: "You stopped the test." }, stoppedAtStep: 2, screens: [{ image: portalScreen("Monthly statements") }], activity: { ...activity, revision: 2, browser: "closed", items: activity.items.concat([{ sequence: 2, kind: "lifecycle", status: "failed", text: "Stopped by user" }]) } });
        return;
      }
      if (activityScenario.startsWith("activity-")) { const frame = activityFrame(request.params.runId); if (frame === null) fail("The connection to Reiterate was lost."); else send(frame); return; }
      if (scenario === "edit-fail-evidence") send({ status: "failed", failure: { kind: "website", message: "The download button was missing." }, stoppedAtStep: 2, confirmation: "The reports list opened, but no file was downloaded.", screens: [{ ...screen, thought: "Earlier screen" }, screen] });
      else if (googleSignInHost) send({ status: "failed", failure: { kind: "google", message: "Set up the Google sign-in with an authenticator key, then run the test again." }, stoppedAtStep: 2, screens: [screen] });
      else if (scenario.includes("google-")) send({ status: "failed", failure: { kind: "google", message: "Google sign-in requires an account, but no Google credentials are available." }, stoppedAtStep: 2, screens: [screen] });
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
      else if (scenario === "watch" || scenario === "edit-watch" || scenario === "stop-rejected") send({ status: "running", liveViewUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html", activity: { revision: 1, browser: "live", snapshot: { image: portalScreen("Reports"), sequence: 1 }, items: [{ sequence: 1, kind: "lifecycle", status: "completed", text: "Browser opened" }] } });
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
    else if (request.method === "close") { window.__closeRequests.push(request.params); if (scenario.startsWith("run-ready-") && window.__closeRequests.length === 1) fail("Closing failed. Try again."); else send(undefined); }
    else fail("Unknown request");
  });
</script></body></html>`;
}
