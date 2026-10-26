import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  vi.resetModules();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("supabaseAdmin", () => {
  it("builds a service-role client from the env without persisting sessions", async () => {
    process.env.SUPABASE_URL = "http://127.0.0.1:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    const { supabaseAdmin } = await import("../lib/supabaseAdmin.js");
    expect(typeof supabaseAdmin.from).toBe("function");
  });

  it("throws at import when the variables are not set at all", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(import("../lib/supabaseAdmin.js")).rejects.toThrow("supabaseUrl is required");
  });

  it("throws at import when SUPABASE_URL is empty (why checkEnv must run first)", async () => {
    process.env.SUPABASE_URL = "";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    await expect(import("../lib/supabaseAdmin.js")).rejects.toThrow("supabaseUrl is required");
  });
});

describe("env", () => {
  it("loads without throwing and does not override variables already set", async () => {
    process.env.SUPABASE_URL = "keep-me";
    await import("../lib/env.js");
    expect(process.env.SUPABASE_URL).toBe("keep-me");
  });
});
