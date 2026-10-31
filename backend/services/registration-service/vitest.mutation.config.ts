import { configDefaults, defineConfig } from "vitest/config";

/**
 * Used only by Stryker (npm run test:mutation). No retries: a mutant must be
 * killed on the first run, and a flaky pass-on-retry would hide a survivor.
 */
export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    exclude: [...configDefaults.exclude, "src/__tests__/integration/**", ".stryker-tmp/**"],
  },
});
