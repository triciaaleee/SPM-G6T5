/**
 * registrations.status — the same values as the backend's
 * `registration_status` enum (migrations 0023, 0041). `Withdrawn`: the
 * attendee gave up their place. `Cancelled`: the organiser cancelled the
 * whole event. Use these instead of string literals.
 */
export const REGISTRATION_STATUSES = ["Registered", "Withdrawn", "Cancelled"] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** Badge colour class for a registration status (defined with the badge styles in the view). */
export function registrationBadgeClass(status: RegistrationStatus): string {
  if (status === "Registered") return "status-success";
  // Same red as the event's own Cancelled badge (lib/eventStatus.ts).
  if (status === "Cancelled") return "status-error";
  return "status-warning";
}

/** What an attendee is told about an event's registration period (decided by the backend). */
export type RegistrationStateValue = "NOT_OPEN" | "OPEN" | "FULL" | "CLOSED";

/** Card badge for an event the attendee hasn't registered for: label and colour class. */
export function registrationStateBadge(state: RegistrationStateValue | undefined): { label: string; className: string } {
  if (state === "FULL") return { label: "Full", className: "status-warning" };
  if (state === "CLOSED") return { label: "Registration closed", className: "status-warning" };
  return { label: "Open", className: "status-open" };
}
