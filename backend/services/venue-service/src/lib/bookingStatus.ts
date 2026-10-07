/**
 * venue_bookings.status values (Postgres enum venue_status, migrations
 * 0014 and 0016). Kept in one place so status strings aren't scattered
 * across routes — see AGENTS.md §5.
 */
export const BOOKING_STATUS = {
  requested: "Requested",
  approved: "Approved",
  rejected: "Rejected",
  /** E4-3: an Approved booking caught by a block-out; its coordinator must find another venue. */
  replacementRequired: "Replacement Required",
} as const;

export type BookingStatus = (typeof BOOKING_STATUS)[keyof typeof BOOKING_STATUS];
