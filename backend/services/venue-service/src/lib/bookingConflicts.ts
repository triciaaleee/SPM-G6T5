/**
 * Occupied-window maths shared by venue search, recommendations and
 * booking submission, so all three agree on what "free" means.
 *
 * A booking's own window is its event's date and times (venue_bookings
 * stores no timing), widened by the venue's setup and turnaround times:
 * occupied window = event start − setup_minutes … event end + turnaround_minutes
 * (AGENTS.md §3a, Week 7 change 1). A 10:00–12:00 event at a venue with 30
 * min setup and 45 min turnaround occupies 09:30–12:45.
 *
 * Windows are epoch milliseconds rather than the "HH:MM" strings the rest
 * of the schedule uses, because padding can push a window past midnight
 * into the previous or next day, which string comparison cannot express.
 * The dates and times are local wall-clock values with no timezone
 * recorded, so they are read as UTC: both sides of every comparison are
 * built the same way, and only the difference between them matters.
 */

/** The schedule half of a window — the shape events-service returns. */
export interface WindowSchedule {
  proposedDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}

/** The venue half — how much to pad by. */
export interface WindowPadding {
  setup_minutes?: number | null;
  turnaround_minutes?: number | null;
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
 * The window `schedule` occupies at a venue with `padding`, or null when
 * there is no usable date. An event with no times recorded occupies its
 * whole day — the same fallback venue search has always used, since
 * there's no way to know which part of the day it needs.
 */
export function occupiedWindow(schedule: WindowSchedule, padding: WindowPadding = {}): OccupiedWindow | null {
  if (!schedule.proposedDate) return null;
  const dayStart = dateStartMs(schedule.proposedDate);
  if (dayStart === null) return null;

  const setup = Math.max(0, padding.setup_minutes ?? 0) * MINUTE_MS;
  const turnaround = Math.max(0, padding.turnaround_minutes ?? 0) * MINUTE_MS;

  const start = schedule.startTime ? minutesIntoDay(schedule.startTime) : null;
  const end = schedule.endTime ? minutesIntoDay(schedule.endTime) : null;
  if (start === null || end === null || end <= start) {
    return { startMs: dayStart - setup, endMs: dayStart + DAY_MS + turnaround };
  }

  return {
    startMs: dayStart + start * MINUTE_MS - setup,
    endMs: dayStart + end * MINUTE_MS + turnaround,
  };
}

/** Half-open overlap: each window starts before the other ends. */
export function overlaps(a: OccupiedWindow, b: OccupiedWindow): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function stamp(ms: number): { date: string; time: string } {
  const at = new Date(ms);
  return {
    date: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`,
    time: `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`,
  };
}

/**
 * The window as the coordinator sees it in a conflict message (E4-8 AC6,
 * E4-11): "2026-09-14 09:30–12:45", or with both dates spelled out when
 * padding has pushed it across midnight.
 */
export function formatWindow(window: OccupiedWindow): string {
  const from = stamp(window.startMs);
  const to = stamp(window.endMs);
  return from.date === to.date
    ? `${from.date} ${from.time}–${to.time}`
    : `${from.date} ${from.time} – ${to.date} ${to.time}`;
}
