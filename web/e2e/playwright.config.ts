import { defineConfig, devices } from "@playwright/test";

/** E2E against a demo-data server. Point E2E_BASE_URL at it (default http://localhost:4242). Never at a live pump. */
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false, // the flows post real vouchers into the demo DB; keep them ordered
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4242",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block", // the PWA worker would serve a stale bundle between runs
    locale: "en-PK",
    timezoneId: "Asia/Karachi",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
