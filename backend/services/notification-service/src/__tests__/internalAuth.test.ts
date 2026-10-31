import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signInternalToken } from "../lib/internalAuth.js";

beforeEach(() => {
  process.env.INTERNAL_SERVICE_SECRET = "internal-secret";
});

afterEach(() => {
  delete process.env.INTERNAL_SERVICE_SECRET;
});

describe("signInternalToken", () => {
  it("signs the service name with the internal secret, valid for 60 seconds", () => {
    const payload = jwt.verify(signInternalToken("notification-service"), "internal-secret") as jwt.JwtPayload;
    expect(payload.svc).toBe("notification-service");
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it("names the missing secret when it is unset", () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    expect(() => signInternalToken("x")).toThrow("INTERNAL_SERVICE_SECRET is not set — add it to backend/.env");
  });

  it("treats an empty secret as missing", () => {
    process.env.INTERNAL_SERVICE_SECRET = "";
    expect(() => signInternalToken("x")).toThrow("INTERNAL_SERVICE_SECRET is not set");
  });
});
