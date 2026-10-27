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
  /** The organiser asked for equipment (their text, trimmed) but none has been recorded for the event yet. */
  equipmentNotArranged: string | null;
}

/** What an organiser writes when they need no equipment. Compared lower-case, ignoring punctuation and spacing. */
const NO_EQUIPMENT_ANSWERS: ReadonlySet<string> = new Set(["", "na", "none", "nil", "no"]);

/**
 * Whether the organiser's Equipment Requirements text asks for any equipment.
 * Empty, "NA", "N/A", "None", "Nil" and "No" (any case) mean it doesn't.
 */
export function equipmentIsRequired(requirements: string | null | undefined): boolean {
  const answer = (requirements ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return !NO_EQUIPMENT_ANSWERS.has(answer);
}

/**
 * What stops the event entering Safety Review. Rejected, Withdrawn and
 * Expired bookings stay on record but don't block (AC2). An equipment item
 * counts as reserved once Technical Support have fulfilled its full
 * quantity. An event whose organiser asked for no equipment (NA / None) has
 * nothing outstanding there (AC4); one that asked for some is outstanding
 * until a request has been recorded, so "no request yet" is never read as
 * "nothing requested".
 */
export function findOutstandingArrangements(
  bookings: ArrangementBooking[],
  equipmentRequests: ArrangementEquipmentRequest[],
  equipmentRequirements?: string | null,
): OutstandingArrangements {
  const recordedItems = equipmentRequests
    .filter((request) => request.status !== "Cancelled")
    .reduce((count, request) => count + request.items.length, 0);

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
    equipmentNotArranged:
      equipmentIsRequired(equipmentRequirements) && recordedItems === 0 ? (equipmentRequirements ?? "").trim() : null,
  };
}

export function hasOutstanding(outstanding: OutstandingArrangements): boolean {
  return (
    outstanding.noApprovedVenue ||
    outstanding.bookings.length > 0 ||
    outstanding.equipment.length > 0 ||
    outstanding.equipmentNotArranged !== null
  );
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
  if (outstanding.equipmentNotArranged !== null) {
    parts.push(`the requested equipment (${outstanding.equipmentNotArranged}) hasn't been arranged yet`);
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

/** E3-13: the Safety Officer's reason for rejecting, same cap as a safety note. */
export const MAX_SAFETY_DECISION_REASON_LENGTH = 2000;

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
