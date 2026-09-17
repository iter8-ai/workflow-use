import { expect, test, type FrameLocator } from "@playwright/test";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";

test.beforeEach(async ({ page }) => {
  await page.route("https://live.browserbase.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Demonstration website</h1>" }));
  await page.route(/\/host\?scenario=/, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: hostPage(baseUrl),
    });
  });
});

test("takes a user through demonstration, review, testing, and result confirmation", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await expect(setup.getByRole("heading", { name: "Set up your agent" })).toBeVisible();
  await expect(setup.getByText("Do not enter logins, passwords, one-time codes, or API keys.")).toBeVisible();
  await expect(setup.getByRole("link", { name: "Source code" })).toHaveAttribute("href", "https://github.com/iter8-ai/workflow-use");
  await expect(setup.getByRole("link", { name: "AGPL-3.0 license" })).toHaveAttribute("href", "https://github.com/iter8-ai/workflow-use/blob/main/LICENSE");
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();

  await expect(setup.getByText("Open the reports section")).toBeVisible();
  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();

  await setup.getByRole("button", { name: "Continue to test" }).click();

  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__testArguments)).toEqual([{}]);
  await expect(setup.getByRole("link", { name: "statement.pdf" })).toHaveAttribute("href", "https://files.example.test/statement.pdf");
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toHaveCount(0);
  await setup.getByLabel("I checked the result").check();
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toHaveCount(0);
  await setup.getByLabel("Schedule daily").check();
  await setup.getByLabel("Time of day (UTC)").fill("09:30");
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toBeEnabled();
  await setup.getByRole("button", { name: "Schedule agent" }).click();
  await expect(setup.getByRole("heading", { name: "Your agent is ready" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__savedSchedule)).toEqual("30 9 * * *");
  await expect.poll(() => page.evaluate(() => window.__scheduleArguments)).toEqual([{}]);
  await expect.poll(() => page.evaluate(() => window.__savedAgents)).toEqual([
    expect.objectContaining({ draft: expect.objectContaining({ inputs: [] }) }),
  ]);
  await setup.getByRole("button", { name: "Open agent" }).click();
  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{ agentId: "agent-1" }]);
});

test("finishes a checked manual setup without scheduling", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await expect(setup.getByRole("button", { name: "Finish setup" })).toBeEnabled();
  await setup.getByRole("button", { name: "Finish setup" }).click();

  await expect.poll(() => page.evaluate(() => window.__closeRequests)).toEqual([{ agentId: "agent-1" }]);
});

