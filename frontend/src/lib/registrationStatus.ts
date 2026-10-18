/**
 * registrations.status — the same two values as the backend's
 * `registration_status` enum (migration 0023). Use these instead of string
 * literals.
 */
export const REGISTRATION_STATUSES = ["Registered", "Withdrawn"] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** Badge colour class for a registration status (defined with the badge styles in the view). */
export function registrationBadgeClass(status: RegistrationStatus): string {
  return status === "Registered" ? "status-success" : "status-warning";
}

/** What an attendee is told about an event's registration period (decided by the backend). */
export type RegistrationStateValue = "NOT_OPEN" | "OPEN" | "FULL" | "CLOSED";

/** Card badge for an event the attendee hasn't registered for: label and colour class. */
export function registrationStateBadge(state: RegistrationStateValue | undefined): { label: string; className: string } {
  if (state === "FULL") return { label: "Full", className: "status-warning" };
  if (state === "CLOSED") return { label: "Registration closed", className: "status-warning" };
  return { label: "Open", className: "status-open" };
}
