/**
 * When an event ends. An event's date and times are stored as local
 * wall-clock strings with no time zone (submitted_details.proposedDate
 * "YYYY-MM-DD", endTime "HH:MM"), so they're read as Singapore time
 * explicitly — not the server's own time zone, which is UTC on most hosts
 * and would make an event "end" eight hours late.
 */

import { clock } from "./clock.js";

/** Singapore has no daylight saving, so a fixed offset is exact. */
export const EVENT_UTC_OFFSET = "+08:00";

// The patterns are anchored on purpose: without "^" a signed extended year such as "+092026-11-10" gets
// through and Date reads it as the year 92026 (tested in libEdges.test.ts).
//
// Mutation testing: dropping the trailing "$" (date) or either anchor (time) changes nothing observable.
// The value is spliced into `${date}T${time}:00+08:00` and handed to Date, which rejects any stray character,
// so a string those mutants would admit still comes back null. Fuzzed with 4 million prefixed/suffixed values
// without finding a difference. Stryker can only skip a mutator as a whole, hence the two disables.
// Stryker disable next-line Regex: the "^" case is covered by a dedicated test; "$" is equivalent (see above)
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Stryker disable next-line Regex: equivalent mutants only (see above)
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Used when an event has a date but no end time: it runs to the end of that day. */
const END_OF_DAY = "23:59";

/**
 * The moment the event ends, or null when it has no valid date (or an
 * unreadable end time). Events end on the day they start — validation
 * requires endTime after startTime — so proposedDate + endTime is the end.
 */
export function eventEndsAt(details: Record<string, unknown>): Date | null {
  const date = details.proposedDate;
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) return null;

  const endTime = details.endTime === undefined || details.endTime === null ? END_OF_DAY : details.endTime;
  if (typeof endTime !== "string" || !TIME_PATTERN.test(endTime)) return null;

  const endsAt = new Date(`${date}T${endTime}:00${EVENT_UTC_OFFSET}`);
  return Number.isNaN(endsAt.getTime()) ? null : endsAt;
}

/** Used when an event has a date but no start time: it starts at the beginning of that day. */
const START_OF_DAY = "00:00";

/**
 * The moment the event starts, or null when it has no valid date (or an
 * unreadable start time). Mirrors eventEndsAt.
 */
export function eventStartsAt(details: Record<string, unknown>): Date | null {
  const date = details.proposedDate;
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) return null;

  const startTime = details.startTime === undefined || details.startTime === null ? START_OF_DAY : details.startTime;
  if (typeof startTime !== "string" || !TIME_PATTERN.test(startTime)) return null;

  const startsAt = new Date(`${date}T${startTime}:00${EVENT_UTC_OFFSET}`);
  return Number.isNaN(startsAt.getTime()) ? null : startsAt;
}

/**
 * True once the event has started (Singapore time). An event whose start
 * can't be worked out is treated as not started. E6-4: attendees may
 * withdraw any time before this.
 */
export function hasEventStarted(details: Record<string, unknown>, now: Date = clock.now()): boolean {
  const startsAt = eventStartsAt(details);
  return startsAt !== null && startsAt.getTime() <= now.getTime();
}

/** The start of a local (Singapore) calendar day, or null for a malformed date. */
export function localDateStart(date: unknown): Date | null {
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) return null;
  const start = new Date(`${date}T00:00:00${EVENT_UTC_OFFSET}`);
  return Number.isNaN(start.getTime()) ? null : start;
}

/**
 * True once the event's end time has passed. An event whose end can't be
 * worked out is treated as not ended, so nothing that depends on it having
 * run (E3-5 completion) is allowed by mistake.
 */
export function hasEventEnded(details: Record<string, unknown>, now: Date = clock.now()): boolean {
  const endsAt = eventEndsAt(details);
  return endsAt !== null && endsAt.getTime() <= now.getTime();
}