test("does not let a selected daily schedule leave setup as a manual run", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await setup.getByLabel("Schedule daily").check();
  await expect(setup.getByRole("button", { name: "Finish setup" })).toHaveCount(0);
  await setup.getByRole("button", { name: "Close setup" }).click();
  await expect(setup.getByRole("heading", { name: "Leave setup?" })).toBeVisible();
  await setup.getByRole("button", { name: "Keep editing" }).click();
  await expect(setup.getByLabel("Schedule daily")).toBeChecked();
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

test("keeps scheduling disabled after a failed test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=failed`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();

  await expect(setup.getByText("The website rejected the request.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toHaveCount(0);
});

test("invalidates a completed test when reviewed instructions change", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByRole("button", { name: "Back to review" }).click();
  await setup.getByLabel("Step 1 description").fill("Open the updated reports section");
  await setup.getByRole("button", { name: "Continue to test" }).click();

  await expect(setup.getByText("Changes require a new test.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toHaveCount(0);
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

test("binds a discarded recorded value to a reusable input and tests with its example", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=form-entry`);
  const setup = page.frameLocator("iframe");

  await describeAndDemonstrate(setup);
  await expect(setup.getByText("recorded-private-value", { exact: true })).toHaveCount(0);
  await setup.getByRole("button", { name: "Add reusable input" }).click();
  await setup.getByLabel("Input 1 name").fill("month_number");
  await setup.getByLabel("Input 1 label").fill("Statement month");
  await setup.getByLabel("Input 1 type").selectOption("number");
  await setup.getByLabel("Input 1 example").fill("9");
  await setup.getByLabel("Step 2 value source").selectOption("month_number");
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await setup.getByRole("button", { name: "Run test" }).click();

  await expect.poll(() => page.evaluate(() => window.__testArguments)).toEqual([{ month_number: 9 }]);
  await expect.poll(() => page.evaluate(() => window.__savedAgents[0]?.config?.stages?.[0]?.prompt)).toContain("Set Statement month to {month_number}");
  await expect.poll(() => page.evaluate(() => window.__savedAgents[0]?.config?.parameters)).toEqual({});
  await setup.getByLabel("I checked the result").check();
  await setup.getByLabel("Schedule daily").check();
  await setup.getByRole("button", { name: "Schedule agent" }).click();
  await expect.poll(() => page.evaluate(() => window.__scheduleArguments)).toEqual([{ month_number: 9 }]);
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

test("captures the controlled setup states for visual review", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 980 });
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

test("keeps a running test from being started again or edited", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=running`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test is running.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Run test" })).toBeDisabled();
  await expect(setup.getByRole("button", { name: "Back to review" })).toBeDisabled();
});

for (const scenario of ["retry-save-failed", "retry-start-failed"]) {
  test(`requires a new accepted result after ${scenario}`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    await completeToTest(setup);
    await setup.getByRole("button", { name: "Run test" }).click();
    await setup.getByLabel("I checked the result").check();
    await setup.getByRole("button", { name: "Run test" }).click();
    await expect(setup.getByRole("alert")).toContainText("Try the test again.");
    await expect(setup.getByRole("button", { name: "Finish setup" })).toHaveCount(0);
    await expect(setup.getByLabel("I checked the result")).toHaveCount(0);
    await setup.getByLabel("Schedule daily").check();
    await expect(setup.getByRole("button", { name: "Schedule agent" })).toBeDisabled();
    await setup.getByRole("button", { name: "Run test" }).click();
    await expect(setup.getByLabel("I checked the result")).not.toBeChecked();
  });
}

test("edits the job without discarding recorded instructions", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await setup.getByLabel("I checked the result").check();
  await setup.getByRole("button", { name: "Back to review" }).click();
  await expect(setup.getByLabel("Recorded starting address")).toHaveValue("https://portal.example.test/reports");
  await expect(setup.getByLabel("Recorded starting address")).toHaveAttribute("readonly", "");
  await setup.getByLabel("Agent name").fill("Annual report");
  await setup.getByLabel("What should the agent do?").fill("Download the annual report.");
  await expect(setup.getByText("Recorded target: Reports", { exact: true })).toBeVisible();
  await setup.getByLabel("Step 1 description").fill("Open the annual reports section");
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await expect(setup.getByRole("button", { name: "Finish setup" })).toHaveCount(0);
  await setup.getByRole("button", { name: "Back to review" }).click();
  await expect(setup.getByLabel("Agent name")).toHaveValue("Annual report");
  await expect(setup.getByLabel("What should the agent do?")).toHaveValue("Download the annual report.");
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("Open the annual reports section");
});

test("retries the host connection before allowing a demonstration", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=ready-failed`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("alert")).toContainText("Connection unavailable.");
  await expect(setup.getByRole("button", { name: "Continue to demonstration" })).toBeDisabled();
  await setup.getByRole("button", { name: "Retry connection" }).click();
  await expect(setup.getByRole("button", { name: "Continue to demonstration" })).toBeEnabled();
  await expect(setup.getByRole("alert")).toHaveCount(0);
});

for (const scenario of ["expired", "blocked", "empty"]) {
  test(`starts over after an ${scenario} demonstration`, async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=${scenario}`);
    const setup = page.frameLocator("iframe");
    await describe(setup);
    if (scenario === "empty") await setup.getByRole("button", { name: "Finish demonstration" }).click();
    await expect(setup.getByRole("alert")).toBeVisible();
    await expect(setup.getByRole("button", { name: "Continue to review" })).toBeDisabled();
    await setup.getByRole("button", { name: "Start over" }).click();
    await expect(setup.getByLabel("Agent name")).toHaveValue("Download monthly statement");
    await setup.getByRole("button", { name: "Continue to demonstration" }).click();
    await setup.getByRole("button", { name: "Finish demonstration" }).click();
    await setup.getByRole("button", { name: "Continue to review" }).click();
    await expect(setup.getByRole("heading", { name: "Review the draft" })).toBeVisible();
  });
}

