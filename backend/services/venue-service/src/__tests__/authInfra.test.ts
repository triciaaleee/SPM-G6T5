import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { signToken, TokenExpiredError, verifyToken } from "../lib/jwt.js";
import { signInternalToken } from "../lib/internalAuth.js";

vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: {} }));

/**
 * Mutation-run follow-ups: the exact wording and lifetimes of the things a
 * client or a sibling service depends on.
 */

describe("requireAuth: the exact 401 bodies", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
  });
  const run = (authorization?: string) => {
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const next = vi.fn();
    requireAuth({ headers: authorization === undefined ? {} : { authorization } } as unknown as AuthedRequest, res as unknown as Response, next);
    return { res, next };
  };

  it("no token", () => {
    const { res, next } = run();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing bearer token", code: "no_token" });
    expect(next).not.toHaveBeenCalled();
  });

  it("an expired token", () => {
    const { res } = run(`Bearer ${jwt.sign({ sub: "A", role: "organiser" }, "test-jwt-secret", { expiresIn: -10 })}`);
    expect(res.json).toHaveBeenCalledWith({ error: "Your session has expired. Please log in again.", code: "token_expired" });
  });

  it("a forged or malformed token", () => {
    expect(run("Bearer not.a.jwt").res.json).toHaveBeenCalledWith({ error: "Invalid token", code: "invalid_token" });
    const forged = jwt.sign({ sub: "A", role: "organiser" }, "someone-else", { expiresIn: "1h" });
    expect(run(`Bearer ${forged}`).res.json).toHaveBeenCalledWith({ error: "Invalid token", code: "invalid_token" });
  });

  it("'Bearer ' with nothing after it is a missing token", () => {
    expect(run("Bearer ").res.json).toHaveBeenCalledWith({ error: "Missing bearer token", code: "no_token" });
  });
});

describe("session tokens", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it("last exactly one day", () => {
    const { iat, exp } = jwt.decode(signToken({ sub: "A", role: "organiser" })) as { iat: number; exp: number };
    expect(exp - iat).toBe(24 * 60 * 60);
  });

  it("an expired one raises our own error with its message", () => {
    const expired = jwt.sign({ sub: "A", role: "organiser" }, "test-jwt-secret", { expiresIn: -10 });
    expect(() => verifyToken(expired)).toThrow(new TokenExpiredError("Token expired"));
    try {
      verifyToken(expired);
    } catch (err) {
      expect(err).toBeInstanceOf(TokenExpiredError);
      expect((err as Error).message).toBe("Token expired");
    }
  });
});

describe("internal service tokens", () => {
  const original = process.env.INTERNAL_SERVICE_SECRET;
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = "internal-test-secret";
  });
  afterEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = original;
  });

  it("carry the service name, are signed with the internal secret, and last 60 seconds", () => {
    const token = signInternalToken("venue-service");
    const payload = jwt.verify(token, "internal-test-secret") as { svc: string; iat: number; exp: number };
    expect(payload.svc).toBe("venue-service");
    expect(payload.exp - payload.iat).toBe(60);
    expect(() => jwt.verify(token, "test-jwt-secret")).toThrow();
  });

  it("are not signed at all without the secret", () => {
    for (const value of [undefined, ""]) {
      if (value === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
      else process.env.INTERNAL_SERVICE_SECRET = value;
      expect(() => signInternalToken("venue-service")).toThrow("INTERNAL_SERVICE_SECRET is not set — add it to backend/.env");
    }
  });
});
