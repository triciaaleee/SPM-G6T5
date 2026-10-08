import { describe, expect, it } from "vitest";
import {
  blocksForDay,
  isBlockedAllDay,
  monthGridDays,
  shiftFocus,
  startOfWeek,
  visibleRange,
  weekDays,
} from "../availabilityCalendar";
import type { VenueAvailability } from "../venuesApi";

function availability(overrides: Partial<VenueAvailability> = {}): VenueAvailability {
  return {
    venue: {
      id: 3,
      name: "Innovation Hub",
      location: "North Campus",
      capacity: 180,
      setupMinutes: 30,
      turnaroundMinutes: 45,
      openingTime: "08:00",
      closingTime: "22:00",
    },
    bookings: [],
    unavailability: [],
    target: null,
    freeSlots: [],
    ...overrides,
  };
}

describe("calendar dates", () => {
  it("starts weeks on Monday", () => {
    expect(startOfWeek("2026-10-08")).toBe("2026-10-05"); // Thursday → Monday
    expect(startOfWeek("2026-10-11")).toBe("2026-10-05"); // Sunday → the Monday before
    expect(weekDays("2026-10-08")).toEqual([
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11",
    ]);
  });

  it("fills the month grid with whole weeks, never more than 42 days", () => {
    const days = monthGridDays("2026-10-15");
    expect(days[0]).toBe("2026-09-28");
    expect(days[days.length - 1]).toBe("2026-11-01");
    expect(days.length % 7).toBe(0);
    for (const month of ["2026-02-01", "2026-03-01", "2026-08-01", "2027-05-01"]) {
      expect(monthGridDays(month).length).toBeLessThanOrEqual(42);
    }
  });

  it("loads the week or month grid range", () => {
    expect(visibleRange("week", "2026-10-08")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(visibleRange("month", "2026-10-08")).toEqual({ from: "2026-09-28", to: "2026-11-01" });
  });

  it("steps by a month or a week", () => {
    expect(shiftFocus("month", "2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftFocus("week", "2026-10-08", -1)).toBe("2026-10-01");
  });
});

describe("blocksForDay", () => {
  const date = "2026-10-10";

  it("AC4: marks time outside operating hours as closed", () => {
    const closed = blocksForDay(availability(), date).filter((b) => b.kind === "closed");
    expect(closed.map((b) => [b.start, b.end])).toEqual([
      [0, 8 * 60],
      [22 * 60, 24 * 60],
    ]);
  });

  it("AC1/AC2/AC6: draws bookings over their padded window, distinct by status, with the event time as the core", () => {
    const blocks = blocksForDay(
      availability({
        bookings: [
          { id: 1, status: "Approved", date, startTime: "10:00", endTime: "12:00", occupiedStart: "09:30",
            occupiedEnd: "12:45", holdExpiresAt: null, event: { id: 11, name: "Gala" } },
          { id: 2, status: "On Hold", date, startTime: "14:00", endTime: "16:00", occupiedStart: "13:30",
            occupiedEnd: "16:45", holdExpiresAt: "2026-10-09T12:00:00Z", event: { id: 12, name: null } },
        ],
      }),
      date,
    );
    const approved = blocks.find((b) => b.kind === "approved")!;
    expect(approved).toMatchObject({ start: 9 * 60 + 30, end: 12 * 60 + 45, core: { start: 600, end: 720 }, label: "Gala" });
    const onHold = blocks.find((b) => b.kind === "on-hold")!;
    expect(onHold).toMatchObject({ start: 13 * 60 + 30, end: 16 * 60 + 45, label: "Event #12" });
  });

  it("puts overlapping bookings side by side", () => {
    const booking = (id: number, start: string, end: string) => ({
      id, status: "Approved" as const, date, startTime: start, endTime: end, occupiedStart: start, occupiedEnd: end,
      holdExpiresAt: null, event: { id, name: `E${id}` },
    });
    const blocks = blocksForDay(
      availability({ bookings: [booking(1, "10:00", "12:00"), booking(2, "11:00", "13:00"), booking(3, "14:00", "15:00")] }),
      date,
    ).filter((b) => b.booking);
    expect(blocks.map((b) => [b.booking!.id, b.lane, b.lanes])).toEqual([
      [1, 0, 2],
      [2, 1, 2],
      [3, 0, 1],
    ]);
  });

  it("AC4/AC5: includes block-outs covering the day and the day's free slots", () => {
    const data = availability({
      unavailability: [
        { id: 5, venueId: 3, startDate: "2026-10-09", endDate: "2026-10-11", allDay: false,
          startTime: "09:00", endTime: "13:00", reason: "Maintenance" },
        { id: 6, venueId: 3, startDate: "2026-10-12", endDate: "2026-10-12", allDay: true,
          startTime: null, endTime: null, reason: "Private hire" },
      ],
      freeSlots: [{ date, start: "13:00", end: "22:00", eventStart: "13:30", eventEnd: "21:15" }],
    });
    const blocks = blocksForDay(data, date);
    expect(blocks.filter((b) => b.kind === "blocked").map((b) => b.label)).toEqual(["Maintenance"]);
    expect(blocks.filter((b) => b.kind === "free").map((b) => [b.start, b.end])).toEqual([[780, 1320]]);
    expect(isBlockedAllDay(data, date)).toBe(false);
    expect(isBlockedAllDay(data, "2026-10-12")).toBe(true);
  });
});
