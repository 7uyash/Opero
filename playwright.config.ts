import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests of the main screens, against a running app (`pnpm dev` + `pnpm dev:worker`).
 * One worker, one browser: these are memory-hungry and share the app's database.
 * Set PW_CHANNEL=chrome to use an installed Chrome instead of `npx playwright install chromium`.
 */
export default defineConfig({
  testDir: "./e2e/browser",
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
    channel: process.env.PW_CHANNEL || undefined,
  },
  outputDir: "./e2e/.results",
});
