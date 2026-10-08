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
 * Bookings that make a venue unavailable (AGENTS.md §3a): an Approved
 * booking, and an On Hold one until its hold_expires_at passes. A
 * Requested booking doesn't block — several coordinators may request the
 * same slot — and Rejected, Expired and Withdrawn ones free it.
 */
export const UNAVAILABLE_BOOKING_STATUSES: readonly BookingStatus[] = [BOOKING_STATUS.onHold, BOOKING_STATUS.approved];

/**
 * Whether a booking row blocks its venue right now. A stale On Hold row
 * (its hold already past) is treated as Expired, so it never blocks even
 * before the expiry sweep has rewritten its status.
 */
export function isBlockingBooking(
  booking: { status: string; hold_expires_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (booking.status === BOOKING_STATUS.approved) return true;
  if (booking.status !== BOOKING_STATUS.onHold) return false;
  return !booking.hold_expires_at || Date.parse(booking.hold_expires_at) > now.getTime();
}
