import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * supabaseAdmin.ts builds its client from process.env at module-load time.
 * Each test re-imports it fresh via vi.resetModules() under a mocked
 * createClient so the constructor args are observable.
 */
describe("lib/supabaseAdmin.ts", () => {
  const originalUrl = process.env.SUPABASE_URL;
  const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.SUPABASE_URL = originalUrl;
    process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
  });

  it("builds a service-role client from SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, with no session persistence", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const createClientSpy = vi.fn().mockReturnValue({ marker: "fake-client" });
    vi.doMock("@supabase/supabase-js", () => ({ createClient: createClientSpy }));

    await import("../lib/supabaseAdmin.js");

    expect(createClientSpy).toHaveBeenCalledWith("https://example.supabase.co", "service-role-key", {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  });

  it("falls back to empty strings rather than passing undefined when env vars are unset", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const createClientSpy = vi.fn().mockReturnValue({ marker: "fake-client" });
    vi.doMock("@supabase/supabase-js", () => ({ createClient: createClientSpy }));

    await import("../lib/supabaseAdmin.js");

    expect(createClientSpy).toHaveBeenCalledWith(
      "",
      "",
      expect.objectContaining({ auth: { persistSession: false, autoRefreshToken: false } }),
    );
  });
});
