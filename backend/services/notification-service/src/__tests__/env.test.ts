import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * env.ts is a side-effect-only module (see its own comment on why it must
 * be the first import). Each test re-imports it fresh via vi.resetModules()
 * so the module-scope dotenv.config() call runs again under a fresh mock.
 */
describe("lib/env.ts", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("loads the single shared backend .env file, not any other path", async () => {
    const configSpy = vi.fn();
    vi.doMock("dotenv", () => ({ default: { config: configSpy }, config: configSpy }));

    await import("../lib/env.js");

    expect(configSpy).toHaveBeenCalledOnce();
    expect(configSpy).toHaveBeenCalledWith({ path: "../../.env" });
  });
});
