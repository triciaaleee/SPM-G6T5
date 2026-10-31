import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("dotenv");
  vi.doUnmock("@supabase/supabase-js");
});

describe("lib/env", () => {
  it("loads the single shared backend/.env", async () => {
    const config = vi.fn();
    vi.doMock("dotenv", () => ({ default: { config } }));
    await import("../lib/env.js");
    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith({ path: "../../.env" });
  });
});

describe("lib/supabaseAdmin", () => {
  it("creates a service-role client from the environment that keeps no session", async () => {
    const client = { marker: "client" };
    const createClient = vi.fn(() => client);
    vi.doMock("@supabase/supabase-js", () => ({ createClient }));
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");

    const { supabaseAdmin } = await import("../lib/supabaseAdmin.js");

    expect(supabaseAdmin).toBe(client);
    expect(createClient).toHaveBeenCalledWith("https://example.supabase.co", "service-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("falls back to empty strings when the variables are missing", async () => {
    const createClient = vi.fn(() => ({}));
    vi.doMock("@supabase/supabase-js", () => ({ createClient }));
    vi.stubEnv("SUPABASE_URL", undefined);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);

    await import("../lib/supabaseAdmin.js");

    expect(createClient).toHaveBeenCalledWith("", "", expect.any(Object));
  });
});
