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
