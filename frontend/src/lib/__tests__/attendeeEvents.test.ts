import { describe, expect, it } from "vitest";
import { formatCardDate, formatCardTimeRange, isPastRegistration } from "../attendeeEvents";
import { landingRouteForRole } from "../auth";
import { registrationBadgeClass } from "../registrationStatus";
import type { MyRegistration } from "../registrationApi";

function registration(event: Partial<NonNullable<MyRegistration["event"]>> | null): MyRegistration {
  return {
    registrationId: 1,
    eventId: 1,
    userId: "ATT-0001",
    status: "Registered",
    createdAt: "2026-01-01T00:00:00Z",
    additionalInfo: null,
    event: event && {
      name: "Fair",
      description: null,
      proposedDate: "2026-11-14",
      startTime: "10:00",
      endTime: "16:00",
      venues: [],
      accessibility: null,
      ...event,
    },
  };
}

describe("formatCardDate", () => {
  it("shows the date without a weekday", () => {
    expect(formatCardDate("2026-11-14")).toBe("14 Nov 2026");
    expect(formatCardDate("2026-11-06")).toBe("6 Nov 2026");
  });

  it("falls back when the date is missing or unreadable", () => {
    expect(formatCardDate(null)).toBe("Date to be confirmed");
    expect(formatCardDate("soon")).toBe("soon");
  });
});

describe("formatCardTimeRange", () => {
  it("shows a 12-hour range", () => {
    expect(formatCardTimeRange("10:00", "16:00")).toBe("10:00 AM to 4:00 PM");
    expect(formatCardTimeRange("00:30", "12:00")).toBe("12:30 AM to 12:00 PM");
  });

  it("degrades when a time is missing", () => {
    expect(formatCardTimeRange("10:00", null)).toBe("10:00 AM");
    expect(formatCardTimeRange(null, null)).toBe("Time to be confirmed");
  });
});

describe("isPastRegistration", () => {
  const now = new Date("2026-11-14T12:00:00");

  it("is upcoming until the event's end time passes", () => {
    expect(isPastRegistration(registration({}), now)).toBe(false);
    expect(isPastRegistration(registration({ endTime: "11:00" }), now)).toBe(true);
  });

  it("is past for an earlier date", () => {
    expect(isPastRegistration(registration({ proposedDate: "2026-11-13" }), now)).toBe(true);
  });

  it("keeps an event with no date, or no event info, under upcoming", () => {
    expect(isPastRegistration(registration({ proposedDate: null }), now)).toBe(false);
    expect(isPastRegistration(registration(null), now)).toBe(false);
  });
});

describe("attendee landing and badges", () => {
  it("sends attendees to their own homepage", () => {
    expect(landingRouteForRole("attendee")).toBe("attendee-events");
    expect(landingRouteForRole("organiser")).toBe("events-list");
  });

  it("maps statuses to badge classes", () => {
    expect(registrationBadgeClass("Registered")).toBe("status-success");
    expect(registrationBadgeClass("Withdrawn")).toBe("status-warning");
  });
});
