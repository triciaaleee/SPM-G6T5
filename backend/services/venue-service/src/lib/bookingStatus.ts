/**
 * Booking-approval statuses for venue_bookings.status — the Postgres enum
 * `venue_status` (migration 0014), in the enum's order. A booking request
 * is approved or rejected, not the venue itself (AGENTS.md §3a). Use these
 * instead of string literals.
 */
export const BOOKING_STATUSES = [
  "Requested",
  "On Hold",
  "Approved",
  "Rejected",
  "Expired",
  "Replacement Required",
  "Withdrawn",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Named access to the same values, for code that checks or sets a specific status. */
export const BOOKING_STATUS = {
  requested: "Requested",
  onHold: "On Hold",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  /** E4-3: an Approved booking caught by a block-out; its coordinator must find another venue. */
  replacementRequired: "Replacement Required",
  withdrawn: "Withdrawn",
} as const satisfies Record<string, BookingStatus>;

/**
 * Bookings that make a venue unavailable. A pending request is a tentative
 * hold, so two events can't both be requested into the same slot; a
 * rejected one frees the slot.
 */
export const UNAVAILABLE_BOOKING_STATUSES: readonly BookingStatus[] = ["Requested", "Approved"];
