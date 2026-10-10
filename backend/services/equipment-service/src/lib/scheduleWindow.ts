/**
 * Occupied-window maths for the E5-4 availability check — adapted from
 * venue-service's lib/bookingConflicts.ts (duplicated per AGENTS.md §1:
 * no shared code imports between services), with the padding concept
 * dropped entirely: transit time between venues is explicitly not
 * modelled for equipment (customer confirmed "none", per the issue) —
 * unlike a venue booking, an equipment booking's window is exactly its
 * event's own start and end, nothing added either side.
 *
 * Windows are epoch milliseconds rather than the "HH:MM" strings events
 * use, because an event with no times recorded occupies its whole day,
 * and only a numeric comparison expresses that consistently. The dates
 * and times are local wall-clock values with no timezone recorded, so
 * they are read as UTC: both sides of every comparison are built the same
 * way, and only the difference between them matters.
 */

export interface WindowSchedule {
  proposedDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}

export interface OccupiedWindow {
  startMs: number;
  endMs: number;
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

function dateStartMs(date: string): number | null {
  const match = DATE_PATTERN.exec(date);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function minutesIntoDay(time: string): number | null {
  const match = TIME_PATTERN.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The window `schedule` occupies, or null when there is no usable date.
 * An event with no times recorded occupies its whole day — the same
 * fallback venue search uses, since there's no way to know which part of
 * the day it needs.
 */
export function occupiedWindow(schedule: WindowSchedule): OccupiedWindow | null {
  if (!schedule.proposedDate) return null;
  const dayStart = dateStartMs(schedule.proposedDate);
  if (dayStart === null) return null;

  const start = schedule.startTime ? minutesIntoDay(schedule.startTime) : null;
  const end = schedule.endTime ? minutesIntoDay(schedule.endTime) : null;
  if (start === null || end === null || end <= start) {
    return { startMs: dayStart, endMs: dayStart + DAY_MS };
  }

  return { startMs: dayStart + start * MINUTE_MS, endMs: dayStart + end * MINUTE_MS };
}

/** Half-open overlap: each window starts before the other ends. */
export function overlaps(a: OccupiedWindow, b: OccupiedWindow): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}
