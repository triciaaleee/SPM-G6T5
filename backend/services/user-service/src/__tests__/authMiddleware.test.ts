import { describe, expect, it, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * requireAuth's real token-verification path (valid / expired / tampered) had
 * no test at all — every route test (users.test.ts, userNames.test.ts) mocks
 * ../middleware/auth.js out entirely. internalAuth.test.ts exercises the
 * "no token" fallback via requireAuthOrInternal, but not these branches.
 */

vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { marker: "the real supabaseAdmin" } }));

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("requireAuth", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it("sets req.user and req.supabase from a valid token, then calls next", () => {
    const token = jwt.sign({ sub: "ORG-0001", role: "organiser" }, "test-jwt-secret", { expiresIn: "1h" });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toEqual({ id: "ORG-0001", role: "organiser" });
    expect(req.supabase).toMatchObject({ marker: "the real supabaseAdmin" });
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects a missing bearer token with 401 no_token", () => {
    const req = { headers: {} } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "no_token" }));
  });

  it("rejects a header with no Bearer prefix the same way as a missing one", () => {
    const req = { headers: { authorization: "garbage-not-bearer" } } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "no_token" }));
  });

  it("rejects an expired token with 401 token_expired, naming it apart from a bad token", () => {
    // Negative expiresIn backdates `exp` so the token is already expired the
    // instant it's issued — no need to wait or fake the clock.
    const token = jwt.sign({ sub: "ORG-0001", role: "organiser" }, "test-jwt-secret", { expiresIn: -10 });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "token_expired" }));
    expect(req.user).toBeUndefined();
  });

  it("rejects a token signed with the wrong secret as invalid_token, not token_expired", () => {
    const token = jwt.sign({ sub: "ORG-0001", role: "organiser" }, "someone-elses-secret", { expiresIn: "1h" });
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid_token" }));
  });

  it("rejects a malformed token string as invalid_token", () => {
    const req = { headers: { authorization: "Bearer not.a.jwt" } } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "invalid_token" }));
  });
});
