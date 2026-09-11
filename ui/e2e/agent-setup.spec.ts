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
  await expect(setup.getByText("Do not enter logins, passwords, one-time codes, or API keys.")).toBeVisible();
  await expect(setup.getByRole("link", { name: "Source code" })).toHaveAttribute("href", "https://github.com/iter8-ai/workflow-use");
  await expect(setup.getByRole("link", { name: "AGPL-3.0 license" })).toHaveAttribute("href", "https://github.com/iter8-ai/workflow-use/blob/main/LICENSE");
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();

  await expect(setup.getByText("Open the reports section")).toBeVisible();
  await setup.getByRole("button", { name: "Stop demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();

  await setup.getByRole("button", { name: "Choose a value each run" }).click();
  await setup.getByLabel("What should we call this value?").fill("Statement month");
  await setup.getByLabel("Example value").fill("2026-08-01");
  await setup.getByRole("button", { name: "Continue to test" }).click();

  await setup.getByLabel("Statement month").fill("2026-09-01");
  await setup.getByRole("button", { name: "Run test" }).click();
  await expect(setup.getByText("Test completed")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__testArguments)).toEqual([{ input_1: "2026-09-01" }]);
  await expect(setup.getByRole("link", { name: "statement.pdf" })).toHaveAttribute("href", "https://files.example.test/statement.pdf");
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toBeDisabled();
  await setup.getByLabel("I checked the result").check();
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toBeDisabled();
  await setup.getByLabel("Schedule daily").check();
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toBeEnabled();
});

test("keeps scheduling disabled after a failed test", async ({ page }) => {
  await page.goto(`${baseUrl}/host?scenario=failed`);
  const setup = page.frameLocator("iframe");

  await completeToTest(setup);
  await setup.getByRole("button", { name: "Run test" }).click();

  await expect(setup.getByText("The website rejected the request.")).toBeVisible();
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toBeDisabled();
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
  await expect(setup.getByRole("button", { name: "Schedule agent" })).toBeDisabled();
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
  await setup.getByRole("button", { name: "Stop demonstration" }).click();
  await page.screenshot({ path: "e2e-artifacts/demonstrate.png" });

  await setup.getByRole("button", { name: "Continue to review" }).click();
  await page.screenshot({ path: "e2e-artifacts/review.png" });

  await setup.getByRole("button", { name: "Choose a value each run" }).click();
  await setup.getByLabel("What should we call this value?").fill("Statement month");
  await setup.getByLabel("Example value").fill("2026-08-01");
  await setup.getByRole("button", { name: "Continue to test" }).click();
  await page.screenshot({ path: "e2e-artifacts/test.png" });
});

async function completeToTest(setup: FrameLocator): Promise<void> {
  await setup.getByLabel("Agent name").fill("Download monthly statement");
  await setup.getByLabel("Website address").fill("https://portal.example.test/reports");
  await setup.getByLabel("What should the agent do?").fill("Download the selected monthly statement.");
  await setup.getByRole("button", { name: "Continue to demonstration" }).click();
  await setup.getByRole("button", { name: "Stop demonstration" }).click();
  await setup.getByRole("button", { name: "Continue to review" }).click();
  await setup.getByRole("button", { name: "Choose a value each run" }).click();
  await setup.getByLabel("What should we call this value?").fill("Statement month");
  await setup.getByLabel("Example value").fill("2026-08-01");
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
  const steps = [
    { id: "open-reports", type: "click", description: "Open the reports section", target: "Reports", expectedOutcome: "The reports list is visible" },
    { id: "choose-month", type: "input", description: "Choose the statement month", target: "Statement month", value: "2026-08-01" },
    { id: "download", type: "click", description: "Download the statement", target: "Download statement" }
  ];
  addEventListener("message", (event) => {
    const request = event.data;
    if (request?.type !== "workflow-use:request") return;
    window.__requestIds.push(request.id);
    const send = (result) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, result }, event.origin);
    const fail = (error) => event.source.postMessage({ type: "workflow-use:response", version: 1, id: request.id, error }, event.origin);
    if (request.method === "ready") {
      if (scenario === "delayed-ready") setTimeout(() => send({ schedule: true }), 300);
      else send({ schedule: true });
    } else if (request.method === "startRecording") send({ id: "recording-1", status: "recording", liveViewUrl: "https://live.browserbase.com/session", steps, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null });
    else if (request.method === "getRecording" || request.method === "stopRecording") send({ id: "recording-1", status: "stopped", liveViewUrl: "https://live.browserbase.com/session", steps, expiresAt: "2026-09-11T12:00:00Z", blockedReason: null });
    else if (request.method === "cancelRecording") send(undefined);
    else if (request.method === "saveAgent") send({ id: "agent-1" });
    else if (request.method === "testAgent") { window.__testArguments.push(request.params.arguments); send({ id: "run-1" }); }
    else if (request.method === "getTestRun") {
      if (scenario === "failed") send({ status: "failed", error: "The website rejected the request." });
      else send({ status: "succeeded", files: [{ name: "statement.pdf", url: "https://files.example.test/statement.pdf" }] });
    } else if (request.method === "scheduleAgent" || request.method === "close") send(undefined);
    else fail("Unknown request");
  });
</script></body></html>`;
}
