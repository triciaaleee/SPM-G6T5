import { describe, expect, it } from "vitest";
import { findBufferOverlaps, type LiveBooking } from "../lib/venueChanges.js";

/**
 * Mutation-run follow-ups: bookings already in the past never count as a
 * conflict, and a pair that already overlapped must not hide a different pair
 * that starts overlapping.
 */

const event = (id: number, o: Record<string, unknown> = {}) =>
  ({ id, name: `E${id}`, coordinatorId: `C${id}`, proposedDate: "2026-09-15", startTime: "10:00", endTime: "12:00", expectedAttendance: 100, ...o }) as never;
const live = (id: number, eventId: number, eo: Record<string, unknown> = {}): LiveBooking =>
  ({ id, status: "Approved", event: event(eventId, eo), headcount: null }) as LiveBooking;
const TODAY = "2026-09-15";

describe("findBufferOverlaps", () => {
  const before = { setup_minutes: 0, turnaround_minutes: 60 };
  const after = { setup_minutes: 0, turnaround_minutes: 120 };

  it("ignores bookings whose event was before today, keeps today's", () => {
    // 10:00-12:00 then 13:30-15:00: clear at a 60-minute turnaround (13:00), overlapping at 120 (14:00).
    const pair = (date: string) => [
      live(1, 1, { proposedDate: date }),
      live(2, 2, { proposedDate: date, startTime: "13:30", endTime: "15:00" }),
    ];
    expect(findBufferOverlaps(pair("2026-09-14"), before, after, TODAY)).toEqual([]);
    expect(findBufferOverlaps(pair("2026-09-15"), before, after, TODAY)).toHaveLength(1);
    expect(findBufferOverlaps(pair("2026-09-16"), before, after, TODAY)).toHaveLength(1);
  });

  it("ignores a booking whose event has no date", () => {
    const bookings = [live(1, 1, { proposedDate: null }), live(2, 2, { startTime: "13:30", endTime: "15:00" })];
    expect(findBufferOverlaps(bookings, before, after, TODAY)).toEqual([]);
  });

  it("a pair that already overlapped does not hide a different pair that newly overlaps", () => {
    const bookings = [
      // Already overlapping at 60: the first ends 12:00 (+60 = 13:00) and the second starts 12:30.
      live(1, 1),
      live(2, 2, { startTime: "12:30", endTime: "14:00" }),
      // Only overlapping at 120, on another day.
      live(3, 3, { proposedDate: "2026-09-16" }),
      live(4, 4, { proposedDate: "2026-09-16", startTime: "13:30", endTime: "15:00" }),
    ];

    const found = findBufferOverlaps(bookings, before, after, TODAY);

    expect(found.map((o) => [o.first.bookingId, o.second.bookingId])).toEqual([[3, 4]]);
    expect(found[0]).toMatchObject({
      first: { eventId: 3, eventName: "E3", coordinatorId: "C3" },
      second: { eventId: 4, eventName: "E4", coordinatorId: "C4" },
    });
  });

  it("two newly overlapping pairs are both reported", () => {
    const bookings = [
      live(1, 1),
      live(2, 2, { startTime: "13:30", endTime: "15:00" }),
      live(3, 3, { proposedDate: "2026-09-16" }),
      live(4, 4, { proposedDate: "2026-09-16", startTime: "13:30", endTime: "15:00" }),
    ];
    expect(findBufferOverlaps(bookings, before, after, TODAY).map((o) => [o.first.bookingId, o.second.bookingId])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("finds the same pairs whichever order the bookings arrive in (highest id first)", () => {
    const bookings = [
      live(8, 4, { proposedDate: "2026-09-16", startTime: "13:30", endTime: "15:00" }),
      live(7, 3, { proposedDate: "2026-09-16" }),
      live(2, 2, { startTime: "12:30", endTime: "14:00" }),
      live(1, 1),
    ];
    const found = findBufferOverlaps(bookings, before, after, TODAY);
    expect(found.map((o) => [o.first.bookingId, o.second.bookingId])).toEqual([[8, 7]]);
  });
});

describe("findBufferOverlaps: pair keys cannot run together", () => {
  it("(1, 234) is not mistaken for (12, 34) when the latter already overlapped", () => {
    const at = (id: number, eventId: number, startTime: string, endTime: string) => live(id, eventId, { startTime, endTime });
    // Bookings 12 and 34 clash at 60 minutes already (12:00 + 60 = 13:00 > 12:30).
    // Bookings 1 and 234 only start to clash at 120 (10:00-12:00 then 13:30-15:00 on another day).
    const bookings = [
      at(12, 1, "10:00", "12:00"),
      at(34, 2, "12:30", "14:00"),
      { ...at(1, 3, "10:00", "12:00"), event: event(3, { proposedDate: "2026-09-16", startTime: "10:00", endTime: "12:00" }) },
      { ...at(234, 4, "13:30", "15:00"), event: event(4, { proposedDate: "2026-09-16", startTime: "13:30", endTime: "15:00" }) },
    ];
    const found = findBufferOverlaps(bookings, { setup_minutes: 0, turnaround_minutes: 60 }, { setup_minutes: 0, turnaround_minutes: 120 }, "2026-09-15");
    expect(found.map((p) => [p.first.bookingId, p.second.bookingId].sort((a, b) => a - b))).toEqual([[1, 234]]);
  });
});
