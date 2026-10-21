import { describe, expect, it } from "vitest";
import { equipmentReadiness, isReadyForSafetyReview, venueReadiness } from "../safetyReadiness";
import type { EquipmentItem, EquipmentRequest } from "../equipmentApi";
import type { EventVenueBooking } from "../venuesApi";

function booking(status: EventVenueBooking["status"], id = 1): EventVenueBooking {
  return { id, status, holdExpiresAt: null, decisionReason: null, createdAt: "2026-10-07T02:00:00.000Z", venue: null };
}

function item(quantity: number, quantityFulfilled: number, id = 1): EquipmentItem {
  return {
    id,
    equipmentType: "Projector",
    quantity,
    quantityFulfilled,
    reservationFlag: { flagged: false, reason: null },
  };
}

function request(items: EquipmentItem[], status = "Requested"): EquipmentRequest {
  return { id: 1, eventId: 7, status, fulfillmentNote: null, createdAt: "2026-10-07T02:00:00.000Z", items };
}

describe("venueReadiness", () => {
  it("is checking while the bookings load", () => {
    expect(venueReadiness(undefined)).toEqual({ done: false, caption: "Checking…" });
  });

  it("says no venue has been requested yet", () => {
    expect(venueReadiness([])).toEqual({ done: false, caption: "No venue requested yet" });
  });

  it("counts approved against all live bookings and names who is still to decide", () => {
    const result = venueReadiness([booking("Approved", 1), booking("Requested", 2), booking("Requested", 3)]);
    expect(result).toEqual({ done: false, caption: "1 of 3 approved, 2 awaiting Venue Staff" });
  });

  it("mentions holds and replacements", () => {
    expect(venueReadiness([booking("Approved", 1), booking("On Hold", 2)]).caption).toBe("1 of 2 approved, 1 on hold");
    expect(venueReadiness([booking("Approved", 1), booking("Replacement Required", 2)]).caption).toBe(
      "1 of 2 approved, 1 needs a replacement",
    );
  });

  it("ignores rejected, withdrawn and expired bookings", () => {
    const result = venueReadiness([
      booking("Approved", 1),
      booking("Rejected", 2),
      booking("Withdrawn", 3),
      booking("Expired", 4),
    ]);
    expect(result).toEqual({ done: true, caption: "1 of 1 approved" });
  });

  it("is not done when only unsettled bookings remain", () => {
    expect(venueReadiness([booking("Requested")]).done).toBe(false);
    expect(venueReadiness([booking("Rejected")]).done).toBe(false);
  });
});

describe("equipmentReadiness", () => {
  it("is checking while the requests load", () => {
    expect(equipmentReadiness(undefined)).toEqual({ done: false, caption: "Checking…" });
  });

  it("has nothing outstanding when no equipment was requested, or the request was cancelled", () => {
    expect(equipmentReadiness([])).toEqual({ done: true, caption: "No equipment requested" });
    expect(equipmentReadiness([request([item(2, 0)], "Cancelled")]).done).toBe(true);
  });

  it("is done when every item is fully reserved", () => {
    const result = equipmentReadiness([request([item(2, 2, 1), item(1, 1, 2), item(5, 5, 3)], "Arranged")]);
    expect(result).toEqual({ done: true, caption: "All 3 requested items arranged" });
  });

  it("counts partly reserved items as not yet reserved", () => {
    const result = equipmentReadiness([request([item(2, 2, 1), item(4, 1, 2), item(1, 0, 3)])]);
    expect(result).toEqual({ done: false, caption: "1 of 3 items reserved" });
  });
});

describe("isReadyForSafetyReview", () => {
  it("needs both the venues and the equipment settled", () => {
    expect(isReadyForSafetyReview([booking("Approved")], [])).toBe(true);
    expect(isReadyForSafetyReview([booking("Requested")], [])).toBe(false);
    expect(isReadyForSafetyReview([booking("Approved")], [request([item(2, 1)])])).toBe(false);
    expect(isReadyForSafetyReview(undefined, [])).toBe(false);
  });
});
