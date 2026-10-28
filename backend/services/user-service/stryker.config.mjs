// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "npm",
  testRunner: "vitest",
  // Mirrors vitest.config.ts's coverage include/exclude: mutate the same
  // source this service's unit suite is already measured against, and
  // skip the process bootstrap (src/index.ts) and the tests themselves.
  mutate: ["src/**/*.ts", "!src/__tests__/**", "!src/index.ts"],
  // Mutation testing only runs the mocked unit suite — the integration
  // suite hits the real dev Supabase project and has its own script
  // (npm run test:integration), same reasoning as vitest.config.ts.
  vitest: {
    configFile: "vitest.config.ts",
  },
  reporters: ["html", "json", "clear-text", "progress"],
  coverageAnalysis: "perTest",
  concurrency: 4,
};

export default config;
