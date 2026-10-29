import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dotenv = vi.hoisted(() => ({ config: vi.fn() }));
vi.mock("dotenv", () => ({ default: dotenv, config: dotenv.config }));

describe("lib/env", () => {
  it("loads the single shared backend/.env, relative to the service folder", async () => {
    vi.resetModules();
    dotenv.config.mockClear();
    await import("../lib/env.js");
    expect(dotenv.config).toHaveBeenCalledTimes(1);
    expect(dotenv.config).toHaveBeenCalledWith({ path: "../../.env" });
  });
});

describe("lib/supabaseAdmin", () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    for (const [name, value] of [["SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("builds the service-role client from the environment, without persisting a session", async () => {
    process.env.SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { supabaseAdmin } = await import("../lib/supabaseAdmin.js");
    expect(typeof supabaseAdmin.from).toBe("function");
    expect((supabaseAdmin as any).supabaseUrl).toBe("http://localhost:54321");
    expect((supabaseAdmin as any).supabaseKey).toBe("service-role-key");
  });

  it("with no URL configured the client refuses to build (so a bad .env fails at boot, not mid-request)", async () => {
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
    await expect(import("../lib/supabaseAdmin.js")).rejects.toThrow(/supabaseUrl is required/);
  });

  it("with a URL but no key it also refuses", async () => {
    process.env.SUPABASE_URL = "http://localhost:54321";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(import("../lib/supabaseAdmin.js")).rejects.toThrow(/supabaseKey is required/);
  });
});
