import type { AuthedRequest } from "../middleware/auth.js";
import { overlaps, type OccupiedWindow } from "./bookingConflicts.js";
import { isRealDate } from "./venueSearch.js";

/**
 * E4-3: periods when a venue can't be used. A period covers every day from
 * startDate to endDate inclusive — either the whole day (allDay) or the
 * same startTime–endTime window on each of those days.
 */

type Supabase = NonNullable<AuthedRequest["supabase"]>;

export interface PeriodInput {
  startDate: string;
  endDate: string;
  allDay: boolean;
  /** "HH:MM"; null when allDay. */
  startTime: string | null;
  endTime: string | null;
  reason: string;
}

/** A venue_unavailability row as stored. Postgres `time` reads back as "HH:MM:SS". */
export interface PeriodRow {
  id: number;
  venue_id: number;
  start_date: string;
  end_date: string;
  all_day: boolean;
  start_time: string | null;
  end_time: string | null;
  reason: string;
}

/** The API shape of a period. */
export interface Period {
  id: number;
  venueId: number;
  startDate: string;
  endDate: string;
  allDay: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string;
}

export const PERIOD_COLUMNS = "id, venue_id, start_date, end_date, all_day, start_time, end_time, reason";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A single period may span at most a year — longer than that is a retirement (E4-2), not a block-out. */
export const MAX_PERIOD_DAYS = 366;
export const MAX_REASON_LENGTH = 200;

function toHourMinute(time: string | null): string | null {
  return time === null ? null : time.slice(0, 5);
}

export function toPeriod(row: PeriodRow): Period {
  return {
    id: row.id,
    venueId: row.venue_id,
    startDate: row.start_date,
    endDate: row.end_date,
    allDay: row.all_day,
    startTime: row.all_day ? null : toHourMinute(row.start_time),
    endTime: row.all_day ? null : toHourMinute(row.end_time),
    reason: row.reason,
  };
}

export type PeriodParseResult = { valid: true; period: PeriodInput } | { valid: false; fields: Record<string, string> };

/** Validates a create/preview body. Every problem is reported at once, keyed by field. */
export function parsePeriodInput(body: unknown): PeriodParseResult {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const str = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");
  const fields: Record<string, string> = {};

  const startDate = str("startDate");
  const endDate = str("endDate") || startDate;
  const allDay = raw.allDay !== false;
  const startTime = str("startTime");
  const endTime = str("endTime");
  const reason = str("reason");

  if (!isRealDate(startDate)) fields.startDate = "Enter a valid start date.";
  if (!isRealDate(endDate)) fields.endDate = "Enter a valid end date.";
  if (!fields.startDate && !fields.endDate) {
    const days = (Date.parse(endDate) - Date.parse(startDate)) / DAY_MS;
    if (days < 0) fields.endDate = "The end date must not be before the start date.";
    else if (days >= MAX_PERIOD_DAYS) fields.endDate = `A block-out can cover at most ${MAX_PERIOD_DAYS} days.`;
  }

  if (!allDay) {
    if (!TIME_PATTERN.test(startTime)) fields.startTime = "Enter a start time.";
    if (!TIME_PATTERN.test(endTime)) fields.endTime = "Enter an end time.";
    if (!fields.startTime && !fields.endTime && endTime <= startTime) {
      fields.endTime = "The end time must be after the start time.";
    }
  }

  if (!reason) fields.reason = "Give a reason.";
  else if (reason.length > MAX_REASON_LENGTH) fields.reason = `Keep the reason under ${MAX_REASON_LENGTH} characters.`;

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return {
    valid: true,
    period: {
      startDate,
      endDate,
      allDay,
      startTime: allDay ? null : startTime,
      endTime: allDay ? null : endTime,
      reason,
    },
  };
}

/** A venue's setup and turnaround time, in minutes (venues.setup_minutes / turnaround_minutes). */
export interface VenueBuffers {
  setupMinutes: number;
  turnaroundMinutes: number;
}

export const NO_BUFFERS: VenueBuffers = { setupMinutes: 0, turnaroundMinutes: 0 };

export function toBuffers(row: { setup_minutes?: number | null; turnaround_minutes?: number | null }): VenueBuffers {
  return { setupMinutes: row.setup_minutes ?? 0, turnaroundMinutes: row.turnaround_minutes ?? 0 };
}

