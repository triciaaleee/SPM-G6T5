import { defineConfig } from "vitest/config";

/**
 * Separate from vitest.config.ts on purpose: these tests hit the real
 * (shared dev) Supabase project over the network — slower, and never run
 * implicitly.
 */
export default defineConfig({
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    retry: 1,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