test("explains a completed test with no downloadable result", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=no-files`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("No files were returned. Check the result on the website before confirming. If you expected a download, review the instructions and test again.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Finish setup" })).toBeDisabled();
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }]) {
  test(`keeps recording controls accessible with many steps at ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${baseUrl}/host?scenario=many-steps`);
    const setup = page.frameLocator("iframe");
    await describe(setup);
    const finish = setup.getByRole("button", { name: "Finish demonstration" });
    await expect(finish).toBeInViewport({ ratio: 1 });
    await expect(setup.getByRole("complementary", { name: "Captured demonstration steps" })).toBeInViewport();
    await expect(setup.getByText("Recorded action 100", { exact: true })).not.toBeInViewport();
    await setup.getByText("Recorded action 100", { exact: true }).scrollIntoViewIfNeeded();
    await expect(setup.getByText("Recorded action 100", { exact: true })).toBeInViewport();
    await expect(finish).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `e2e-artifacts/recording-${viewport.width}.png` });
  });
}

test("refreshes the same demonstration after a temporary status failure", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${baseUrl}/host?scenario=recording-poll-failed`);
  const setup = page.frameLocator("iframe");
  await describe(setup);
  await page.clock.runFor(2_100);
  await expect(setup.getByRole("alert")).toContainText("Could not refresh the demonstration.");
  await setup.getByRole("button", { name: "Retry status" }).click();
  await expect(setup.getByRole("alert")).toHaveCount(0);
  await expect(setup.getByText("Open the reports section", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("Open the reports section");
});

test("keeps reviewed edits when an earlier recording poll arrives late", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${baseUrl}/host?scenario=late-recording-poll`);
  const setup = page.frameLocator("iframe");
  await describe(setup);
  await page.clock.runFor(2_100);
  await setup.getByRole("button", { name: "Finish demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();
  await setup.getByLabel("Step 1 description").fill("Keep this reviewed instruction");
  await page.clock.runFor(2_000);
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("Keep this reviewed instruction");
  await setup.getByRole("button", { name: "Back to demonstration" }).click();
  await expect(setup.getByText("Demonstration finished", { exact: true })).toBeVisible();
});

test("recovers the current test result after a temporary status failure", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=test-poll-failed`);
  const setup = page.frameLocator("iframe");
  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByRole("alert")).toContainText("Could not refresh the test result.");
  await expect(setup.getByRole("button", { name: "Run test" })).toBeDisabled();
  await setup.getByRole("button", { name: "Retry status" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await expect(setup.getByRole("alert")).toHaveCount(0);
});

