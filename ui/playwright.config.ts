import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  // test:e2e:local sets PLAYWRIGHT_CHANNEL=chrome to use the installed Google Chrome; CI keeps Playwright's Chromium.
  use: { browserName: "chromium", channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true, timezoneId: "UTC" },
  webServer: { command: `npm run dev -- --host 127.0.0.1 --port ${new URL(baseURL).port || "4173"} --strictPort`, url: baseURL, reuseExistingServer: !process.env.CI },
});
