import { describe, expect, it } from "vitest";
import {
  availabilityEntries,
  blockEntries,
  bookingEntries,
  layoutLanes,
  shiftAnchor,
  startOfWeek,
  visibleRange,
} from "../venueCalendar";
import type { AvailabilityBooking, VenueBooking } from "../venuesApi";
import type { UnavailabilityPeriod } from "../unavailabilityApi";

function booking(id: number, status: VenueBooking["status"], start: string | null, end: string | null): VenueBooking {
  return {
    id,
    date: "2026-10-20",
    startTime: start,
    endTime: end,
    status,
    event: { id: id * 10, name: `Event ${id}`, expectedAttendance: 50, layouts: [], facilities: [] },
  };
}

describe("visibleRange", () => {
  it("is a single day for day view", () => {
    expect(visibleRange("day", "2026-10-20").days).toEqual(["2026-10-20"]);
  });

  it("runs Monday to Sunday for week view", () => {
    const range = visibleRange("week", "2026-10-20"); // a Tuesday
    expect(range.from).toBe("2026-10-19");
    expect(range.to).toBe("2026-10-25");
    expect(range.days).toHaveLength(7);
  });

  it("covers whole weeks around the month for month view", () => {
    const range = visibleRange("month", "2026-10-20");
    expect(range.from).toBe("2026-09-28");
    expect(range.to).toBe("2026-11-01");
    expect(range.days.length % 7).toBe(0);
  });
});

describe("shiftAnchor", () => {
  it("moves by a day, a week or a month", () => {
    expect(shiftAnchor("day", "2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftAnchor("week", "2026-10-20", -1)).toBe("2026-10-13");
    expect(shiftAnchor("month", "2026-01-31", 1)).toBe("2026-02-01");
  });
});

describe("startOfWeek", () => {
  it("treats Sunday as the end of the week", () => {
    expect(startOfWeek("2026-10-25")).toBe("2026-10-19");
  });
});

describe("bookingEntries", () => {
  it("keeps only live statuses", () => {
    const entries = bookingEntries(1, [
      booking(1, "Approved", "10:00", "12:00"),
      booking(2, "Requested", "10:00", "12:00"),
      booking(3, "On Hold", "10:00", "12:00"),
      booking(4, "Replacement Required", "10:00", "12:00"),
      booking(5, "Rejected", "10:00", "12:00"),
      booking(6, "Expired", "10:00", "12:00"),
      booking(7, "Withdrawn", "10:00", "12:00"),
    ]);
    expect(entries.map((e) => e.id)).toEqual(["booking-1", "booking-2", "booking-3", "booking-4"]);
  });

  it("treats a booking without times as all-day", () => {
    const [entry] = bookingEntries(1, [booking(1, "Approved", null, null)]);
    expect(entry.allDay).toBe(true);
    expect(entry.startMin).toBeNull();
  });

  it("converts times to minutes", () => {
    const [entry] = bookingEntries(1, [booking(1, "Approved", "09:30", "11:00")]);
    expect([entry.startMin, entry.endMin]).toEqual([570, 660]);
  });
});

describe("availabilityEntries", () => {
  const blocking = (
    id: number,
    status: AvailabilityBooking["status"],
    startTime: string | null,
    endTime: string | null,
    name: string | null = "Gala Dinner",
  ): AvailabilityBooking => ({
    id,
    status,
    date: "2026-10-10",
    startTime,
    endTime,
    occupiedStart: "09:30",
    occupiedEnd: "12:45",
    holdExpiresAt: null,
    event: { id: 11, name },
  });

  it("draws Approved and On Hold bookings at the event's own times, with no attendance", () => {
    const [approved, hold] = availabilityEntries(7, [
      blocking(1, "Approved", "10:00", "12:00"),
      blocking(2, "On Hold", "14:00", "16:00"),
    ]);

    expect(approved).toMatchObject({
      id: "booking-1",
      kind: "booking",
      venueId: 7,
      status: "Approved",
      startMin: 600,
      endMin: 720,
      allDay: false,
      title: "Gala Dinner",
    });
    expect(approved.attendance).toBeUndefined();
    expect(hold.status).toBe("On Hold");
  });

  it("treats a booking with no usable times as all day", () => {
    const [none, backwards] = availabilityEntries(7, [
      blocking(1, "Approved", null, null, null),
      blocking(2, "Approved", "12:00", "10:00"),
    ]);

    expect(none).toMatchObject({ startMin: null, endMin: null, allDay: true, title: "Untitled event" });
    expect(backwards.allDay).toBe(true);
  });
});

describe("blockEntries", () => {
  const period: UnavailabilityPeriod = {
    id: 9,
    venueId: 2,
    startDate: "2026-10-18",
    endDate: "2026-10-22",
    allDay: false,
    startTime: "09:00",
    endTime: "13:00",
    reason: "Maintenance",
  };

  it("emits one entry per day, clipped to the range", () => {
    const entries = blockEntries([period], "2026-10-20", "2026-10-25");
    expect(entries.map((e) => e.date)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
    expect(entries[0]).toMatchObject({ venueId: 2, startMin: 540, endMin: 780, allDay: false });
  });

  it("marks all-day periods without times", () => {
    const [entry] = blockEntries([{ ...period, allDay: true, startTime: null, endTime: null }], "2026-10-20", "2026-10-20");
    expect(entry).toMatchObject({ allDay: true, startMin: null, endMin: null });
  });
});

describe("layoutLanes", () => {
  it("gives a lone entry the full width", () => {
    expect(layoutLanes([{ startMin: 60, endMin: 120 }])).toEqual([{ lane: 0, lanes: 1 }]);
  });

  it("puts two overlapping entries side by side", () => {
    const lanes = layoutLanes([
      { startMin: 600, endMin: 720 },
      { startMin: 630, endMin: 690 },
    ]);
    expect(lanes).toEqual([
      { lane: 0, lanes: 2 },
      { lane: 1, lanes: 2 },
    ]);
  });

  it("reuses a lane once an earlier entry has ended, and keeps separate clusters apart", () => {
    const lanes = layoutLanes([
      { startMin: 600, endMin: 660 },
      { startMin: 630, endMin: 720 },
      { startMin: 660, endMin: 700 },
      { startMin: 900, endMin: 960 },
    ]);
    expect(lanes[2].lane).toBe(0);
    expect(lanes[0].lanes).toBe(2);
    expect(lanes[3]).toEqual({ lane: 0, lanes: 1 });
  });
});
