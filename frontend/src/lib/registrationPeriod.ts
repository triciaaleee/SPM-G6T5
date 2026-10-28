import { eventEndsAt, eventStartsAt, localDateStart } from "./eventTiming";

/**
 * The registration period as the coordinator sees it. Mirrors events-service's
 * lib/registrationPeriod.ts, which is what actually decides: open from the open
 * date until 5 days before the event (or until it is full), unless the
 * coordinator forced it open or closed. It always stops when the event starts.
 * Capacity is checked by registration-service, so "full" isn't shown here.
 */

/** By default registration closes this long before the event starts (business rule). */
export const REGISTRATION_CUTOFF_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RegistrationOverride = "NONE" | "FORCE_OPEN" | "FORCE_CLOSED";
export type RegistrationState = "not_open_yet" | "open" | "closed";

export function registrationState(
  status: string,
  details: Record<string, unknown>,
  openDate: string | null | undefined,
  override: RegistrationOverride | null | undefined,
  now: Date = new Date(),
): RegistrationState {
  if (status === "Planning" || status === "Safety Review") return "not_open_yet";
  if (status !== "Confirmed") return "closed";

  const endsAt = eventEndsAt(details);
  if (endsAt === null || endsAt.getTime() <= now.getTime()) return "closed";
  if (override === "FORCE_CLOSED") return "closed";

  const startsAt = eventStartsAt(details);
  if (startsAt !== null && now.getTime() >= startsAt.getTime()) return "closed";
  if (override === "FORCE_OPEN") return "open";

  if (startsAt !== null && now.getTime() >= startsAt.getTime() - REGISTRATION_CUTOFF_DAYS * DAY_MS) return "closed";

  const opensAt = localDateStart(openDate);
  if (opensAt === null || now.getTime() < opensAt.getTime()) return "not_open_yet";
  return "open";
}

export const REGISTRATION_STATE_LABEL: Record<RegistrationState, string> = {
  not_open_yet: "Not open yet",
  open: "Open",
  closed: "Closed",
};

/** The moment registration closes by itself: the cutoff before the event starts, or null when the start can't be read. */
export function registrationClosesAt(details: Record<string, unknown> | null | undefined): Date | null {
  const startsAt = eventStartsAt(details);
  return startsAt === null ? null : new Date(startsAt.getTime() - REGISTRATION_CUTOFF_DAYS * DAY_MS);
}

export type RegistrationOverview = "not_open_yet" | "open" | "full" | "closed";

export const REGISTRATION_OVERVIEW_LABEL: Record<RegistrationOverview, string> = {
  not_open_yet: "Not open yet",
  open: "Open",
  full: "Full",
  closed: "Closed",
};

/**
 * What the organiser sees: the coordinator's state, plus "full" once the registered count reaches the expected
 * attendance. The registration-service owns that count and the backend decides; this only mirrors it for display.
 */
export function registrationOverview(
  status: string,
  details: Record<string, unknown>,
  openDate: string | null | undefined,
  override: RegistrationOverride | null | undefined,
  registeredCount: number,
  now: Date = new Date(),
): RegistrationOverview {
  const state = registrationState(status, details, openDate, override, now);
  if (state !== "open") return state;
  const capacity = Number(details.expectedAttendance);
  return capacity > 0 && registeredCount >= capacity ? "full" : "open";
}
