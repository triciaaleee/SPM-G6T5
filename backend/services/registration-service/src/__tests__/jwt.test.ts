import jsonwebtoken from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenExpiredError, verifyToken } from "../lib/jwt.js";

const SECRET = "test-secret";

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.JWT_SECRET;
});

describe("verifyToken", () => {
  it("returns the payload of a valid token", () => {
    const token = jsonwebtoken.sign({ sub: "ORG-0001", role: "organiser" }, SECRET, { expiresIn: "1h" });
    expect(verifyToken(token)).toMatchObject({ sub: "ORG-0001", role: "organiser" });
  });

  it("throws TokenExpiredError with its own message for an expired token", () => {
    const token = jsonwebtoken.sign({ sub: "ORG-0001", role: "organiser" }, SECRET, { expiresIn: -1 });
    expect(() => verifyToken(token)).toThrow(TokenExpiredError);
    expect(() => verifyToken(token)).toThrow("Token expired");
  });

  it("lets a forged token's error through, not as TokenExpiredError", () => {
    const token = jsonwebtoken.sign({ sub: "ORG-0001", role: "organiser" }, "other-secret");
    let caught: unknown;
    try {
      verifyToken(token);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(jsonwebtoken.JsonWebTokenError);
    expect(caught).not.toBeInstanceOf(TokenExpiredError);
  });

  it("names the missing secret instead of failing inside jsonwebtoken", () => {
    delete process.env.JWT_SECRET;
    expect(() => verifyToken("anything")).toThrow("JWT_SECRET is not set — add it to backend/.env");
  });

  it("treats an empty secret as missing", () => {
    process.env.JWT_SECRET = "";
    expect(() => verifyToken("anything")).toThrow("JWT_SECRET is not set");
  });
});
