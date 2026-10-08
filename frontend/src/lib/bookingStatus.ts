/**
 * Venue booking statuses — the `venue_booking_status` Postgres enum (AGENTS.md
 * §3a). A booking request is approved or rejected, not the venue itself.
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

/**
 * Badge colour for a booking status, using the same four UI-state classes
 * as events (see lib/eventStatus.ts): the venue is secured (success), the
 * request is dead (error), something is pending a decision (warning), or
 * it needs the coordinator to act (info).
 */
export function bookingStatusBadgeClass(status: string): string {
  if (status === "Approved") return "status-success";
  if (status === "Rejected" || status === "Expired" || status === "Withdrawn") return "status-error";
  if (status === "Replacement Required") return "status-info";
  return "status-warning"; // Requested / On Hold
}

/**
 * Statuses must read exactly as §3a names them (AGENTS.md §4), so this is
 * identity — it exists so views never hand-roll a label and so a future
 * rename happens in one place.
 */
export function bookingStatusLabel(status: string): string {
  return status;
}

/** A booking nobody has finished deciding on, so it still counts for the event. */
export function isActiveBooking(status: string): boolean {
  return status === "Requested" || status === "On Hold" || status === "Approved";
}
