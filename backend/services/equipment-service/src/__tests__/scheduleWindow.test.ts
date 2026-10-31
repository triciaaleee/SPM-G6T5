import { describe, expect, it } from "vitest";
import { dateRangeWindow, occupiedWindow, overlaps } from "../lib/scheduleWindow.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const day = (date: string) => Date.parse(`${date}T00:00:00.000Z`);

describe("occupiedWindow", () => {
  it("is null without a date", () => {
    expect(occupiedWindow({})).toBeNull();
    expect(occupiedWindow({ proposedDate: null, startTime: "09:00", endTime: "10:00" })).toBeNull();
    expect(occupiedWindow({ proposedDate: "", startTime: "09:00", endTime: "10:00" })).toBeNull();
  });

  it("is null for a malformed date", () => {
    expect(occupiedWindow({ proposedDate: "2026-1-5" })).toBeNull();
    expect(occupiedWindow({ proposedDate: "05/01/2026" })).toBeNull();
    expect(occupiedWindow({ proposedDate: "2026-01-05T00:00" })).toBeNull();
    expect(occupiedWindow({ proposedDate: "x2026-01-05" })).toBeNull();
  });

  it("is exactly start to end when both times are valid", () => {
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "09:30", endTime: "11:45" })).toEqual({
      startMs: day("2026-01-05") + (9 * 60 + 30) * MIN,
      endMs: day("2026-01-05") + (11 * 60 + 45) * MIN,
    });
  });

  it("accepts the last minute of the day", () => {
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "00:00", endTime: "23:59" })).toEqual({
      startMs: day("2026-01-05"),
      endMs: day("2026-01-05") + (23 * 60 + 59) * MIN,
    });
  });

  const wholeDay = { startMs: day("2026-01-05"), endMs: day("2026-01-05") + DAY };

  it("occupies the whole day when times are missing", () => {
    expect(occupiedWindow({ proposedDate: "2026-01-05" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "09:00" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", endTime: "10:00" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "", endTime: "" })).toEqual(wholeDay);
  });

  it("occupies the whole day when a time is unreadable", () => {
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "9:00", endTime: "10:00" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "09:00", endTime: "ten" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "09:00:00", endTime: "10:00" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "09:00", endTime: "10:00pm" })).toEqual(wholeDay);
  });

  it("rejects an hour above 23 or a minute above 59", () => {
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "24:00", endTime: "25:00" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "09:60", endTime: "11:00" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "09:00", endTime: "24:00" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "09:00", endTime: "11:60" })).toEqual(wholeDay);
  });

  it("occupies the whole day when the end is not after the start", () => {
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "10:00", endTime: "10:00" })).toEqual(wholeDay);
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "11:00", endTime: "10:00" })).toEqual(wholeDay);
  });

  it("treats a one-minute event as that minute", () => {
    expect(occupiedWindow({ proposedDate: "2026-01-05", startTime: "10:00", endTime: "10:01" })).toEqual({
      startMs: day("2026-01-05") + 600 * MIN,
      endMs: day("2026-01-05") + 601 * MIN,
    });
  });
});

describe("overlaps", () => {
  it("is true when the windows share time", () => {
    expect(overlaps({ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 15 })).toBe(true);
    expect(overlaps({ startMs: 5, endMs: 15 }, { startMs: 0, endMs: 10 })).toBe(true);
    expect(overlaps({ startMs: 0, endMs: 10 }, { startMs: 2, endMs: 3 })).toBe(true);
  });

  it("is false for windows that only touch (half-open)", () => {
    expect(overlaps({ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 })).toBe(false);
    expect(overlaps({ startMs: 10, endMs: 20 }, { startMs: 0, endMs: 10 })).toBe(false);
  });

  it("is false for windows apart", () => {
    expect(overlaps({ startMs: 0, endMs: 10 }, { startMs: 11, endMs: 20 })).toBe(false);
  });
});

describe("dateRangeWindow", () => {
  it("covers both end days in full", () => {
    expect(dateRangeWindow("2026-01-05", "2026-01-07")).toEqual({ startMs: day("2026-01-05"), endMs: day("2026-01-08") });
    expect(dateRangeWindow("2026-01-05", "2026-01-05")).toEqual({ startMs: day("2026-01-05"), endMs: day("2026-01-06") });
  });

  it("is open-ended without an end date", () => {
    expect(dateRangeWindow("2026-01-05", null)).toEqual({ startMs: day("2026-01-05"), endMs: Number.MAX_SAFE_INTEGER });
  });

  it("is null for a malformed start or end", () => {
    expect(dateRangeWindow("nope", null)).toBeNull();
    expect(dateRangeWindow("nope", "2026-01-07")).toBeNull();
    expect(dateRangeWindow("2026-01-05", "7 Jan")).toBeNull();
  });
});
