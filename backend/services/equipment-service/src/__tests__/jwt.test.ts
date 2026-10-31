import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_NOW } from "./helpers/testClock.js";
import { signToken, TokenExpiredError, verifyToken } from "../lib/jwt.js";

afterEach(() => vi.unstubAllEnvs());

describe("jwt", () => {
  it("signs a token that verifies back to its subject and role", () => {
    vi.stubEnv("JWT_SECRET", "s3cret");
    const payload = verifyToken(signToken({ sub: "TS-0001", role: "technical_support" }));
    expect(payload.sub).toBe("TS-0001");
    expect(payload.role).toBe("technical_support");
  });

  it("expires a token after one day", () => {
    vi.stubEnv("JWT_SECRET", "s3cret");
    const { exp } = verifyToken(signToken({ sub: "a", role: "b" }));
    expect(exp).toBe(Math.floor(TEST_NOW.getTime() / 1000) + 24 * 60 * 60);
  });

  it("signs with the configured secret", () => {
    vi.stubEnv("JWT_SECRET", "s3cret");
    const token = signToken({ sub: "a", role: "b" });
    expect(() => jwt.verify(token, "s3cret")).not.toThrow();
    expect(() => jwt.verify(token, "other")).toThrow();
  });

  it("throws TokenExpiredError for an aged-out token", () => {
    vi.stubEnv("JWT_SECRET", "s3cret");
    const old = jwt.sign({ sub: "a", role: "b", exp: Math.floor(TEST_NOW.getTime() / 1000) - 10 }, "s3cret");
    expect(() => verifyToken(old)).toThrow(TokenExpiredError);
    expect(() => verifyToken(old)).toThrow("Token expired");
  });

  it("rethrows other verification errors untouched", () => {
    vi.stubEnv("JWT_SECRET", "s3cret");
    const forged = jwt.sign({ sub: "a", role: "b" }, "wrong");
    expect(() => verifyToken(forged)).toThrow(jwt.JsonWebTokenError);
    expect(() => verifyToken(forged)).not.toThrow(TokenExpiredError);
    expect(() => verifyToken("not-a-token")).toThrow(jwt.JsonWebTokenError);
  });

  it("fails clearly when JWT_SECRET is not set", () => {
    vi.stubEnv("JWT_SECRET", "");
    expect(() => signToken({ sub: "a", role: "b" })).toThrow("JWT_SECRET is not set — add it to backend/.env");
    expect(() => verifyToken("x")).toThrow("JWT_SECRET is not set");
    vi.stubEnv("JWT_SECRET", undefined);
    expect(() => signToken({ sub: "a", role: "b" })).toThrow("JWT_SECRET is not set");
  });
});
