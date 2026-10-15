/**
 * When an event ends. An event's date and times are stored as local
 * wall-clock strings with no time zone (submitted_details.proposedDate
 * "YYYY-MM-DD", endTime "HH:MM"), so they're read as Singapore time
 * explicitly — not the server's own time zone, which is UTC on most hosts
 * and would make an event "end" eight hours late.
 */

/** Singapore has no daylight saving, so a fixed offset is exact. */
export const EVENT_UTC_OFFSET = "+08:00";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
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

/**
 * True once the event's end time has passed. An event whose end can't be
 * worked out is treated as not ended, so nothing that depends on it having
 * run (E3-5 completion) is allowed by mistake.
 */
export function hasEventEnded(details: Record<string, unknown>, now: Date = new Date()): boolean {
  const endsAt = eventEndsAt(details);
  return endsAt !== null && endsAt.getTime() <= now.getTime();
}
