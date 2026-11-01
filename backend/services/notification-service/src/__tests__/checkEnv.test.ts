import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("checkEnv", () => {
  it("does nothing when everything is set", async () => {
    for (const k of KEYS) process.env[k] = "x";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("../lib/checkEnv.js");
    expect(exit).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("exits 1 listing exactly the missing variables", async () => {
    process.env.SUPABASE_URL = "x";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "";
    delete process.env.JWT_SECRET;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("../lib/checkEnv.js");
    expect(exit).toHaveBeenCalledWith(1);
    expect(console.error).toHaveBeenCalledWith(
      "Missing required environment variable(s): SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET\nSet them in backend/.env (see backend/.env.example).",
    );
  });
});
