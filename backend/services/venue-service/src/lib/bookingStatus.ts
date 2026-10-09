/**
 * Booking-approval statuses for venue_bookings.status — the Postgres enum
 * `venue_booking_status` (migration 0014), in the enum's order. A booking request
 * is approved or rejected, not the venue itself. Use these instead of
 * string literals.
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
 * Bookings that can make a venue unavailable (AGENTS.md §3a). `Requested`
 * is deliberately absent: a request is not a hold, so several coordinators
 * may request the same venue and slot at once and the first one Venue Staff
 * put `On Hold` or `Approved` wins. `Rejected`, `Expired`, `Withdrawn` and
 * `Replacement Required` all free the venue.
 *
 * This is the status filter for the database query; an `On Hold` row also
 * has to still be unexpired, which is what blocksVenue below decides.
 */
export const UNAVAILABLE_BOOKING_STATUSES: readonly BookingStatus[] = ["On Hold", "Approved"];

/** The booking fields needed to tell whether it currently blocks its venue. */
export interface BlockingBooking {
  status: BookingStatus;
  hold_expires_at?: string | null;
}

/**
 * Does this booking block its venue right now? `Approved` always does. An
 * `On Hold` booking blocks only until `hold_expires_at` (Week 7 change 4):
 * §3a requires expiry to be applied whenever availability is checked, so a
 * stale hold nobody has swept yet never blocks a venue. A hold with no
 * expiry recorded is treated as blocking — it shouldn't exist (§3a: a hold
 * must have an expiry), and the safe reading of a venue that may be held is
 * that it is unavailable.
 */
export function blocksVenue(booking: BlockingBooking, now: Date = new Date()): boolean {
  if (booking.status === "Approved") return true;
  if (booking.status !== "On Hold") return false;
  if (!booking.hold_expires_at) return true;
  return Date.parse(booking.hold_expires_at) > now.getTime();
}

/**
 * How long a tentative hold lasts (Week 7 change 4, E4-12: a **fixed**
 * hold duration). Venue Staff get three days to turn a hold into an
 * approval before the venue frees itself.
 */
export const HOLD_DURATION_HOURS = 72;

/** When a hold placed at `now` lapses. */
export function holdExpiryFrom(now: Date = new Date()): string {
  return new Date(now.getTime() + HOLD_DURATION_HOURS * 60 * 60 * 1000).toISOString();
}

/**
 * The transitions AGENTS.md §3a allows, as `from -> to`. Everything absent
 * here is refused: `Rejected`, `Expired` and `Withdrawn` are end states, and
 * there is no path back to `Requested` — to try again the coordinator makes
 * a new request (E4-10: no override of a Venue Staff decision).
 *
 * `Withdrawn` is the coordinator's (E4-9) and `Replacement Required` the
 * venue-unavailability flow's (Week 7 change 2); both are listed so this
 * stays the one description of the machine.
 */
const ALLOWED_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  Requested: ["On Hold", "Approved", "Rejected", "Withdrawn"],
  "On Hold": ["Approved", "Rejected", "Expired", "Withdrawn"],
  Approved: ["Replacement Required", "Withdrawn"],
  Rejected: [],
  Expired: [],
  "Replacement Required": ["Withdrawn"],
  Withdrawn: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * The same check under the name main's call sites use. Kept as a thin
 * wrapper rather than a rename so neither side of the merge had to change.
 */
export function isBlockingBooking(
  booking: { status: string; hold_expires_at?: string | null },
  now: Date = new Date(),
): boolean {
  return blocksVenue(booking as BlockingBooking, now);
}
