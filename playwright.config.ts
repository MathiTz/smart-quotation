import { defineConfig, devices } from "@playwright/test";

/**
 * One browser, one happy path. The point is to catch the wiring the unit tests
 * cannot see — the upload form reaching the parser, the SSE stream reaching the
 * transcript, the Convert button reaching a purchase order — not to re-test the
 * arithmetic that already has coverage.
 *
 * Both servers are started here so `pnpm test:e2e` works from a clean shell.
 * Postgres is assumed to be up already: see `pnpm db:up`.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @sq/api start",
      url: "http://localhost:8787/health",
      reuseExistingServer: true,
      timeout: 60_000,
      env: { SQ_OFFLINE: "1" },
    },
    {
      command: "pnpm --filter @sq/web dev",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
