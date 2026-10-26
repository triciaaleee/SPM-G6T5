import { describe, expect, it, vi } from "vitest";
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_RULE,
  PASSWORD_TOO_LONG,
  passwordProblem,
} from "../lib/passwordPolicy.js";

describe("passwordProblem", () => {
  it("accepts exactly PASSWORD_MAX_BYTES bytes", () => {
    const password = `a1${"a".repeat(PASSWORD_MAX_BYTES - 2)}`;
    expect(Buffer.byteLength(password, "utf8")).toBe(PASSWORD_MAX_BYTES);

    expect(passwordProblem(password)).toBeNull();
  });

  it("rejects PASSWORD_MAX_BYTES + 1 bytes as too long", () => {
    const password = `a1${"a".repeat(PASSWORD_MAX_BYTES - 1)}`;
    expect(Buffer.byteLength(password, "utf8")).toBe(PASSWORD_MAX_BYTES + 1);

    expect(passwordProblem(password)).toBe(PASSWORD_TOO_LONG);
  });

  it("measures length in utf8 bytes, not characters", () => {
    const spy = vi.spyOn(Buffer, "byteLength");

    passwordProblem("abcdefg1");

    expect(spy).toHaveBeenCalledWith("abcdefg1", "utf8");
    spy.mockRestore();
  });

  it("requires at least one letter and one number once length passes", () => {
    expect(passwordProblem("12345678")).toBe(PASSWORD_RULE);
    expect(passwordProblem("abcdefgh")).toBe(PASSWORD_RULE);
    expect(passwordProblem("abcdefg1")).toBeNull();
  });
});
