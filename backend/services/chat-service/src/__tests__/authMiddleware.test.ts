import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { __marker: "admin" } }));

import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

const SECRET = "unit-test-secret";

function run(authorization?: string) {
  const req = { headers: { authorization } } as unknown as AuthedRequest;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  requireAuth(req, res as any, next);
  return { req, res, next };
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.JWT_SECRET;
});

describe("requireAuth", () => {
  it("401s with no_token when the header is missing", () => {
    const { res, next } = run(undefined);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing bearer token", code: "no_token" });
    expect(next).not.toHaveBeenCalled();
  });

  it("401s with no_token when the scheme is not Bearer", () => {
    const { res, next } = run("Basic abc");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "no_token" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("401s with no_token for 'Bearer ' with an empty token", () => {
    const { res, next } = run("Bearer ");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "no_token" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("401s with invalid_token for a forged token", () => {
    const { res, next } = run(`Bearer ${jwt.sign({ sub: "a", role: "organiser" }, "wrong")}`);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid token", code: "invalid_token" });
    expect(next).not.toHaveBeenCalled();
  });

  it("401s with token_expired for an expired token", () => {
    const { res, next } = run(`Bearer ${jwt.sign({ sub: "a", role: "organiser" }, SECRET, { expiresIn: -5 })}`);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Your session has expired. Please log in again.", code: "token_expired" });
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches the user and supabase client and calls next for a valid token", () => {
    const { req, res, next } = run(`Bearer ${jwt.sign({ sub: "ORG-1", role: "organiser" }, SECRET)}`);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toEqual({ id: "ORG-1", role: "organiser" });
    expect((req.supabase as any).__marker).toBe("admin");
  });
});
