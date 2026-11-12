import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.test", quiet: true });

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // `next dev` compiles on demand; give first renders room.
  expect: { timeout: 10_000 },
  // Every test shares one database, so tests run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  reporter: process.env["CI"] ? "github" : "html",
  webServer: {
    command: "pnpm dev",
    port: 3000,
    reuseExistingServer: !process.env["CI"],
    env: {
      E2E_AUTH_BYPASS: "true",
      AUTH_SECRET: process.env["AUTH_SECRET"] ?? "test-secret-for-e2e-only",
      DATABASE_URL: process.env["DATABASE_URL"] ?? "",
    },
  },
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
});
