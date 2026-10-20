import { EVENT_STATUS } from "./eventStatus.js";
import { eventEndsAt, eventStartsAt, localDateStart } from "./eventTiming.js";

/**
 * Registration period. The coordinator stores an open date and an optional
 * manual override (events.registration_override); the state is derived from
 * them on every read, so there is no stored status and no scheduler. Opening,
 * closing and reopening after a withdrawal all follow from the inputs.
 *
 * This service doesn't own the registered count (registration-service does),
 * so it decides everything except FULL: it returns OPEN, and registration-
 * service turns an OPEN event with no places left into FULL. That is the same
 * result as checking "full" in the order below.
 */

export const REGISTRATION_OVERRIDE = {
  None: "NONE",
  ForceOpen: "FORCE_OPEN",
  ForceClosed: "FORCE_CLOSED",
} as const;
export type RegistrationOverride = (typeof REGISTRATION_OVERRIDE)[keyof typeof REGISTRATION_OVERRIDE];

export const REGISTRATION_STATE = {
  NotOpen: "NOT_OPEN",
  Open: "OPEN",
  Full: "FULL",
  Closed: "CLOSED",
} as const;
export type RegistrationState = (typeof REGISTRATION_STATE)[keyof typeof REGISTRATION_STATE];

/** By default registration closes this long before the event starts (business rule). */
export const REGISTRATION_CUTOFF_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses in which the coordinator may still set the open date. */
export const REGISTRATION_DATE_EDITABLE_STATUSES: string[] = [
  EVENT_STATUS.Planning,
  EVENT_STATUS.SafetyReview,
  EVENT_STATUS.Confirmed,
];

export function parseOverride(value: unknown): RegistrationOverride {
  return value === REGISTRATION_OVERRIDE.ForceOpen || value === REGISTRATION_OVERRIDE.ForceClosed
    ? value
    : REGISTRATION_OVERRIDE.None;
}

/** The default cutoff: the moment 5 days before the event starts. */
export function registrationCutoff(details: Record<string, unknown>): Date | null {
  const startsAt = eventStartsAt(details);
  return startsAt === null ? null : new Date(startsAt.getTime() - REGISTRATION_CUTOFF_DAYS * DAY_MS);
}

interface RegistrationInputs {
  status: string;
  details: Record<string, unknown>;
  openDate: unknown;
  override: unknown;
}

/** Only a Confirmed event that asks for registration and hasn't ended takes part. */
function takesRegistration({ status, details }: RegistrationInputs, now: Date): boolean {
  if (status !== EVENT_STATUS.Confirmed || details.registrationNeeded !== true) return false;
  const endsAt = eventEndsAt(details);
  return endsAt !== null && endsAt.getTime() > now.getTime();
}

/**
 * Check order is the rule priority; don't reorder without updating the tests:
 *  1. FORCE_CLOSED always closes;
 *  2. the stop at the event start beats everything, FORCE_OPEN included;
 *  3. FORCE_OPEN opens (even before the open date and inside the 5-day window);
 *  4. otherwise the 5-day cutoff closes, then the open date, then OPEN.
 * `registeredCount` is optional: pass it (with the capacity) to also get FULL.
 */
export function getRegistrationState(
  inputs: RegistrationInputs,
  now: Date = new Date(),
  fullness?: { registeredCount: number; capacity: number | null },
): RegistrationState {
  if (inputs.details.registrationNeeded !== true) return REGISTRATION_STATE.Closed;
  if (!takesRegistration(inputs, now)) return REGISTRATION_STATE.Closed;

  const override = parseOverride(inputs.override);
  const full = fullness != null && fullness.capacity != null && fullness.registeredCount >= fullness.capacity;

  if (override === REGISTRATION_OVERRIDE.ForceClosed) return REGISTRATION_STATE.Closed;

  const startsAt = eventStartsAt(inputs.details);
  if (startsAt !== null && now.getTime() >= startsAt.getTime()) return REGISTRATION_STATE.Closed;

  if (override === REGISTRATION_OVERRIDE.ForceOpen) {
    return full ? REGISTRATION_STATE.Full : REGISTRATION_STATE.Open;
  }

  const cutoff = registrationCutoff(inputs.details);
  if (cutoff !== null && now.getTime() >= cutoff.getTime()) return REGISTRATION_STATE.Closed;

  const opensAt = localDateStart(inputs.openDate);
  if (opensAt === null || now.getTime() < opensAt.getTime()) return REGISTRATION_STATE.NotOpen;

  return full ? REGISTRATION_STATE.Full : REGISTRATION_STATE.Open;
}

/**
 * Whether attendees may see the event in the listing: registration has been
 * opened (the open date has arrived, or the coordinator forced it open) and the
 * event takes registration. Closed and full events stay listed. The listing
 * route filters with this; keep them the same.
 */
export function isListed(inputs: RegistrationInputs, now: Date = new Date()): boolean {
  if (!takesRegistration(inputs, now)) return false;
  const override = parseOverride(inputs.override);
  if (override === REGISTRATION_OVERRIDE.ForceOpen) return true;
  const opensAt = localDateStart(inputs.openDate);
  return opensAt !== null && now.getTime() >= opensAt.getTime();
}
