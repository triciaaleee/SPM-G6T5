/**
 * registrations.status — the Postgres enum `registration_status` (migrations
 * 0023, 0041). A registration is `Registered` while the attendee holds a
 * place and `Withdrawn` once they give it up themselves; the row is kept for
 * history and flips back to `Registered` if they sign up again. `Cancelled`
 * means the organiser cancelled the whole event (E3-6) — set only by the
 * event.cancelled handler, and final. Use these instead of string literals.
 */
export const REGISTRATION_STATUSES = ["Registered", "Withdrawn", "Cancelled"] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const REGISTRATION_STATUS = {
  registered: "Registered",
  withdrawn: "Withdrawn",
  cancelled: "Cancelled",
} as const satisfies Record<string, RegistrationStatus>;
