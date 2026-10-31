import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_NOW } from "./helpers/testClock.js";

vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { marker: "service-role-client" } }));

import { requireAuth } from "../middleware/auth.js";

const SECRET = "mw-secret";

function app() {
  const a = express();
  a.get("/me", requireAuth, (req, res) => {
    res.json({ user: (req as any).user, supabase: (req as any).supabase });
  });
  return a;
}

afterEach(() => vi.unstubAllEnvs());

describe("requireAuth", () => {
  it("401 no_token without an Authorization header", async () => {
    vi.stubEnv("JWT_SECRET", SECRET);
    const res = await request(app()).get("/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Missing bearer token", code: "no_token" });
  });

  it("401 no_token when the header is not a Bearer token", async () => {
    vi.stubEnv("JWT_SECRET", SECRET);
    const res = await request(app()).get("/me").set("Authorization", `Basic ${jwt.sign({ sub: "a", role: "b" }, SECRET)}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("no_token");
  });

  it("401 no_token for an empty Bearer value", async () => {
    vi.stubEnv("JWT_SECRET", SECRET);
    const res = await request(app()).get("/me").set("Authorization", "Bearer ");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("no_token");
  });

  it("401 token_expired for an aged-out token", async () => {
    vi.stubEnv("JWT_SECRET", SECRET);
    const token = jwt.sign({ sub: "a", role: "b", exp: Math.floor(TEST_NOW.getTime() / 1000) - 5 }, SECRET);
    const res = await request(app()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Your session has expired. Please log in again.", code: "token_expired" });
  });

  it("401 invalid_token for a forged or garbled token", async () => {
    vi.stubEnv("JWT_SECRET", SECRET);
    for (const token of [jwt.sign({ sub: "a", role: "b" }, "other-secret"), "garbage"]) {
      const res = await request(app()).get("/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Invalid token", code: "invalid_token" });
    }
  });

  it("attaches the user and the service-role client and calls next", async () => {
    vi.stubEnv("JWT_SECRET", SECRET);
    const token = jwt.sign({ sub: "TS-0001", role: "technical_support" }, SECRET);
    const res = await request(app()).get("/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: "TS-0001", role: "technical_support" });
    expect(res.body.supabase).toEqual({ marker: "service-role-client" });
  });
});
