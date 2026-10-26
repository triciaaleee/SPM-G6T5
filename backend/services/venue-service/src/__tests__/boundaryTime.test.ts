import { describe, expect, it } from "vitest";
import { datesBetween, findFreeSlots } from "../lib/availability.js";
import { formatWindow, occupiedWindow, overlaps } from "../lib/bookingConflicts.js";
import { BOOKING_STATUSES, blocksVenue, canTransition } from "../lib/bookingStatus.js";

/**
 * Boundary and edge cases for the pure time/status helpers. Every expected
 * value is an exact literal (not recomputed with the code under test) so a
 * flipped comparison, off-by-one or swapped operand changes a number or a
 * boolean here and fails.
 */
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const D = Date.UTC(2026, 8, 14); // 2026-09-14 00:00 UTC

describe("occupiedWindow", () => {
  it("pads start by setup and end by turnaround (10:00–12:00, 30/45 → 09:30–12:45)", () => {
    expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "10:00", endTime: "12:00" }, { setup_minutes: 30, turnaround_minutes: 45 })).toEqual({
      startMs: D + (9 * 60 + 30) * MIN,
      endMs: D + (12 * 60 + 45) * MIN,
    });
  });

  it("applies no padding when none is given, and treats null padding as 0", () => {
    const expected = { startMs: D + 600 * MIN, endMs: D + 720 * MIN };
    expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "10:00", endTime: "12:00" })).toEqual(expected);
    expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "10:00", endTime: "12:00" }, { setup_minutes: null, turnaround_minutes: null })).toEqual(expected);
  });

  it("ignores negative padding rather than shrinking the window", () => {
    expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "10:00", endTime: "12:00" }, { setup_minutes: -30, turnaround_minutes: -45 })).toEqual({
      startMs: D + 600 * MIN,
      endMs: D + 720 * MIN,
    });
  });

  it("lets padding cross midnight in both directions", () => {
    const w = occupiedWindow({ proposedDate: "2026-09-14", startTime: "00:10", endTime: "23:50" }, { setup_minutes: 20, turnaround_minutes: 20 })!;
    expect(w.startMs).toBe(D - 10 * MIN);
    expect(w.endMs).toBe(D + DAY + 10 * MIN);
  });

  it.each([
    ["no times", null, null],
    ["no start", null, "12:00"],
    ["no end", "10:00", null],
    ["end equal to start", "10:00", "10:00"],
    ["end before start", "12:00", "10:00"],
    ["unparseable start", "ten", "12:00"],
    ["hour 24", "24:00", "23:59"],
    ["minute 60", "10:60", "12:00"],
  ])("falls back to the whole day (%s)", (_n, startTime, endTime) => {
    expect(occupiedWindow({ proposedDate: "2026-09-14", startTime, endTime }, { setup_minutes: 5, turnaround_minutes: 7 })).toEqual({
      startMs: D - 5 * MIN,
      endMs: D + DAY + 7 * MIN,
    });
  });

  it.each([
    ["trailing seconds (HH:MM:SS is not HH:MM)", "10:00:00", "12:00"],
    ["leading garbage on the start", "x10:00", "12:00"],
    ["trailing garbage on the end", "10:00", "12:00x"],
    ["end hour 24 (24:00 is not a time of day here)", "23:00", "24:00"],
  ])("falls back to the whole day for %s", (_n, startTime, endTime) => {
    expect(occupiedWindow({ proposedDate: "2026-09-14", startTime, endTime })).toEqual({ startMs: D, endMs: D + DAY });
  });

  it.each([["x2026-09-14"], ["12026-09-14"], ["2026-09-14x"], [" 2026-09-14"]])("returns null for a date with extra characters (%j)", (proposedDate) => {
    expect(occupiedWindow({ proposedDate, startTime: "10:00", endTime: "11:00" })).toBeNull();
  });

  it("accepts the last valid minute 23:59 and first minute 00:00", () => {
    expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "00:00", endTime: "23:59" })).toEqual({
      startMs: D,
      endMs: D + (23 * 60 + 59) * MIN,
    });
  });

  it.each([[undefined], [null], [""], ["2026-9-14"], ["14/09/2026"], ["2026-09-14T00:00"]])("returns null for date %j", (proposedDate) => {
    expect(occupiedWindow({ proposedDate: proposedDate as string | null | undefined, startTime: "10:00", endTime: "11:00" })).toBeNull();
  });
});

describe("overlaps (half-open)", () => {
  const a = { startMs: 100, endMs: 200 };
  it("touching windows do not overlap, in either order", () => {
    expect(overlaps(a, { startMs: 200, endMs: 300 })).toBe(false);
    expect(overlaps({ startMs: 0, endMs: 100 }, a)).toBe(false);
  });
  it("one millisecond of overlap does, in either order", () => {
    expect(overlaps(a, { startMs: 199, endMs: 300 })).toBe(true);
    expect(overlaps({ startMs: 0, endMs: 101 }, a)).toBe(true);
  });
  it("containment and identity overlap", () => {
    expect(overlaps(a, { startMs: 120, endMs: 150 })).toBe(true);
    expect(overlaps({ startMs: 120, endMs: 150 }, a)).toBe(true);
    expect(overlaps(a, a)).toBe(true);
  });
  it("disjoint windows do not overlap", () => {
    expect(overlaps(a, { startMs: 500, endMs: 600 })).toBe(false);
    expect(overlaps({ startMs: 500, endMs: 600 }, a)).toBe(false);
  });
});

