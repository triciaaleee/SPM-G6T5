import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // supertest starts each test app on a random port bound to every
    // interface. On macOS that port can already belong to a loopback-only
    // listener from another app (Notion, VS Code, Figma): the OS lets both
    // bind, so the request reaches the other app and the test fails at random
    // with a 404 or "socket hang up". Each test gets a fresh port on a retry,
    // so a real failure still fails after three attempts.
    retry: 2,
    // Integration tests hit the real (shared dev) Supabase project and have
    // their own config (vitest.integration.config.ts) — they must never run
    // as a side effect of `npm test` or a coverage run.
    exclude: [...configDefaults.exclude, "src/__tests__/integration/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts"],
    },
  },
});
