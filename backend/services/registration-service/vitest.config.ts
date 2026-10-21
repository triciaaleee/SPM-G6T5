import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // supertest starts each test app on a random port bound to every
    // interface. On macOS that port can already belong to a loopback-only
    // listener from another app (Notion, VS Code, Figma): the OS lets both
    // bind, so the request reaches the other app and the test fails at random
    // with a 404 or "socket hang up". Each test gets a fresh port on a retry,
    // so a real failure still fails after three attempts.
    retry: 2,
  },
});
