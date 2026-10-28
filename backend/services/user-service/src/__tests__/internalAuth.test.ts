import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuthOrInternal } from "../middleware/auth.js";
import { verifyInternalToken } from "../lib/internalAuth.js";

vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: {} }));

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("requireAuthOrInternal", () => {
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = "test-internal-secret";
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it("accepts a valid internal token without requiring req.user", () => {
    const token = jwt.sign({ svc: "notification-service" }, "test-internal-secret", { expiresIn: "60s" });
    const req = { headers: { "x-internal-auth": token } } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuthOrInternal(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(req.supabase).toBeDefined();
  });

  it("rejects an invalid internal token with 401, not falling through to requireAuth", () => {
    const req = { headers: { "x-internal-auth": "garbage" } } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuthOrInternal(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Invalid internal token",
      code: "invalid_internal_token",
    });
  });

  it("treats a non-string x-internal-auth header (e.g. a repeated header) as absent, falling through to requireAuth", () => {
    // Express gives an array when a header is sent more than once. The
    // internal path requires a *string* token — anything else should be
    // ignored, not handed to verifyInternalToken.
    const req = { headers: { "x-internal-auth": ["one", "two"] } } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuthOrInternal(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "no_token" }));
  });

  it("falls back to normal requireAuth behaviour when there's no internal header", () => {
    const req = { headers: {} } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();

    requireAuthOrInternal(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res.json as any).mock.calls[0][0]).toMatchObject({ code: "no_token" });
  });
});

describe("verifyInternalToken", () => {
  const original = process.env.INTERNAL_SERVICE_SECRET;

  afterEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = original;
  });

  it("fails loudly when INTERNAL_SERVICE_SECRET is not set, instead of verifying against an empty secret", () => {
    delete process.env.INTERNAL_SERVICE_SECRET;

    expect(() => verifyInternalToken("anything")).toThrow(/INTERNAL_SERVICE_SECRET is not set/);
  });
});
