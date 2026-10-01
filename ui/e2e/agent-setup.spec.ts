import { expect, test, type FrameLocator } from "@playwright/test";

const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";

test.beforeEach(async ({ page }) => {
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
  await expect(setup.getByText("Reiterate saves the username and password you type there, encrypted", { exact: false })).toBeVisible();
  await expect(setup.getByRole("link", { name: "Source code" })).toHaveAttribute("href", "https://github.com/iter8-ai/workflow-use");
  await expect(setup.getByRole("link", { name: "AGPL-3.0 license" })).toHaveAttribute("href", "https://github.com/iter8-ai/workflow-use/blob/main/LICENSE");
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await expect(setup.getByText("Changes require a new test.")).toHaveCount(0);
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
  await setup.getByLabel("Time of day").fill("09:30");
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

  await expect(setup.getByText("Test is running.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Test running…" })).toBeDisabled();
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

test("keeps scheduling disabled after a failed test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=failed`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();

  await expect(setup.getByText("Test failed")).toBeVisible();
  await expect(setup.getByText("The website rejected the request.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Run test again" })).toBeEnabled();
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
    await expect(setup.getByText("Daily 09:00 UTC · next run 02.10.2026 at 14:30", { exact: true })).toBeVisible();
  });

  test("schedules the daily run at the user's local time", async ({ page }) => {
    await page.goto(`${baseUrl}/host?scenario=success`);
    const setup = page.frameLocator("iframe");

    await completeToTest(setup);
    await setup.getByRole("button", { name: "Run test" }).click();
    await expect(setup.getByText("Test completed")).toBeVisible();
    await setup.getByLabel("I checked the result").check();
    await setup.getByLabel("Schedule daily").check();
    await expect(setup.getByLabel("Time of day")).toHaveValue("09:00");
    await setup.getByLabel("Time of day").fill("09:30");
    await expect(setup.getByText("Runs at 04:00 UTC.")).toBeVisible();
    await setup.getByRole("button", { name: "Schedule agent" }).click();
    await expect.poll(() => page.evaluate(() => window.__savedSchedule)).toEqual("0 4 * * *");
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
  await expect(setup.getByText("Test completed")).toBeVisible();
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
  await expect(setup.getByText("signs in with the username, password from your demonstration")).toBeVisible();
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByRole("button", { name: "Run test" }).click();
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
  await expect(setup.getByText("Test completed")).toBeVisible();
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

test("keeps the editor cards in the main column and Changes in a sticky rail", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/host?scenario=edit-schedule`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByText("Daily 09:00 UTC · next run 02.10.2026 at 09:00", { exact: true })).toBeVisible();
  const details = await setup.getByRole("heading", { name: "Details", exact: true }).boundingBox();
  const steps = await setup.getByRole("heading", { name: "Steps", exact: true }).boundingBox();
  const changes = await setup.getByRole("heading", { name: "Changes", exact: true }).boundingBox();
  expect(details).not.toBeNull();
  expect(steps?.x).toBe(details?.x);
  expect(changes?.y).toBe(details?.y);
  expect(changes!.x).toBeGreaterThan(steps!.x + 500);
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeInViewport();
  await expect(setup.locator(".edit-rail")).toHaveCSS("position", "sticky");
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

test("requires a fresh draft test after a successful rename", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit`);
  const setup = page.frameLocator("iframe");
  await setup.getByLabel("Step 1 description").fill("Updated reports section");
  await setup.getByRole("button", { name: "Test draft" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeEnabled();
  await setup.getByLabel("Agent name").fill("Renamed report agent");
  await setup.getByLabel("Agent name").blur();
  await expect(setup.getByText("Test completed")).toHaveCount(0);
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeDisabled();
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
  const rail = setup.locator(".edit-rail");
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
  await setup.getByRole("button", { name: "Test draft" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  const label = await setup.locator(".result-check").boundingBox();
  expect(label!.height).toBeLessThan(25);
  const check = await setup.getByLabel("I checked the result").boundingBox();
  const publish = await setup.getByRole("button", { name: "Publish changes" }).boundingBox();
  expect(Math.abs(check!.y + check!.height / 2 - publish!.y - publish!.height / 2)).toBeLessThan(2);
  await page.screenshot({ path: "e2e-artifacts/edit-tested.png" });
  await setup.getByRole("button", { name: "Publish changes" }).click();
  await expect(setup.getByText("Timers will use v4 at the next run time.")).toBeVisible();
});

test("shows the conflict modal and supports overwrite or discard", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/host?scenario=edit-conflict`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await setup.getByLabel("Step 1 description").fill("Changed locally");
  await setup.getByRole("button", { name: "Test draft" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await setup.getByRole("button", { name: "Publish changes" }).click();
  await setup.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(setup.getByRole("heading", { name: "Agent change conflict" })).toBeVisible();
  await expect(setup.getByRole("dialog")).toHaveCount(1);
  await expect(setup.getByText("teammate@example.test", { exact: true })).toBeVisible();
  await expect(setup.getByText("01.10.2026 at 10:00", { exact: true })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Overwrite their changes" })).toBeVisible();
  await expect(setup.getByRole("button", { name: "Discard my changes" })).toBeVisible();
  await page.screenshot({ path: "e2e-artifacts/edit-conflict.png" });
  await setup.getByRole("button", { name: "Overwrite their changes" }).click();
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();

  await page.goto(`${baseUrl}/host?scenario=edit-conflict`);
  const discarded = page.frameLocator("iframe");
  await expect(discarded.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await discarded.getByLabel("Step 1 description").fill("Discarded locally");
  await discarded.getByRole("button", { name: "Test draft" }).click();
  await expect(discarded.getByText("Test completed")).toBeVisible();
  await discarded.getByLabel("I checked the result").check();
  await discarded.getByRole("button", { name: "Publish changes" }).click();
  await discarded.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(discarded.getByRole("heading", { name: "Agent change conflict" })).toBeVisible();
  await discarded.getByRole("button", { name: "Discard my changes" }).click();
  await expect(discarded.getByLabel("Step 1 description")).toHaveValue("Open the reports section");
  await expect(discarded.getByRole("heading", { name: "Publish changes?" })).toHaveCount(0);
});

test("retries a failed draft test and then enables checked publish", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=edit-fail-pass`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Edit web agent" })).toBeVisible();
  await setup.getByLabel("Step 1 description").fill("Retry the updated reports section");
  await setup.getByRole("button", { name: "Test draft" }).click();
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
  await setup.getByLabel("What should the agent do?").fill("Download the updated report.");
  const rail = setup.locator(".edit-rail");
  await expect(rail.getByText("Website address", { exact: true })).toBeVisible();
  await expect(rail.getByText("Goal", { exact: true })).toBeVisible();
  await setup.getByRole("button", { name: "Test draft" }).click();
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
  await expect(setup.getByRole("heading", { name: "Advanced instructions" })).toBeVisible();
  await expect(setup.getByText("Sleep stage · 5 s", { exact: true })).toBeVisible();
  await setup.getByLabel("Agent stage prompt").fill("Updated legacy prompt after reopening");
  await setup.getByRole("button", { name: "Test draft" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await setup.getByLabel("I checked the result").check();
  await expect(setup.getByRole("button", { name: "Publish changes" })).toBeEnabled();
});

test("keeps raw stages and internal agents safe", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/host?scenario=edit-raw`);
  const setup = page.frameLocator("iframe");
  await expect(setup.getByRole("heading", { name: "Advanced instructions" })).toBeVisible();
  for (const label of ["Download stage", "Sleep stage · 5 s", "Reload stage"]) {
    await expect(setup.locator(".raw-preserved").filter({ hasText: label })).toHaveText(`${label}unchanged`);
  }
  await expect(setup.locator("pre.raw-preserved")).toHaveCount(0);
  await page.screenshot({ path: "e2e-artifacts/edit-raw.png" });
  await setup.getByLabel("Agent stage prompt").fill("Updated legacy prompt");
  await expect(setup.getByText("Agent stages")).toBeVisible();
  await setup.getByRole("button", { name: "Test draft" }).click();
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
  await setup.getByRole("button", { name: "Start re-demonstration" }).click();
  await expect(setup.getByTitle("Virtual browser")).toBeVisible();
  await expect(setup.getByTitle("Virtual browser")).toHaveAttribute("src", "https://live.browserbase.com/session");
  await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
  await expect(setup.getByLabel("Step 1 description")).toHaveValue("Open the reports section");
  await expect(setup.getByLabel("Step 2 description")).toHaveValue("Download the refreshed statement");
  await expect.poll(() => page.evaluate(() => window.__renameRequests)).toEqual(["Renamed report agent"]);
  await expect.poll(() => page.evaluate(() => window.__publishRequests)).toEqual([]);
  await expect(setup.getByRole("button", { name: "Start re-demonstration" })).toBeEnabled();
  await setup.getByRole("button", { name: "Start re-demonstration" }).click();
  await expect(setup.getByTitle("Virtual browser")).toBeVisible();
  await setup.getByRole("button", { name: "Finish re-demonstration" }).click();
  await expect(setup.getByRole("alert")).toHaveCount(0);
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
<style>html,body,iframe{margin:0;width:100%;height:100%;border:0}body{min-height:980px}</style>
<script>
  const scenario = new URLSearchParams(location.search).get("scenario");
  window.__requestIds = [];
  window.__testArguments = [];
  window.__scheduleArguments = [];
  window.__closeRequests = [];
  window.__savedAgents = [];
  window.__credentialRequests = [];
  window.__startUrls = [];
  window.__renameRequests = [];
  window.__publishRequests = [];
  let recordingActive = false;
  let recordingExists = false;
  let publishedConflict = false;
  let testAttempts = 0;
  window.__loadAvailable = scenario !== "edit-load-error";
  const edit = scenario.startsWith("edit");
  const editSteps = [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: "The reports list is visible" },
    { id: "download", type: "click", description: "Download the statement", target: "Download statement" },
  ];
  const redemonstrationSteps = [{ id: "download-refreshed", type: "click", description: "Download the refreshed statement", target: "Download statement" }];
  const internal = scenario === "edit-internal";
  const signIn = scenario === "sign-in" || scenario === "sign-in-unsupported";
  const steps = [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: "The reports list is visible" },
    ...(scenario === "form-entry" ? [
      { id: "choose-month", type: "input", description: "Fill in Statement month", target: "Statement month", value: "September 2026" },
      { id: "choose-format", type: "select_change", description: "Choose PDF in Format", target: "Format", value: "PDF" },
    ] : []),
    ...(scenario === "many-steps" ? Array.from({ length: 60 }, (_, index) => ({ id: "scroll-" + index, type: "click", description: "Recorded action " + (index + 1), target: "Item " + (index + 1) })) : []),
    ...(scenario === "ten-steps" ? Array.from({ length: 8 }, (_, index) => ({ id: "filter-" + index, type: "click", description: "Apply report filter " + (index + 1), target: "Filter " + (index + 1), expectedOutcome: index % 2 ? "The filtered list is visible" : null })) : []),
    ...(signIn ? [
      { id: "user", type: "credential", description: "Enter the saved username in Email", target: "Email", value: "username" },
      { id: "pass", type: "credential", description: "Enter the saved password in Password", target: "Password", value: "password" },
    ] : []),
    { id: "download", type: "click", description: "Download the statement", target: "Download statement" }
  ];
  addEventListener("message", (event) => {
    const request = event.data;
    if (request?.type !== "workflow-use:request") return;
    window.__requestIds.push(request.id);
    const send = (result) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, result }, event.origin);
    const fail = (error) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, error }, event.origin);
    if (request.method === "ready") {
      if (scenario === "delayed-ready") setTimeout(() => send({ schedule: true, mode: "create", credentials: true }), 300);
      else send({ schedule: true, mode: edit ? "edit" : "create", credentials: scenario !== "sign-in-unsupported" });
    } else if (request.method === "loadAgent") {
      if (!window.__loadAvailable) { fail("Loading failed. Try again."); return; }
      send({ agentId: "agent-1", name: "Monthly report agent", url: "https://portal.example.test/reports", goal: "Download the monthly report.", steps: scenario === "edit-raw" ? null : scenario === "edit-raw-empty" ? [] : editSteps, stages: [{ type: "agent", prompt: "Open reports", step_limit: 16 }, { type: "download" }, { type: "sleep", sleep_ms: 5000 }, { type: "reload" }], liveConfigId: "config-3", version: 3, internal, schedule: scenario === "edit-schedule" ? "Daily 09:00 UTC" : null, nextRunAt: scenario === "edit-schedule" ? "2026-10-02T09:00:00Z" : null });
    } else if (request.method === "renameAgent") { window.__renameRequests.push(request.params.name); if (scenario === "edit-rename-error" && window.__renameRequests.length === 1) fail("Rename failed. Try again."); else send(null);
    } else if (request.method === "saveDraft") { window.__savedAgents.push(request.params); send({ draftId: "draft-1" });
    } else if (request.method === "publishDraft") {
      window.__publishRequests.push(request.params);
      if (scenario === "edit-conflict" && !request.params.overwrite && !publishedConflict) { publishedConflict = true; send({ conflict: { updatedBy: "teammate@example.test", updatedAt: "2026-10-01T10:00:00Z" } }); }
      else send({ version: 4 });
    } else if (request.method === "requestCredentials") { window.__credentialRequests.push(request.params); send({ saved: request.params.kinds }); } else if (request.method === "startRecording") { window.__startUrls.push(request.params.url); if (edit ? recordingExists : recordingActive) { fail("Finish the current demonstration first."); return; } recordingActive = true; recordingExists = true; send({ id: "recording-1", status: "recording", liveViewUrl: "https://live.browserbase.com/session", steps: scenario.startsWith("edit") ? [] : steps, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null }); }
    else if (request.method === "getRecording") send({ id: "recording-1", status: recordingActive ? "recording" : "stopped", liveViewUrl: "https://live.browserbase.com/session", steps: [], expiresAt: "2026-09-11T12:00:00Z", blockedReason: null });
    else if (request.method === "stopRecording") { recordingActive = false; send({ id: "recording-1", status: "stopped", liveViewUrl: "https://live.browserbase.com/session", steps: scenario.startsWith("edit") ? redemonstrationSteps : steps, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null }); }
    else if (request.method === "cancelRecording") { recordingActive = false; recordingExists = false; send(undefined); }
    else if (request.method === "saveAgent") { window.__savedAgents.push(request.params); send({ id: "agent-1" }); }
    else if (request.method === "testAgent") { testAttempts += 1; window.__testArguments.push(request.params.arguments); send({ id: "run-1" }); }
    else if (request.method === "getTestRun") {
      if (scenario === "failed" || (scenario === "edit-fail-pass" && testAttempts === 1)) send({ status: "failed", error: "The website rejected the request." });
      else if (scenario === "watch") send({ status: "running", liveViewUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html" });
      else send({ status: "succeeded", files: [{ name: "statement.pdf", url: "https://files.example.test/statement.pdf" }] });
    } else if (request.method === "scheduleAgent") { window.__savedSchedule = request.params.cron; window.__scheduleArguments.push(request.params.arguments); send(undefined); }
    else if (request.method === "close") { window.__closeRequests.push(request.params); send(undefined); }
    else fail("Unknown request");
  });
</script></body></html>`;
}
