import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const supabaseStub = vi.hoisted(() => ({ marker: "service-role-client" }));
vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: supabaseStub }));

import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

const SECRET = "test-secret";

function buildApp() {
  const app = express();
  app.get("/guarded", requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.user, sameClient: req.supabase === (supabaseStub as unknown) });
  });
  return app;
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.JWT_SECRET;
});

describe("requireAuth", () => {
  it("attaches the verified user and the service-role client", async () => {
    const token = jwt.sign({ sub: "COORD-0001", role: "coordinator" }, SECRET, { expiresIn: "1h" });
    const res = await request(buildApp()).get("/guarded").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: "COORD-0001", role: "coordinator" }, sameClient: true });
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await request(buildApp()).get("/guarded");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Missing bearer token", code: "no_token" });
  });

  it.each(["Basic abc", "bearer abc", "Bearer", "abc"])("treats %j as no bearer token", async (header) => {
    const res = await request(buildApp()).get("/guarded").set("Authorization", header);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Missing bearer token", code: "no_token" });
  });

  it("tells an expired token apart from a forged one", async () => {
    const token = jwt.sign({ sub: "COORD-0001", role: "coordinator" }, SECRET, { expiresIn: -1 });
    const res = await request(buildApp()).get("/guarded").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Your session has expired. Please log in again.", code: "token_expired" });
  });

  it("rejects a token signed with another secret", async () => {
    const token = jwt.sign({ sub: "COORD-0001", role: "coordinator" }, "other-secret");
    const res = await request(buildApp()).get("/guarded").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid token", code: "invalid_token" });
  });

  it("rejects a malformed token", async () => {
    const res = await request(buildApp()).get("/guarded").set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid_token");
  });
});