test("distinguishes opening from an unavailable browser and permits restart", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${baseUrl}/host?scenario=browser-unavailable`);
  const setup = page.frameLocator("iframe");
  await describe(setup);
  await expect(setup.getByText("Opening the virtual browser. This can take a few seconds.")).toBeVisible();
  await page.clock.runFor(15_100);
  await expect(setup.getByText("The virtual browser is unavailable. Start over to open a new session.")).toBeVisible();
  await setup.getByRole("button", { name: "Start over" }).click();
  await expect(setup.getByRole("heading", { name: "Describe the job" })).toBeVisible();
});

test("reloads a browser that loaded an error page", async ({ page }) => {
  let firstLoad = true;
  await page.route("https://live.browserbase.com/**", (route) => {
    const body = firstLoad ? "<h1>Browser connection failed</h1>" : "<h1>Demonstration website recovered</h1>";
    firstLoad = false;
    return route.fulfill({ contentType: "text/html", body });
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${baseUrl}/host?scenario=success`);
  const setup = page.frameLocator("iframe");
  await describe(setup);
  const browser = setup.frameLocator('iframe[title="Virtual browser"]');
  await expect(browser.getByRole("heading", { name: "Browser connection failed" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Reload browser" })).toBeInViewport({ ratio: 1 });
  await setup.getByRole("button", { name: "Reload browser" }).click();
  await expect(browser.getByRole("heading", { name: "Demonstration website recovered" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Reload browser" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Finish demonstration" })).toBeInViewport({ ratio: 1 });
});

test("shows recorded navigation destinations while editing their purpose", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=navigation`);
  const setup = page.frameLocator("iframe");
  await describeAndDemonstrate(setup);
  await expect(setup.getByText("Recorded destination: https://portal.example.test/reports", { exact: true })).toBeVisible();
  await setup.getByLabel("Step 1 description").fill("Find the annual report");
  await expect(setup.getByText("Recorded destination: https://portal.example.test/reports", { exact: true })).toBeVisible();
});

async function describe(setup: FrameLocator): Promise<void> {
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
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

function hostPage(url: string): string {
  const encodedOrigin = encodeURIComponent(url);
  return `<!doctype html>
<html><body><iframe src="${url}/?parentOrigin=${encodedOrigin}" title="Agent setup"></iframe>
<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{height:100vh}</style>
<script>
  let scenario = new URLSearchParams(location.search).get("scenario");
  let readyAttempts = 0;
  let saveAttempts = 0;
  let testAttempts = 0;
  let recordingPolls = 0;
  let testPolls = 0;
  window.__requestIds = [];
  window.__testArguments = [];
  window.__scheduleArguments = [];
  window.__closeRequests = [];
  window.__savedAgents = [];
  let recordingActive = false;
  const steps = [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: "The reports list is visible" },
    ...(scenario === "form-entry" ? [{ id: "choose-month", type: "input", description: "Choose the statement month", target: "Statement month", value: "recorded-private-value" }] : []),
    { id: "download", type: "click", description: "Download the statement", target: "Download statement" }
  ];
  if (scenario === "many-steps") steps.splice(0, steps.length, ...Array.from({ length: 100 }, (_, index) => ({ id: String(index), type: "click", description: "Recorded action " + (index + 1), target: "Reports" })));
  if (scenario === "navigation") steps[0] = { id: "navigation", type: "navigation", description: "Open the reports section", url: "https://portal.example.test/reports" };
  const recording = (status) => ({ id: "recording-1", status: scenario === "expired" ? "expired" : status, liveViewUrl: scenario === "browser-unavailable" ? null : "https://live.browserbase.com/session", steps: scenario === "empty" ? [] : steps, expiresAt: new Date(Date.now() + 900000).toISOString(), blockedReason: scenario === "blocked" ? "This demonstration cannot be used. Start over." : null });
  addEventListener("message", (event) => {
    const request = event.data;
    if (request?.type !== "workflow-use:request") return;
    window.__requestIds.push(request.id);
    const send = (result) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, result }, event.origin);
    const fail = (error) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, error }, event.origin);
    if (request.method === "ready") {
      if (scenario === "ready-failed" && ++readyAttempts === 1) fail("Connection unavailable.");
      else if (scenario === "delayed-ready") setTimeout(() => send({ schedule: true }), 300);
      else send({ schedule: true });
    } else if (request.method === "startRecording") { if (recordingActive) { fail("Finish the current demonstration first."); return; } recordingActive = true; send(recording("recording")); }
    else if (request.method === "getRecording" || request.method === "stopRecording") {
      if (request.method === "getRecording" && scenario === "recording-poll-failed" && ++recordingPolls === 1) fail("Temporary connection problem.");
      else if (request.method === "getRecording" && scenario === "late-recording-poll") setTimeout(() => send(recording("recording")), 1500);
      else send(recording(request.method === "stopRecording" ? "stopped" : "recording"));
    }
    else if (request.method === "cancelRecording") { recordingActive = false; scenario = "success"; send(undefined); }
    else if (request.method === "saveAgent") { window.__savedAgents.push(request.params); if (++saveAttempts === 2 && scenario === "retry-save-failed") fail("Try the test again."); else send({ id: "agent-1" }); }
    else if (request.method === "testAgent") { window.__testArguments.push(request.params.arguments); if (++testAttempts === 2 && scenario === "retry-start-failed") fail("Try the test again."); else send({ id: "run-" + testAttempts }); }
    else if (request.method === "getTestRun") {
      if (scenario === "test-poll-failed" && ++testPolls === 1) fail("Temporary connection problem.");
      else if (scenario === "running") send({ status: "running" });
      else if (scenario === "no-files") send({ status: "succeeded", files: [] });
      else if (scenario === "failed") send({ status: "failed", error: "The website rejected the request." });
      else send({ status: "succeeded", files: [{ name: "statement.pdf", url: "https://files.example.test/statement.pdf" }] });
    } else if (request.method === "scheduleAgent") { window.__savedSchedule = request.params.cron; window.__scheduleArguments.push(request.params.arguments); send(undefined); }
    else if (request.method === "close") { window.__closeRequests.push(request.params); send(undefined); }
    else fail("Unknown request");
  });
</script></body></html>`;
}
