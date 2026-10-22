import { defineConfig, devices } from "@playwright/test";

/**
 * Real backend, real database, nothing mocked — the seam-catching layer on
 * top of backend unit tests and frontend Vitest+mocked tests. Tests live in
 * e2e/ and are named *.e2e.ts (never *.test.ts), so Vitest's default glob
 * never picks them up and this config's testMatch never picks up Vitest's
 * unit tests — no shared glob to keep in sync.
 */
const PORT = 5173;
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A test that passes on its second try is a flaky test; a retry would
  // hide that signal instead of surfacing it. See e2e/README.md.
  retries: 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Builds and serves the production build — this suite tests what ships,
  // not the dev server's behaviour. Points at whatever VITE_* API URLs are
  // in frontend/.env at build time, same as a real deploy would.
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
