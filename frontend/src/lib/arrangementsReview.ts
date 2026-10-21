import type { EquipmentRequest } from "./equipmentApi";
import type { SafetyChangeRequest } from "./eventsApi";
import type { EventVenueBooking } from "./venuesApi";

/**
 * How many of an event's venue and equipment arrangements need the
 * coordinator's action, for the count badge on the Arrangements tab:
 *  - a venue booking that is Replacement Required (the venue became
 *    unavailable, Week 7 change 2) or On Hold (the hold lapses if it isn't
 *    decided, change 4);
 *  - an equipment item whose reservation no longer holds (E5-6);
 *  - an arrangement the Safety Officer flagged that hasn't been changed yet
 *    (E3-14).
 * Each arrangement counts once, even if it is flagged for more than one reason.
 */
export function arrangementsNeedingReview(input: {
  bookings?: EventVenueBooking[] | null;
  equipmentRequests?: EquipmentRequest[] | null;
  safetyChanges?: SafetyChangeRequest | null;
}): number {
  const needsReview = new Set<string>();

  for (const booking of input.bookings ?? []) {
    if (booking.status === "Replacement Required" || booking.status === "On Hold") {
      needsReview.add(`venue_booking:${booking.id}`);
    }
  }

  for (const request of input.equipmentRequests ?? []) {
    if (request.status === "Cancelled") continue;
    for (const item of request.items) {
      if (item.reservationFlag?.flagged) needsReview.add(`equipment_item:${item.id}`);
    }
  }

  for (const flag of input.safetyChanges?.flags ?? []) {
    if (!flag.clearedAt) needsReview.add(`${flag.type}:${flag.id}`);
  }

  return needsReview.size;
}
