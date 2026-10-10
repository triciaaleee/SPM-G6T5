import type { ArrangementBooking, ArrangementEquipmentRequest } from "./arrangementsClient.js";

/**
 * E3-4: the rules for submitting an event for safety review — what must be
 * settled first (AC1–AC4) and the safety notes the coordinator must give
 * (AC5). Pure, so the route only fetches and writes.
 */

/** Booking statuses still awaiting an outcome (AC2) — any one blocks submission. */
export const UNSETTLED_BOOKING_STATUSES: ReadonlySet<string> = new Set([
  "Requested",
  "On Hold",
  "Replacement Required",
]);

const APPROVED_BOOKING_STATUS = "Approved";

export interface OutstandingBooking {
  bookingId: number;
  venueName: string | null;
  status: string;
}

export interface OutstandingEquipmentItem {
  requestId: number;
  equipmentType: string;
  quantity: number;
  quantityReserved: number;
}

export interface OutstandingArrangements {
  /** AC2: no booking at all has been approved. */
  noApprovedVenue: boolean;
  /** AC2: bookings still Requested, On Hold or Replacement Required. */
  bookings: OutstandingBooking[];
  /** AC3: requested equipment not yet fully reserved. */
  equipment: OutstandingEquipmentItem[];
}

/**
 * What stops the event entering Safety Review. Rejected, Withdrawn and
 * Expired bookings stay on record but don't block (AC2). An equipment item
 * counts as reserved once Technical Support have fulfilled its full
 * quantity; an event that requested no equipment has nothing outstanding
 * there (AC4).
 */
export function findOutstandingArrangements(
  bookings: ArrangementBooking[],
  equipmentRequests: ArrangementEquipmentRequest[],
): OutstandingArrangements {
  return {
    noApprovedVenue: !bookings.some((booking) => booking.status === APPROVED_BOOKING_STATUS),
    bookings: bookings
      .filter((booking) => UNSETTLED_BOOKING_STATUSES.has(booking.status))
      .map((booking) => ({ bookingId: booking.id, venueName: booking.venue?.name ?? null, status: booking.status })),
    equipment: equipmentRequests.flatMap((request) =>
      request.items
        .filter((item) => item.quantityFulfilled < item.quantity)
        .map((item) => ({
          requestId: request.id,
          equipmentType: item.equipmentType,
          quantity: item.quantity,
          quantityReserved: item.quantityFulfilled,
        })),
    ),
  };
}

export function hasOutstanding(outstanding: OutstandingArrangements): boolean {
  return outstanding.noApprovedVenue || outstanding.bookings.length > 0 || outstanding.equipment.length > 0;
}

/**
 * One readable sentence naming every outstanding arrangement, e.g. "Settle
 * these first: Grand Ballroom is still On Hold; Projector: 1 of 2 reserved."
 */
export function describeOutstanding(outstanding: OutstandingArrangements): string {
  const parts: string[] = [];
  if (outstanding.noApprovedVenue) parts.push("the event has no approved venue booking");
  for (const booking of outstanding.bookings) {
    parts.push(`${booking.venueName ?? `Venue booking #${booking.bookingId}`} is still ${booking.status}`);
  }
  for (const item of outstanding.equipment) {
    parts.push(`${item.equipmentType}: ${item.quantityReserved} of ${item.quantity} reserved`);
  }
  return `This event can't be submitted for safety review yet. Settle these first: ${parts.join("; ")}.`;
}

/** AC5: the safety notes, one per topic the Safety Officer checks. */
export interface SafetyNotes {
  equipmentPlacement: string;
  crowdMovement: string;
  emergencyAccess: string;
  venueRestrictions: string;
}

export const SAFETY_NOTE_FIELDS: Record<keyof SafetyNotes, string> = {
  equipmentPlacement: "equipment placement",
  crowdMovement: "crowd movement",
  emergencyAccess: "emergency access",
  venueRestrictions: "known venue restrictions",
};

export const MAX_SAFETY_NOTE_LENGTH = 2000;

export type SafetyNotesResult = { valid: true; notes: SafetyNotes } | { valid: false; fields: Record<string, string> };

/**
 * Reads `{ safetyNotes: { equipmentPlacement, crowdMovement,
 * emergencyAccess, venueRestrictions } }`. Every note is required; every
 * problem is reported at once, keyed by field.
 */
export function parseSafetyNotes(body: unknown): SafetyNotesResult {
  const raw = body && typeof body === "object" ? (body as Record<string, unknown>).safetyNotes : undefined;
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const notes = {} as SafetyNotes;
  const fields: Record<string, string> = {};
  for (const [key, label] of Object.entries(SAFETY_NOTE_FIELDS) as [keyof SafetyNotes, string][]) {
    const value = typeof source[key] === "string" ? (source[key] as string).trim() : "";
    if (!value) {
      fields[key] =
        key === "venueRestrictions"
          ? `Describe any ${label}, or write "None known".`
          : `Describe the ${label}.`;
    } else if (value.length > MAX_SAFETY_NOTE_LENGTH) {
      fields[key] = `Keep this under ${MAX_SAFETY_NOTE_LENGTH} characters.`;
    }
    notes[key] = value;
  }

  return Object.keys(fields).length > 0 ? { valid: false, fields } : { valid: true, notes };
}
