import { defineConfig } from "vitest/config";

/**
 * Separate from vitest.config.ts on purpose: these tests hit the real
 * (shared dev) Supabase project over the network — slower, and never run
 * implicitly. Invoked only via `npm run test:integration`.
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    retry: 1,
    // Real network calls (Supabase) + real bcrypt (cost 10) are both slower
    // than the mocked unit suite's default budget.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
