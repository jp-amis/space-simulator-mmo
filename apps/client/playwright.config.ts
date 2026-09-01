import { defineConfig, devices } from "@playwright/test";

// Boots both the authoritative game server (NPCs disabled for determinism) and the
// Vite dev client, then runs the visual/e2e suite against a real browser.
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "pnpm --filter @space/server exec tsx src/index.ts",
      port: 8080,
      reuseExistingServer: false,
      env: { SEED_NPCS: "false", LOG_LEVEL: "warn" },
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @space/client exec vite --port 5173 --strictPort",
      port: 5173,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