describe("formatWindow", () => {
  it("shows one date when the window stays within a day", () => {
    expect(formatWindow({ startMs: D + (9 * 60 + 30) * MIN, endMs: D + (12 * 60 + 45) * MIN })).toBe("2026-09-14 09:30–12:45");
  });
  it("spells out both dates across midnight", () => {
    expect(formatWindow({ startMs: D - 10 * MIN, endMs: D + DAY + 10 * MIN })).toBe("2026-09-13 23:50 – 2026-09-15 00:10");
  });
  it("zero-pads single-digit months, days, hours and minutes", () => {
    expect(formatWindow({ startMs: Date.UTC(2026, 0, 5, 1, 2), endMs: Date.UTC(2026, 0, 5, 3, 4) })).toBe("2026-01-05 01:02–03:04");
  });
});

describe("blocksVenue", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  it("Approved always blocks", () => expect(blocksVenue({ status: "Approved" }, now)).toBe(true));
  it.each(["Requested", "Rejected", "Expired", "Withdrawn", "Cancelled", "Replacement Required"] as const)("%s never blocks", (status) => {
    expect(blocksVenue({ status, hold_expires_at: "2099-01-01T00:00:00Z" }, now)).toBe(false);
  });
  it("an On Hold with no expiry blocks (safe reading)", () => {
    expect(blocksVenue({ status: "On Hold" }, now)).toBe(true);
    expect(blocksVenue({ status: "On Hold", hold_expires_at: null }, now)).toBe(true);
  });
  it("an On Hold blocks until the exact expiry instant, and not at or after it", () => {
    expect(blocksVenue({ status: "On Hold", hold_expires_at: "2026-09-14T12:00:00.001Z" }, now)).toBe(true);
    expect(blocksVenue({ status: "On Hold", hold_expires_at: "2026-09-14T12:00:00.000Z" }, now)).toBe(false);
    expect(blocksVenue({ status: "On Hold", hold_expires_at: "2026-09-14T11:59:59.999Z" }, now)).toBe(false);
  });
  it("uses the real clock when no `now` is passed", () => {
    expect(blocksVenue({ status: "On Hold", hold_expires_at: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
    expect(blocksVenue({ status: "On Hold", hold_expires_at: new Date(Date.now() - 60_000).toISOString() })).toBe(false);
  });
});

describe("canTransition: the whole §3a table", () => {
  const allowed: Record<string, string[]> = {
    Requested: ["On Hold", "Approved", "Rejected", "Withdrawn"],
    "On Hold": ["Approved", "Rejected", "Expired", "Withdrawn"],
    Approved: ["Replacement Required", "Cancelled", "Withdrawn"],
    Rejected: [],
    Expired: [],
    "Replacement Required": ["Withdrawn"],
    Withdrawn: [],
    Cancelled: [],
  };
  for (const from of BOOKING_STATUSES) {
    for (const to of BOOKING_STATUSES) {
      it(`${from} → ${to} is ${allowed[from].includes(to) ? "allowed" : "refused"}`, () => {
        expect(canTransition(from, to)).toBe(allowed[from].includes(to));
      });
    }
  }
  it("refuses an unknown source status", () => {
    expect(canTransition("Bogus" as never, "Approved")).toBe(false);
  });
});

describe("datesBetween", () => {
  it("is inclusive of both ends", () => expect(datesBetween("2026-09-14", "2026-09-16")).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]));
  it("returns one date when from equals to", () => expect(datesBetween("2026-09-14", "2026-09-14")).toEqual(["2026-09-14"]));
  it("returns nothing when to is before from", () => expect(datesBetween("2026-09-14", "2026-09-13")).toEqual([]));
  it("crosses month, year and leap-day boundaries", () => {
    expect(datesBetween("2026-12-31", "2027-01-01")).toEqual(["2026-12-31", "2027-01-01"]);
    expect(datesBetween("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
    expect(datesBetween("2027-02-28", "2027-03-01")).toEqual(["2027-02-28", "2027-03-01"]);
  });
});

describe("findFreeSlots range clamping", () => {
  const hours = { openingTime: "08:00", closingTime: "18:00" };
  const buffers = { setup_minutes: 0, turnaround_minutes: 0 } as never;
  const target = (fromDate: string, toDate: string) => ({ fromDate, toDate, startTime: null, endTime: null });
  const dates = (slots: { date: string }[]) => [...new Set(slots.map((s) => s.date))];

  it("returns nothing when the target ends before the loaded range starts", () => {
    expect(findFreeSlots({ from: "2026-09-10", to: "2026-09-20" }, target("2026-09-01", "2026-09-09"), [], [], hours, buffers)).toEqual([]);
  });
  it("returns nothing when the target starts after the loaded range ends", () => {
    expect(findFreeSlots({ from: "2026-09-10", to: "2026-09-20" }, target("2026-09-21", "2026-09-25"), [], [], hours, buffers)).toEqual([]);
  });
  it("clamps to the intersection of target and range on both sides", () => {
    const slots = findFreeSlots({ from: "2026-09-10", to: "2026-09-12" }, target("2026-09-11", "2026-09-30"), [], [], hours, buffers);
    expect(dates(slots)).toEqual(["2026-09-11", "2026-09-12"]);
    const slots2 = findFreeSlots({ from: "2026-09-10", to: "2026-09-30" }, target("2026-09-01", "2026-09-11"), [], [], hours, buffers);
    expect(dates(slots2)).toEqual(["2026-09-10", "2026-09-11"]);
  });
  it("a single-day intersection yields that day only", () => {
    expect(dates(findFreeSlots({ from: "2026-09-10", to: "2026-09-10" }, target("2026-09-10", "2026-09-10"), [], [], hours, buffers))).toEqual(["2026-09-10"]);
  });
});
