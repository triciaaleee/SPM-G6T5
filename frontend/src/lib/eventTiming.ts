/**
 * When an event ends — mirrors events-service's lib/eventTiming.ts, which
 * is what actually decides (E3-5). Event dates and times are stored as
 * wall-clock strings with no time zone, so they're read as Singapore time
 * explicitly rather than the browser's own time zone.
 */

/** Singapore has no daylight saving, so a fixed offset is exact. */
const EVENT_UTC_OFFSET = "+08:00";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Used when an event has a date but no end time: it runs to the end of that day. */
const END_OF_DAY = "23:59";

/** The moment the event ends, or null when its date or end time can't be read. */
export function eventEndsAt(details: Record<string, unknown> | null | undefined): Date | null {
  const date = details?.proposedDate;
  if (typeof date !== "string" || !DATE_PATTERN.test(date)) return null;

  const endTime = details?.endTime === undefined || details?.endTime === null ? END_OF_DAY : details.endTime;
  if (typeof endTime !== "string" || !TIME_PATTERN.test(endTime)) return null;

  const endsAt = new Date(`${date}T${endTime}:00${EVENT_UTC_OFFSET}`);
  return Number.isNaN(endsAt.getTime()) ? null : endsAt;
}

/** True once the event's end time has passed; false when it can't be worked out. */
export function hasEventEnded(details: Record<string, unknown> | null | undefined, now: Date = new Date()): boolean {
  const endsAt = eventEndsAt(details);
  return endsAt !== null && endsAt.getTime() <= now.getTime();
}
