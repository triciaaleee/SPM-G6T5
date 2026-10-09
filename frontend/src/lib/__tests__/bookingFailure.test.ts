import { describe, expect, it } from "vitest";
import { BookingConflictError, BookingRequestError, describeBookingFailure } from "../venuesApi";

/** E4-8 AC6 / E4-11: one wording for a refused booking across all three surfaces. */
describe("describeBookingFailure", () => {
  const conflict = {
    bookingId: 4,
    status: "Approved" as const,
    window: "2026-11-10 09:30–12:45",
    requestedWindow: "2026-11-10 10:30–13:45",
    setupMinutes: 30,
    turnaroundMinutes: 45,
  };

  it("names both windows and the padding that widened them", () => {
    const message = describeBookingFailure(
      new BookingConflictError("Venue is not available for this period", conflict),
    );

    expect(message).toContain("2026-11-10 09:30–12:45");
    expect(message).toContain("2026-11-10 10:30–13:45");
    expect(message).toContain("setup 30 min");
    expect(message).toContain("turnaround 45 min");
  });

  it("leaves the padding out for a venue that needs none", () => {
    const message = describeBookingFailure(
      new BookingConflictError("Venue is not available for this period", {
        ...conflict,
        setupMinutes: 0,
        turnaroundMinutes: 0,
      }),
    );

    expect(message).toContain("2026-11-10 09:30–12:45");
    expect(message).not.toContain("setup");
  });

  it("falls back to the error's own message for any other failure", () => {
    expect(describeBookingFailure(new BookingRequestError("Event is no longer in Planning"))).toBe(
      "Event is no longer in Planning",
    );
    // A conflict with no detail still reads as the server's message.
    expect(describeBookingFailure(new BookingConflictError("Venue is not available for this period"))).toBe(
      "Venue is not available for this period",
    );
  });

  it("uses the caller's fallback when there is no message at all", () => {
    expect(describeBookingFailure({}, "Failed to request this venue")).toBe("Failed to request this venue");
  });
});
