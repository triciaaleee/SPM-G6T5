import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { TokenExpiredError, signToken, verifyToken } from "../lib/jwt.js";

describe("signToken / verifyToken", () => {
  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  it("round-trips the payload", () => {
    const token = signToken({ sub: "ORG-0001", role: "organiser" });

    expect(verifyToken(token)).toMatchObject({ sub: "ORG-0001", role: "organiser" });
  });

  it("converts jsonwebtoken's TokenExpiredError into our own, so callers can tell it apart from a forged token", () => {
    const expired = jwt.sign({ sub: "ORG-0001", role: "organiser" }, "test-jwt-secret", { expiresIn: -10 });

    expect(() => verifyToken(expired)).toThrow(TokenExpiredError);
  });

  it("lets any other verification failure (bad signature, malformed token) through unchanged", () => {
    const forged = jwt.sign({ sub: "ORG-0001", role: "organiser" }, "wrong-secret", { expiresIn: "1h" });

    expect(() => verifyToken(forged)).toThrow(jwt.JsonWebTokenError);
  });

  describe("when JWT_SECRET is not set", () => {
    const original = process.env.JWT_SECRET;

    afterEach(() => {
      process.env.JWT_SECRET = original;
    });

    it("signToken fails loudly instead of signing with an empty secret", () => {
      delete process.env.JWT_SECRET;

      expect(() => signToken({ sub: "ORG-0001", role: "organiser" })).toThrow(/JWT_SECRET is not set/);
    });

    it("verifyToken fails loudly instead of verifying against an empty secret", () => {
      delete process.env.JWT_SECRET;

      expect(() => verifyToken("anything")).toThrow(/JWT_SECRET is not set/);
    });
  });
});
