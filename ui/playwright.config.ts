import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { browserName: "chromium", headless: true, timezoneId: "UTC" },
  webServer: { command: "npm run dev -- --host 127.0.0.1 --port 4173", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI },
});
