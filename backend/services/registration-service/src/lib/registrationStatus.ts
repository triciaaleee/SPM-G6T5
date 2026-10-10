/**
 * registrations.status — the Postgres enum `registration_status` (migration
 * 0023). A registration is `Registered` while the attendee holds a place and
 * `Withdrawn` once they give it up; the row is kept for history and flips
 * back to `Registered` if they sign up again. Use these instead of string
 * literals.
 */
export const REGISTRATION_STATUSES = ["Registered", "Withdrawn"] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_STATUS = {
  registered: "Registered",
  withdrawn: "Withdrawn",
} as const satisfies Record<string, RegistrationStatus>;
