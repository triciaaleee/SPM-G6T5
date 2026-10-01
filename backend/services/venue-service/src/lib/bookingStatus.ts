/**
 * Booking-approval statuses for venue_bookings.status — the Postgres enum
 * `venue_status` (migration 0014), in the enum's order. A booking request
 * is approved or rejected, not the venue itself. Use these instead of
 * string literals.
 */
export const BOOKING_STATUSES = ["Requested", "Approved", "Rejected"] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * Bookings that make a venue unavailable. A pending request is a tentative
 * hold, so two events can't both be requested into the same slot; a
 * rejected one frees the slot.
 */
export const UNAVAILABLE_BOOKING_STATUSES: readonly BookingStatus[] = ["Requested", "Approved"];
