import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // supertest binds each test app to every interface, which on macOS can
    // collide with a loopback-only listener from another app and fail a test
    // at random. vitest.setup.ts binds it to 127.0.0.1 instead, which removes
    // the cause — so there is deliberately no `retry` here: a retry would only
    // hide a flaky test, and a real failure should fail the first time.
    setupFiles: ["./vitest.setup.ts"],
    // Integration tests hit the real (shared dev) Supabase project and have
    // their own config/script (vitest.integration.config.ts, npm run
    // test:integration) — they must never run as a side effect of `npm test`
    // or `npm run test:coverage`. `.stryker-tmp` is Stryker's sandbox copy.
    exclude: [...configDefaults.exclude, "src/__tests__/integration/**", ".stryker-tmp/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts", "src/**/*.fake.ts"],
      // Every file is at 100% today; this keeps it there.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
