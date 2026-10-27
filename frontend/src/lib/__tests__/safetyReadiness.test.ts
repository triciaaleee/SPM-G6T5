import { describe, expect, it } from "vitest";
import { equipmentIsRequired, equipmentReadiness, isReadyForSafetyReview, venueReadiness } from "../safetyReadiness";
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
    expect(venueReadiness(undefined)).toEqual({ done: false, caption: "Checking…", needsAction: false });
  });

  it("says no venue has been requested yet", () => {
    expect(venueReadiness([])).toEqual({ done: false, caption: "No venue requested yet", needsAction: false });
  });

  it("counts approved against all live bookings and names who is still to decide", () => {
    const result = venueReadiness([booking("Approved", 1), booking("Requested", 2), booking("Requested", 3)]);
    expect(result).toEqual({ done: false, caption: "1 of 3 approved, 2 awaiting Venue Staff", needsAction: false });
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
    expect(result).toEqual({ done: true, caption: "1 of 1 approved", needsAction: false });
  });

  it("is not done when only unsettled bookings remain", () => {
    expect(venueReadiness([booking("Requested")]).done).toBe(false);
    expect(venueReadiness([booking("Rejected")]).done).toBe(false);
  });
});

describe("needs action", () => {
  it("flags a Replacement Required venue booking", () => {
    const result = venueReadiness([booking("Approved", 1), booking("Replacement Required", 2)]);
    expect(result).toMatchObject({ done: false, needsAction: true });
  });

  it("flags equipment whose reservation no longer holds, naming it", () => {
    const flagged = { ...item(1, 1), equipmentType: "Chair", reservationFlag: { flagged: true, reason: "Damaged" } };
    expect(equipmentReadiness([request([flagged])])).toEqual({
      done: false,
      caption: "A reserved chair is unavailable.",
      needsAction: true,
    });
  });

  it("is not needs-action while merely waiting", () => {
    expect(venueReadiness([booking("Approved", 1), booking("Requested", 2)]).needsAction).toBe(false);
    expect(equipmentReadiness([request([item(2, 1)])]).needsAction).toBe(false);
  });
});

describe("equipmentReadiness", () => {
  it("is checking while the requests load", () => {
    expect(equipmentReadiness(undefined)).toEqual({ done: false, caption: "Checking…", needsAction: false });
  });

  it("has nothing outstanding when no equipment was requested, or the request was cancelled", () => {
    expect(equipmentReadiness([])).toEqual({ done: true, caption: "No equipment requested", needsAction: false });
    expect(equipmentReadiness([request([item(2, 0)], "Cancelled")]).done).toBe(true);
  });

  it("is done when every item is fully reserved", () => {
    const result = equipmentReadiness([request([item(2, 2, 1), item(1, 1, 2), item(5, 5, 3)], "Arranged")]);
    expect(result).toEqual({ done: true, caption: "All 3 requested items arranged", needsAction: false });
  });

  it("counts partly reserved items as not yet reserved", () => {
    const result = equipmentReadiness([request([item(2, 2, 1), item(4, 1, 2), item(1, 0, 3)])]);
    expect(result).toEqual({
      done: false,
      caption: "3 of 7 units reserved (1 of 3 items complete)",
      needsAction: false,
    });
  });

  it("shows the shortfall in units, so 10 of 123 chairs isn't hidden", () => {
    expect(equipmentReadiness([request([item(123, 10)])], "123 Chairs").caption).toBe(
      "10 of 123 units reserved (0 of 1 items complete)",
    );
  });

  it("is not done when the organiser asked for equipment but no request is recorded yet", () => {
    expect(equipmentReadiness([], "123 Chairs, 20 Tables")).toEqual({
      done: false,
      caption: "Equipment requested, not arranged yet",
      needsAction: false,
    });
    expect(equipmentReadiness([request([item(2, 0)], "Cancelled")], "Projector").done).toBe(false);
  });

  it("has nothing outstanding when the organiser wrote NA or None", () => {
    for (const requirements of ["NA", "None", "n/a", "None required", "", undefined]) {
      expect(equipmentReadiness([], requirements)).toEqual({
        done: true,
        caption: "No equipment requested",
        needsAction: false,
      });
    }
  });

  it("is done once the requested equipment is fully reserved", () => {
    expect(equipmentReadiness([request([item(123, 123)])], "123 Chairs").done).toBe(true);
  });
});

describe("equipmentIsRequired", () => {
  it("is false for empty, NA, N/A, None, Nil and No, and true for anything else", () => {
    for (const answer of ["", "NA", "N/A", "none", "Nil", "No", "None required", "No equipment needed", "Not applicable", undefined, null]) expect(equipmentIsRequired(answer)).toBe(false);
    for (const answer of ["123 Chairs, 20 Tables", "Projector", "No projector, but 10 chairs"]) expect(equipmentIsRequired(answer)).toBe(true);
  });
});

describe("isReadyForSafetyReview", () => {
  it("needs both the venues and the equipment settled", () => {
    expect(isReadyForSafetyReview([booking("Approved")], [])).toBe(true);
    expect(isReadyForSafetyReview([booking("Requested")], [])).toBe(false);
    expect(isReadyForSafetyReview([booking("Approved")], [request([item(2, 1)])])).toBe(false);
    expect(isReadyForSafetyReview(undefined, [])).toBe(false);
    expect(isReadyForSafetyReview([booking("Approved")], [], "123 Chairs")).toBe(false);
    expect(isReadyForSafetyReview([booking("Approved")], [], "NA")).toBe(true);
  });
});
