import { describe, expect, it } from "vitest";
import { registrationState } from "../registrationPeriod";

// Starts 2026-11-20 18:00 SGT (10:00 UTC); default cutoff 2026-11-15 10:00 UTC.
const DETAILS = { proposedDate: "2026-11-20", startTime: "18:00", endTime: "21:00" };
const at = (iso: string) => new Date(iso);

describe("registrationState", () => {
  it("is not open before the open date or when none is set", () => {
    expect(registrationState("Confirmed", DETAILS, "2026-11-01", "NONE", at("2026-10-31T15:00:00Z"))).toBe("not_open_yet");
    expect(registrationState("Confirmed", DETAILS, null, "NONE", at("2026-11-02T00:00:00Z"))).toBe("not_open_yet");
  });

  it("is open from the open date until 5 days before the event", () => {
    expect(registrationState("Confirmed", DETAILS, "2026-11-01", "NONE", at("2026-11-15T09:59:00Z"))).toBe("open");
    expect(registrationState("Confirmed", DETAILS, "2026-11-01", "NONE", at("2026-11-15T10:00:00Z"))).toBe("closed");
  });

  it("FORCE_CLOSED closes; FORCE_OPEN opens early and inside the 5-day window", () => {
    expect(registrationState("Confirmed", DETAILS, "2026-11-01", "FORCE_CLOSED", at("2026-11-05T00:00:00Z"))).toBe("closed");
    expect(registrationState("Confirmed", DETAILS, null, "FORCE_OPEN", at("2026-10-20T00:00:00Z"))).toBe("open");
    expect(registrationState("Confirmed", DETAILS, "2026-11-01", "FORCE_OPEN", at("2026-11-17T00:00:00Z"))).toBe("open");
  });

  it("always stops when the event starts, even when forced open", () => {
    expect(registrationState("Confirmed", DETAILS, "2026-11-01", "FORCE_OPEN", at("2026-11-20T10:00:00Z"))).toBe("closed");
    expect(registrationState("Confirmed", DETAILS, "2026-11-01", "NONE", at("2026-11-20T10:00:00Z"))).toBe("closed");
  });
});
