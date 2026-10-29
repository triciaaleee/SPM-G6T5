import { describe, expect, it } from "vitest";
import { describeBlockOutResult, type AffectedBooking, type CreatePeriodResult } from "../unavailabilityApi";

function affected(overrides: Partial<AffectedBooking> = {}): AffectedBooking {
  return {
    bookingId: 1,
    status: "Approved",
    eventId: 1,
    eventName: "Alumni Gala",
    date: "2099-06-01",
    startTime: "10:00",
    endTime: "12:00",
    occupiedStart: "10:00",
    occupiedEnd: "12:00",
    hasCoordinator: true,
    replacementRequired: true,
    ...overrides,
  };
}

function result(overrides: Partial<CreatePeriodResult> = {}): CreatePeriodResult {
  return {
    period: {
      id: 1,
      venueId: 1,
      startDate: "2099-06-01",
      endDate: "2099-06-01",
      allDay: true,
      startTime: null,
      endTime: null,
      reason: "Maintenance",
    },
    affected: [],
    coordinatorsNotified: 0,
    notificationsFailed: false,
    ...overrides,
  };
}

describe("describeBlockOutResult", () => {
  it("just says it shows as unavailable when no booking is affected", () => {
    expect(describeBlockOutResult(result(), "Period blocked out.")).toEqual({
      text: "Period blocked out. It shows as unavailable on the calendar.",
      warning: false,
    });
  });

  it("counts cancelled bookings and clashing pending requests, and how many coordinators were told", () => {
    const outcome = describeBlockOutResult(
      result({
        affected: [
          affected({ bookingId: 1 }),
          affected({ bookingId: 2 }),
          affected({ bookingId: 3, status: "Requested", replacementRequired: false }),
        ],
        coordinatorsNotified: 3,
      }),
      "Block-out updated.",
    );

    expect(outcome.text).toBe("Block-out updated. 2 bookings cancelled; 1 pending request clash with it; 3 coordinators notified.");
    expect(outcome.warning).toBe(false);
  });

  it("warns when the coordinators could not be notified", () => {
    const outcome = describeBlockOutResult(
      result({ affected: [affected()], notificationsFailed: true }),
      "Period blocked out.",
    );

    expect(outcome.text).toContain("1 booking cancelled");
    expect(outcome.text).toContain("couldn't notify the coordinators");
    expect(outcome.warning).toBe(true);
  });
});
