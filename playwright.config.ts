import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: ".context/playwright-results",
  reporter: "list",
  use: {
    baseURL: process.env.LAB_BASE_URL ?? "http://127.0.0.1:3000",
    browserName: "chromium",
    channel: "chrome",
    trace: "retain-on-failure",
  },
});
