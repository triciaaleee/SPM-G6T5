import type { EquipmentRequest } from "./equipmentApi";
import type { EventVenueBooking } from "./venuesApi";

/**
 * E3-4 AC1-AC4: what has to be settled before an event can be submitted for
 * safety review, shown as a checklist. Mirrors events-service
 * `lib/safetyReview.ts` (which is what actually decides): a booking still
 * Requested, On Hold or Replacement Required blocks submission, Rejected /
 * Withdrawn / Expired ones stay on record but don't count, at least one
 * booking must be Approved, and every requested equipment item must be fully
 * reserved (an event that asked for no equipment has nothing outstanding).
 */

export interface Readiness {
  done: boolean;
  /** The line under the item's name, e.g. "1 of 3 approved, 2 awaiting Venue Staff". */
  caption: string;
}

/** Bookings that no longer count either way. */
const LEFT_OUT_BOOKING_STATUSES: ReadonlySet<string> = new Set(["Rejected", "Withdrawn", "Expired"]);

const CHECKING: Readiness = { done: false, caption: "Checking…" };

/** Venues approved. Pass undefined while the bookings are still loading. */
export function venueReadiness(bookings: EventVenueBooking[] | undefined): Readiness {
  if (!bookings) return CHECKING;

  const counted = bookings.filter((booking) => !LEFT_OUT_BOOKING_STATUSES.has(booking.status));
  if (counted.length === 0) return { done: false, caption: "No venue requested yet" };

  const approved = counted.filter((booking) => booking.status === "Approved").length;
  const awaiting = counted.filter((booking) => booking.status === "Requested").length;
  const onHold = counted.filter((booking) => booking.status === "On Hold").length;
  const replacement = counted.filter((booking) => booking.status === "Replacement Required").length;

  const parts = [`${approved} of ${counted.length} approved`];
  if (awaiting > 0) parts.push(`${awaiting} awaiting Venue Staff`);
  if (onHold > 0) parts.push(`${onHold} on hold`);
  if (replacement > 0) parts.push(`${replacement} ${replacement === 1 ? "needs" : "need"} a replacement`);

  return { done: approved > 0 && approved === counted.length, caption: parts.join(", ") };
}

/** Equipment reserved. Pass undefined while the requests are still loading. */
export function equipmentReadiness(requests: EquipmentRequest[] | undefined): Readiness {
  if (!requests) return CHECKING;

  const items = requests.filter((request) => request.status !== "Cancelled").flatMap((request) => request.items);
  if (items.length === 0) return { done: true, caption: "No equipment requested" };

  const reserved = items.filter((item) => item.quantityFulfilled >= item.quantity).length;
  if (reserved === items.length) {
    return { done: true, caption: `All ${items.length} requested ${items.length === 1 ? "item" : "items"} arranged` };
  }
  return { done: false, caption: `${reserved} of ${items.length} items reserved` };
}

export function isReadyForSafetyReview(
  bookings: EventVenueBooking[] | undefined,
  requests: EquipmentRequest[] | undefined,
): boolean {
  return venueReadiness(bookings).done && equipmentReadiness(requests).done;
}
