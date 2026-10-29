// @ts-nocheck
// 
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

// Event times are Singapore wall-clock time and must not depend on the server's zone. Running the
// suite in a zone that is not UTC+8 makes any code that quietly relies on the local zone fail.
process.env.TZ = process.env.TEST_TZ ?? "America/Los_Angeles";

export default defineConfig({
  test: {
    setupFiles: ["./src/__tests__/setup.ts"],
    // supertest is replaced by an in-process stand-in: no sockets, so no port or connection-reuse flakiness.
    alias: { supertest: fileURLToPath(new URL("./src/__tests__/supertestInProcess.ts", import.meta.url)) },
    // No retries: a test that passes only on a second attempt is a flaky test, and it should fail where it is seen.
    // (supertest is replaced by an in-process stand-in above, so the old port clashes that needed retries cannot happen.)
    retry: 0,
    // Integration tests hit the real (shared dev) Supabase project and have
    // their own config/script (vitest.integration.config.ts, npm run
    // test:integration) — they must never run as a side effect of `npm test`
    // or `npm run test:coverage`.
    exclude: [
      ...configDefaults.exclude,
      "src/__tests__/integration/**",
      // Stryker works in copies of the project; their tests must not be picked up as extra test files.
      "**/.stryker-tmp*/**",
      // The route sweep takes about a minute and touches every route, so under Stryker it
      // would re-run for every mutant. Mutation testing uses the focused suites instead.
      ...(process.env.MUTATION_RUN ? ["src/__tests__/routeMatrix.test.ts"] : []),
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // index.ts only boots the server (covered by the CI smoke test).
      exclude: ["src/__tests__/**", "src/index.ts"],
      // Every file is at 100% today; this keeps it there.
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
});
