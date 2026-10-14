import { describe, expect, it } from "vitest";
import { eventEndsAt, hasEventEnded } from "../lib/eventTiming.js";

describe("eventEndsAt", () => {
  it("reads the date and end time as Singapore time (UTC+8), whatever the server's time zone", () => {
    const endsAt = eventEndsAt({ proposedDate: "2026-11-10", endTime: "18:00" });
    expect(endsAt?.toISOString()).toBe("2026-11-10T10:00:00.000Z");
  });

  it("runs to the end of the day when there's no end time", () => {
    expect(eventEndsAt({ proposedDate: "2026-11-10" })?.toISOString()).toBe("2026-11-10T15:59:00.000Z");
  });

  it.each([
    [{}],
    [{ proposedDate: null, endTime: "18:00" }],
    [{ proposedDate: "10/11/2026", endTime: "18:00" }],
    [{ proposedDate: "2026-11-10", endTime: "6pm" }],
    [{ proposedDate: "2026-11-10", endTime: 18 }],
    [{ proposedDate: "2026-13-45", endTime: "18:00" }],
  ])("returns null for an unreadable date or time (%j)", (details) => {
    expect(eventEndsAt(details)).toBeNull();
  });
});

describe("hasEventEnded", () => {
  const details = { proposedDate: "2026-11-10", startTime: "10:00", endTime: "18:00" };

  it("is false before the end time", () => {
    expect(hasEventEnded(details, new Date("2026-11-10T09:59:00.000Z"))).toBe(false);
  });

  it("is false while the event is still running", () => {
    expect(hasEventEnded(details, new Date("2026-11-10T05:00:00.000Z"))).toBe(false);
  });

  it("is true from the end minute itself", () => {
    expect(hasEventEnded(details, new Date("2026-11-10T10:00:00.000Z"))).toBe(true);
  });

  it("is true after the end time", () => {
    expect(hasEventEnded(details, new Date("2026-11-11T00:00:00.000Z"))).toBe(true);
  });

  it("is false for an event whose end can't be worked out", () => {
    expect(hasEventEnded({ endTime: "18:00" }, new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
  });
});
