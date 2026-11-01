import jwt from "jsonwebtoken";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_NOW } from "./helpers/testClock.js";
import { signInternalToken } from "../lib/internalAuth.js";

afterEach(() => vi.unstubAllEnvs());

describe("signInternalToken", () => {
  it("signs the service name with the internal secret for 60 seconds", () => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", "internal");
    const payload = jwt.verify(signInternalToken("equipment-service"), "internal") as jwt.JwtPayload;
    expect(payload.svc).toBe("equipment-service");
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(payload.iat).toBe(Math.floor(TEST_NOW.getTime() / 1000));
  });

  it("is not signed with the user JWT secret", () => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", "internal");
    vi.stubEnv("JWT_SECRET", "user");
    expect(() => jwt.verify(signInternalToken("x"), "user")).toThrow();
  });

  it("fails clearly when the secret is missing", () => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", "");
    expect(() => signInternalToken("x")).toThrow("INTERNAL_SERVICE_SECRET is not set — add it to backend/.env");
    vi.stubEnv("INTERNAL_SERVICE_SECRET", undefined);
    expect(() => signInternalToken("x")).toThrow("INTERNAL_SERVICE_SECRET is not set");
  });
});