/** "HH:MM" moved by `minutes`, clamped to the same day ("00:00"–"24:00"). */
function shiftTime(time: string, minutes: number): string {
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  const total = Math.min(Math.max(h * 60 + m + minutes, 0), 24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The time a slot actually ties the venue up: setup before the start,
 * turnaround after the end. A 10:00–12:00 event with 30 min setup and 45 min
 * turnaround occupies 09:30–12:45. Slots with no times pass through as-is
 * (they're treated as the whole day anyway).
 */
export function occupiedWindow(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  buffers: VenueBuffers,
): { start: string | null; end: string | null } {
  if (!startTime || !endTime) return { start: null, end: null };
  return { start: shiftTime(startTime, -buffers.setupMinutes), end: shiftTime(endTime, buffers.turnaroundMinutes) };
}

/**
 * Whether a period blocks a slot on `date`. With no slot times (an
 * all-day search, or an event with no times recorded) any block that day
 * counts. Windows overlap when each starts before the other ends, so a
 * block ending at 13:00 doesn't clash with a slot starting at 13:00.
 */
export function periodBlocksSlot(
  period: Pick<Period, "startDate" | "endDate" | "allDay" | "startTime" | "endTime">,
  date: string,
  slotStart?: string | null,
  slotEnd?: string | null,
): boolean {
  if (date < period.startDate || date > period.endDate) return false;
  if (period.allDay || !period.startTime || !period.endTime) return true;
  if (!slotStart || !slotEnd) return true;
  const start = slotStart.slice(0, 5);
  const end = slotEnd.slice(0, 5);
  return period.startTime < end && period.endTime > start;
}

const MINUTE_MS = 60 * 1000;

/** "YYYY-MM-DD" of an epoch-ms instant, read as UTC like lib/bookingConflicts. */
function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function minutesOf(time: string): number {
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

/**
 * Whether `period` blocks any part of an occupied window (setup and
 * turnaround already included). A partial overlap counts (§3a change 2).
 * The window is walked day by day because padding can carry it past
 * midnight, and a timed period repeats the same hours on each of its days.
 */
export function periodOverlapsWindow(
  period: Pick<Period, "startDate" | "endDate" | "allDay" | "startTime" | "endTime">,
  window: OccupiedWindow,
): boolean {
  const firstDay = Math.floor(window.startMs / DAY_MS) * DAY_MS;
  for (let day = firstDay; day < window.endMs; day += DAY_MS) {
    const date = dateOf(day);
    if (date < period.startDate || date > period.endDate) continue;
    const block =
      period.allDay || !period.startTime || !period.endTime
        ? { startMs: day, endMs: day + DAY_MS }
        : {
            startMs: day + minutesOf(period.startTime) * MINUTE_MS,
            endMs: day + minutesOf(period.endTime) * MINUTE_MS,
          };
    if (overlaps(block, window)) return true;
  }
  return false;
}

/**
 * AC3 / E4-16: ids of venues blocked out for a search slot. `windows` holds
 * each venue's requested window, already widened by that venue's own
 * setup/turnaround (lib/bookingConflicts occupiedWindow) — an event can't
 * start at 20:00 in a venue blocked until 20:00 if it needs 30 minutes to
 * set up. Padding can carry a window into the day before or after, so
 * block-outs on those days are checked too. Resolves to null when the
 * lookup fails, so the caller can fail the search rather than show a venue
 * that may well be unavailable.
 */
export async function findBlockedVenueIds(
  supabase: Supabase,
  windows: Map<number, OccupiedWindow>,
): Promise<Set<number> | null> {
  if (windows.size === 0) return new Set();
  const all = [...windows.values()];
  const { data, error } = await supabase
    .from("venue_unavailability")
    .select(PERIOD_COLUMNS)
    .lte("start_date", dateOf(Math.max(...all.map((w) => w.endMs)) - 1))
    .gte("end_date", dateOf(Math.min(...all.map((w) => w.startMs))));
  if (error) return null;

  const blocked = new Set<number>();
  for (const row of (data ?? []) as PeriodRow[]) {
    const window = windows.get(row.venue_id);
    if (window && periodOverlapsWindow(toPeriod(row), window)) blocked.add(row.venue_id);
  }
  return blocked;
}

/**
 * The first unavailability period at `venueId` that cuts across `window`,
 * or null when the venue is free of block-outs for it. Used wherever a
 * booking would start holding the venue — a new request (E4-8) or a hold
 * or approval (E4-10) — so a blocked venue can't be promised.
 */
export async function findClashingPeriod(
  supabase: Supabase,
  venueId: number,
  window: OccupiedWindow,
): Promise<{ status: "ok"; period: Period | null } | { status: "error" }> {
  const { data, error } = await supabase
    .from("venue_unavailability")
    .select(PERIOD_COLUMNS)
    .eq("venue_id", venueId)
    .lte("start_date", dateOf(window.endMs - 1))
    .gte("end_date", dateOf(window.startMs));
  if (error) return { status: "error" };

  const clash = ((data ?? []) as PeriodRow[]).map(toPeriod).find((period) => periodOverlapsWindow(period, window));
  return { status: "ok", period: clash ?? null };
}

/** "on 2026-11-10 (12:30–17:00)" / "from 2026-11-10 to 2026-11-12 (all day)" — for error messages. */
export function describePeriod(period: Period): string {
  const days = period.startDate === period.endDate ? `on ${period.startDate}` : `from ${period.startDate} to ${period.endDate}`;
  const hours = period.allDay ? "all day" : `${period.startTime}–${period.endTime}`;
  return `${days} (${hours})`;
}
