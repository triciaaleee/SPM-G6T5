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
