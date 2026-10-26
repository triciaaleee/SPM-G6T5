import { describe, expect, it } from "vitest";
import { freeSlotsForDay, subtractIntervals } from "../lib/availability.js";

/**
 * Mutation-run follow-ups for the free-slot arithmetic: blocks handed over
 * out of order, blocks that sit outside the window, a block that ends exactly
 * where the window does, and a gap with room for setup + turnaround and
 * nothing else.
 */

const iv = (start: string, end: string) => ({ start, end });
const WINDOW = iv("08:00", "12:00");

describe("subtractIntervals", () => {
  it("sorts blocks given out of order", () => {
    expect(subtractIntervals(iv("08:00", "20:00"), [iv("14:00", "15:00"), iv("10:00", "11:00")])).toEqual([
      iv("08:00", "10:00"),
      iv("11:00", "14:00"),
      iv("15:00", "20:00"),
    ]);
  });

  it("ignores a block that sits wholly after the window", () => {
    expect(subtractIntervals(WINDOW, [iv("14:00", "15:00")])).toEqual([WINDOW]);
  });

  it("ignores a block that sits wholly before the window", () => {
    expect(subtractIntervals(WINDOW, [iv("06:00", "07:00")])).toEqual([WINDOW]);
  });

  it("ignores blocks that only touch the window's edges", () => {
    expect(subtractIntervals(WINDOW, [iv("07:00", "08:00"), iv("12:00", "13:00")])).toEqual([WINDOW]);
  });

  it("a block ending exactly where the window ends leaves no zero-length slot behind", () => {
    expect(subtractIntervals(WINDOW, [iv("10:00", "12:00")])).toEqual([iv("08:00", "10:00")]);
  });

  it("a block starting exactly where the window starts leaves only the rest", () => {
    expect(subtractIntervals(WINDOW, [iv("08:00", "09:00")])).toEqual([iv("09:00", "12:00")]);
  });

  it("clips blocks that overhang either edge", () => {
    expect(subtractIntervals(WINDOW, [iv("07:00", "09:00")])).toEqual([iv("09:00", "12:00")]);
    expect(subtractIntervals(WINDOW, [iv("11:00", "13:00")])).toEqual([iv("08:00", "11:00")]);
  });

  it("a block covering the whole window leaves nothing", () => {
    expect(subtractIntervals(WINDOW, [iv("07:00", "13:00")])).toEqual([]);
    expect(subtractIntervals(WINDOW, [iv("08:00", "12:00")])).toEqual([]);
  });

  it("merges overlapping and nested blocks, and keeps a one-minute gap between adjacent ones", () => {
    expect(subtractIntervals(WINDOW, [iv("09:00", "11:00"), iv("10:00", "10:30"), iv("10:30", "11:30")])).toEqual([
      iv("08:00", "09:00"),
      iv("11:30", "12:00"),
    ]);
    expect(subtractIntervals(WINDOW, [iv("09:00", "10:00"), iv("10:01", "11:00")])).toEqual([
      iv("08:00", "09:00"),
      iv("10:00", "10:01"),
      iv("11:00", "12:00"),
    ]);
  });

  it("with no blocks the window is entirely free, and an empty window is empty", () => {
    expect(subtractIntervals(WINDOW, [])).toEqual([WINDOW]);
    expect(subtractIntervals(iv("08:00", "08:00"), [])).toEqual([]);
  });
});

describe("freeSlotsForDay", () => {
  const hours = { openingTime: "08:00", closingTime: "20:00" };
  const day = (bookings: { date: string; startTime: string | null; endTime: string | null }[] = []) => ({
    date: "2026-11-10",
    bookings,
    periods: [],
  });
  const target = { startTime: null, endTime: null };

  it("a gap with room for only setup and turnaround is not a slot (event would be zero minutes long)", () => {
    // A 09:30-19:00 booking, padded by 30/30, occupies 09:00-19:30. That leaves
    // 08:00-09:00 (exactly setup + turnaround) and 19:30-20:00 (less than that).
    const slots = freeSlotsForDay(day([{ date: "2026-11-10", startTime: "09:30", endTime: "19:00" }]), hours, { setupMinutes: 30, turnaroundMinutes: 30 }, target);
    expect(slots).toEqual([]);
  });

  it("one minute more than setup + turnaround gives a one-minute event", () => {
    const slots = freeSlotsForDay(day([{ date: "2026-11-10", startTime: "09:31", endTime: "19:00" }]), hours, { setupMinutes: 30, turnaroundMinutes: 30 }, target);
    expect(slots).toEqual([{ date: "2026-11-10", start: "08:00", end: "09:01", eventStart: "08:30", eventEnd: "08:31" }]);
  });

  it("an event with no recorded times blocks the whole day", () => {
    expect(freeSlotsForDay(day([{ date: "2026-11-10", startTime: null, endTime: null }]), hours, { setupMinutes: 0, turnaroundMinutes: 0 }, target)).toEqual([]);
  });

  it("ignores bookings on other days", () => {
    const slots = freeSlotsForDay(day([{ date: "2026-11-11", startTime: "09:00", endTime: "19:00" }]), hours, { setupMinutes: 0, turnaroundMinutes: 0 }, target);
    expect(slots).toEqual([{ date: "2026-11-10", start: "08:00", end: "20:00", eventStart: "08:00", eventEnd: "20:00" }]);
  });
});
