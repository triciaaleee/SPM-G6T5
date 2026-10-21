import { describe, expect, it } from "vitest";
import { arrangementsNeedingReview } from "../arrangementsReview";
import type { EquipmentItem, EquipmentRequest } from "../equipmentApi";
import type { SafetyChangeFlag, SafetyChangeRequest } from "../eventsApi";
import type { EventVenueBooking } from "../venuesApi";

function booking(id: number, status: EventVenueBooking["status"]): EventVenueBooking {
  return { id, status, holdExpiresAt: null, decisionReason: null, createdAt: "2026-10-07T02:00:00Z", venue: null };
}

function item(id: number, flagged: boolean): EquipmentItem {
  return {
    id,
    equipmentType: "Projector",
    quantity: 1,
    quantityFulfilled: 1,
    reservationFlag: { flagged, reason: flagged ? "Stock changed" : null },
  };
}

function request(items: EquipmentItem[], status = "Arranged"): EquipmentRequest {
  return { id: 1, eventId: 7, status, fulfillmentNote: null, createdAt: "2026-10-07T02:00:00Z", items };
}

function safetyChanges(flags: Partial<SafetyChangeFlag>[]): SafetyChangeRequest {
  return {
    reviewId: 1,
    officerName: "Sam",
    requestedAt: "2026-10-08T02:00:00Z",
    reason: "Fix",
    generalNote: null,
    arrangementsChecked: true,
    flags: flags.map((flag, index) => ({
      type: "venue_booking",
      id: index + 1,
      label: "Item",
      note: "Change it",
      clearedAt: null,
      ...flag,
    })),
  };
}

describe("arrangementsNeedingReview", () => {
  it("is 0 with nothing to review, or while nothing has loaded", () => {
    expect(arrangementsNeedingReview({})).toBe(0);
    expect(arrangementsNeedingReview({ bookings: [booking(1, "Approved"), booking(2, "Requested")] })).toBe(0);
    expect(arrangementsNeedingReview({ bookings: null, equipmentRequests: null, safetyChanges: null })).toBe(0);
  });

  it("counts venue bookings that need a replacement or are on hold", () => {
    const bookings = [booking(1, "Replacement Required"), booking(2, "On Hold"), booking(3, "Approved")];
    expect(arrangementsNeedingReview({ bookings })).toBe(2);
  });

  it("counts equipment items whose reservation no longer holds, ignoring cancelled requests", () => {
    const equipmentRequests = [
      request([item(1, true), item(2, false)]),
      request([item(3, true)], "Cancelled"),
    ];
    expect(arrangementsNeedingReview({ equipmentRequests })).toBe(1);
  });

  it("counts Safety Officer flags that have not been changed yet", () => {
    const changes = safetyChanges([
      { type: "venue_booking", id: 5 },
      { type: "equipment_item", id: 6 },
      { type: "venue_booking", id: 7, clearedAt: "2026-10-09T02:00:00Z" },
    ]);
    expect(arrangementsNeedingReview({ safetyChanges: changes })).toBe(2);
  });

  it("counts an arrangement once even when it is flagged for two reasons", () => {
    const total = arrangementsNeedingReview({
      bookings: [booking(5, "Replacement Required")],
      equipmentRequests: [request([item(6, true)])],
      safetyChanges: safetyChanges([
        { type: "venue_booking", id: 5 },
        { type: "equipment_item", id: 6 },
        { type: "venue_booking", id: 8 },
      ]),
    });
    expect(total).toBe(3);
  });
});
