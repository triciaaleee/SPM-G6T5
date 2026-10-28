import { describe, expect, it } from "vitest";
import { validateMessageBody } from "../lib/validateChatMessage.js";

describe("validateMessageBody (exact results)", () => {
  it.each([undefined, null, 5, {}, [], "", "   ", "\n\t"])("rejects %j as empty", (input) => {
    expect(validateMessageBody(input)).toEqual({ valid: false, error: "Message cannot be empty." });
  });

  it("returns the trimmed value", () => {
    expect(validateMessageBody("  hi  ")).toEqual({ valid: true, value: "hi" });
  });

  it("accepts 2000 and rejects 2001 characters (measured after trimming)", () => {
    expect(validateMessageBody("a".repeat(2000)).valid).toBe(true);
    expect(validateMessageBody(` ${"a".repeat(2000)} `).valid).toBe(true);
    expect(validateMessageBody("a".repeat(2001))).toEqual({ valid: false, error: "Message is too long (max 2000 characters)." });
  });
});
