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
  /** Something has gone wrong (a replacement is needed, a reserved item is unavailable), not just "not done yet". */
  needsAction: boolean;
}

/** Bookings that no longer count either way. */
const LEFT_OUT_BOOKING_STATUSES: ReadonlySet<string> = new Set(["Rejected", "Withdrawn", "Expired"]);

const CHECKING: Readiness = { done: false, caption: "Checking…", needsAction: false };

/** Venues approved. Pass undefined while the bookings are still loading. */
export function venueReadiness(bookings: EventVenueBooking[] | undefined): Readiness {
  if (!bookings) return CHECKING;

  const counted = bookings.filter((booking) => !LEFT_OUT_BOOKING_STATUSES.has(booking.status));
  if (counted.length === 0) return { done: false, caption: "No venue requested yet", needsAction: false };

  const approved = counted.filter((booking) => booking.status === "Approved").length;
  const awaiting = counted.filter((booking) => booking.status === "Requested").length;
  const onHold = counted.filter((booking) => booking.status === "On Hold").length;
  const replacement = counted.filter((booking) => booking.status === "Replacement Required").length;

  const parts = [`${approved} of ${counted.length} approved`];
  if (awaiting > 0) parts.push(`${awaiting} awaiting Venue Staff`);
  if (onHold > 0) parts.push(`${onHold} on hold`);
  if (replacement > 0) parts.push(`${replacement} ${replacement === 1 ? "needs" : "need"} a replacement`);

  const needsAction = replacement > 0 || counted.some((booking) => booking.status === "Cancelled");
  return { done: approved > 0 && approved === counted.length, caption: parts.join(", "), needsAction };
}

/**
 * What an organiser writes when they need no equipment: "NA", "N/A", "None", "Nil", "No", "Nothing", "Not
 * applicable", optionally followed by filler such as "required", "needed" or "equipment" ("None required").
 * Mirrors events-service `equipmentIsRequired`.
 */
const NO_EQUIPMENT_ANSWER = /^(?:|na|n a|none|nil|nothing|no|not applicable|not required)(?: (?:required|needed|equipment|requirements?|needs?))*$/;

/** Whether the organiser's Equipment Requirements text asks for any equipment. */
export function equipmentIsRequired(requirements: string | null | undefined): boolean {
  const answer = (requirements ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return !NO_EQUIPMENT_ANSWER.test(answer);
}

/**
 * Equipment reserved. Pass undefined for `requests` while they are still loading.
 * `requirements` is the organiser's Equipment Requirements text: when it asks for equipment,
 * having no request recorded yet is not the same as nothing requested.
 */
export function equipmentReadiness(
  requests: EquipmentRequest[] | undefined,
  requirements?: string | null,
): Readiness {
  if (!requests) return CHECKING;

  const items = requests.filter((request) => request.status !== "Cancelled").flatMap((request) => request.items);
  if (items.length === 0) {
    return equipmentIsRequired(requirements)
      ? { done: false, caption: "Equipment requested, not arranged yet", needsAction: false }
      : { done: true, caption: "No equipment requested", needsAction: false };
  }

  const flagged = items.filter((item) => item.reservationFlag?.flagged);
  if (flagged.length > 0) {
    const caption =
      flagged.length === 1
        ? `A reserved ${flagged[0].equipmentType.toLowerCase()} is unavailable.`
        : `${flagged.length} reserved items are unavailable.`;
    return { done: false, caption, needsAction: true };
  }

  const reserved = items.filter((item) => item.quantityFulfilled >= item.quantity).length;
  if (reserved === items.length) {
    return {
      done: true,
      caption: `All ${items.length} requested ${items.length === 1 ? "item" : "items"} arranged`,
      needsAction: false,
    };
  }
  const unitsWanted = items.reduce((sum, item) => sum + item.quantity, 0);
  const unitsReserved = items.reduce((sum, item) => sum + Math.min(item.quantityFulfilled, item.quantity), 0);
  return {
    done: false,
    caption: `${unitsReserved} of ${unitsWanted} units reserved (${reserved} of ${items.length} items complete)`,
    needsAction: false,
  };
}

export function isReadyForSafetyReview(
  bookings: EventVenueBooking[] | undefined,
  requests: EquipmentRequest[] | undefined,
  requirements?: string | null,
): boolean {
  return venueReadiness(bookings).done && equipmentReadiness(requests, requirements).done;
}
