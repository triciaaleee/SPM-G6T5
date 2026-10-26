import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TokenExpiredError, verifyToken } from "../lib/jwt.js";

const SECRET = "unit-test-secret";

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.JWT_SECRET;
});

describe("verifyToken", () => {
  it("returns the payload of a valid token", () => {
    const token = jwt.sign({ sub: "ORG-0001", role: "organiser" }, SECRET, { expiresIn: "1h" });
    const payload = verifyToken(token);
    expect(payload.sub).toBe("ORG-0001");
    expect(payload.role).toBe("organiser");
    expect(typeof payload.exp).toBe("number");
  });

  it("throws TokenExpiredError for an expired token", () => {
    const token = jwt.sign({ sub: "ORG-0001", role: "organiser" }, SECRET, { expiresIn: -10 });
    expect(() => verifyToken(token)).toThrow(TokenExpiredError);
    expect(() => verifyToken(token)).toThrow("Token expired");
  });

  it("throws a non-expiry error for a token signed with another secret", () => {
    const token = jwt.sign({ sub: "ORG-0001", role: "organiser" }, "other-secret");
    expect(() => verifyToken(token)).toThrow(jwt.JsonWebTokenError);
    expect(() => verifyToken(token)).not.toThrow(TokenExpiredError);
  });

  it("rejects a tampered payload", () => {
    const token = jwt.sign({ sub: "ORG-0001", role: "organiser" }, SECRET);
    const [h, , s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "ORG-0001", role: "coordinator" })).toString("base64url");
    expect(() => verifyToken(`${h}.${forged}.${s}`)).toThrow(jwt.JsonWebTokenError);
  });

  it("rejects an unsigned (alg: none) token", () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const token = `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: "x", role: "coordinator" })}.`;
    expect(() => verifyToken(token)).toThrow();
  });

  it("rejects a malformed token", () => {
    expect(() => verifyToken("not-a-jwt")).toThrow(jwt.JsonWebTokenError);
  });

  it("throws a clear error when JWT_SECRET is not set", () => {
    delete process.env.JWT_SECRET;
    expect(() => verifyToken("anything")).toThrow("JWT_SECRET is not set");
  });
});
