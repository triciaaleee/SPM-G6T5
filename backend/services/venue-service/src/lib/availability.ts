import { occupiedWindow, type Period, type VenueBuffers } from "./unavailability.js";

/**
 * Venue availability calendar: when a coordinator could realistically
 * request one venue. Pure functions only — routes/venues.ts loads the
 * rows and hands them here.
 *
 * Times are local "HH:MM" strings on the event's own date (the same shape
 * events store proposedDate/startTime/endTime in), with "24:00" meaning
 * midnight at the end of the day. Nothing here crosses midnight: setup and
 * turnaround are clamped to the event's day, as in lib/unavailability.ts.
 */

const DAY_START = "00:00";
const DAY_END = "24:00";

/** A venue's daily opening and closing time. */
export interface OperatingHours {
  openingTime: string;
  closingTime: string;
}

/** Open all day — used when a venue has no hours recorded. */
export const ALWAYS_OPEN: OperatingHours = { openingTime: DAY_START, closingTime: DAY_END };

/** Postgres `time` reads back as "HH:MM:SS"; missing columns fall back to all day. */
export function toOperatingHours(row: { opening_time?: string | null; closing_time?: string | null }): OperatingHours {
  return {
    openingTime: row.opening_time ? row.opening_time.slice(0, 5) : DAY_START,
    closingTime: row.closing_time ? row.closing_time.slice(0, 5) : DAY_END,
  };
}

/** A booking that blocks the venue on the calendar (Approved, or an unexpired On Hold). */
export interface CalendarBooking {
  date: string;
  /** The event's advertised times; null when the event has none recorded. */
  startTime: string | null;
  endTime: string | null;
}

export interface Interval {
  start: string;
  end: string;
}

/**
 * The window a booking ties the venue up: its advertised times padded by
 * the venue's setup and turnaround (AC6). An event with no times recorded
 * occupies its whole day.
 */
export function bookingWindow(booking: CalendarBooking, buffers: VenueBuffers): Interval {
  const occupied = occupiedWindow(booking.startTime, booking.endTime, buffers);
  return { start: occupied.start ?? DAY_START, end: occupied.end ?? DAY_END };
}

/** The hours a block-out period covers on `date`, or null if it doesn't cover that day. */
export function periodWindow(
  period: Pick<Period, "startDate" | "endDate" | "allDay" | "startTime" | "endTime">,
  date: string,
): Interval | null {
  if (date < period.startDate || date > period.endDate) return null;
  if (period.allDay || !period.startTime || !period.endTime) return { start: DAY_START, end: DAY_END };
  return { start: period.startTime, end: period.endTime };
}

export function toMinutes(time: string): number {
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

export function fromMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The parts of `window` not covered by any of `blocked`, earliest first.
 * Windows touching end-to-start don't overlap (a block ending 13:00 leaves
 * 13:00 onwards free), matching periodBlocksSlot.
 */
export function subtractIntervals(window: Interval, blocked: Interval[]): Interval[] {
  let cursor = toMinutes(window.start);
  const end = toMinutes(window.end);
  const sorted = blocked
    .map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) }))
    .filter((b) => b.end > cursor && b.start < end)
    .sort((a, b) => a.start - b.start);

  const free: Interval[] = [];
  for (const block of sorted) {
    if (block.start > cursor) free.push({ start: fromMinutes(cursor), end: fromMinutes(block.start) });
    cursor = Math.max(cursor, block.end);
    if (cursor >= end) break;
  }
  if (cursor < end) free.push({ start: fromMinutes(cursor), end: fromMinutes(end) });
  return free;
}

/** What the coordinator is looking for (AC5): days from..to, optionally only between two times. */
export interface AvailabilityTarget {
  fromDate: string;
  toDate: string;
  startTime: string | null;
  endTime: string | null;
}

/**
 * A stretch of a target day when the venue is free. `start`/`end` is the
 * free time inside the target window (what the calendar highlights);
 * `eventStart`/`eventEnd` is the event that fits in it once the venue's
 * setup and turnaround are left room for. A gap too short to fit any event
 * after setup and turnaround isn't a realistic slot, so it isn't returned.
 */
export interface FreeSlot extends Interval {
  date: string;
  eventStart: string;
  eventEnd: string;
}

export interface DayInput {
  date: string;
  bookings: CalendarBooking[];
  periods: Pick<Period, "startDate" | "endDate" | "allDay" | "startTime" | "endTime">[];
}

/**
 * AC5: free slots on one day within the target times. The venue is free
 * inside its operating hours wherever no booking's padded window and no
 * block-out period falls. An event needs setup before it and turnaround
 * after it inside that free stretch, so the event that fits starts `setup`
 * later and ends `turnaround` earlier than the stretch.
 */
export function freeSlotsForDay(
  day: DayInput,
  hours: OperatingHours,
  buffers: VenueBuffers,
  target: Pick<AvailabilityTarget, "startTime" | "endTime">,
): FreeSlot[] {
  const blocked: Interval[] = [
    ...day.bookings.filter((b) => b.date === day.date).map((b) => bookingWindow(b, buffers)),
    ...day.periods.flatMap((p) => periodWindow(p, day.date) ?? []),
  ];
  const open = toMinutes(hours.openingTime);
  const close = toMinutes(hours.closingTime);
  const targetStart = Math.max(open, target.startTime ? toMinutes(target.startTime) : open);
  const targetEnd = Math.min(close, target.endTime ? toMinutes(target.endTime) : close);
  if (targetEnd <= targetStart) return [];

  const slots: FreeSlot[] = [];
  for (const gap of subtractIntervals({ start: hours.openingTime, end: hours.closingTime }, blocked)) {
    const gapStart = toMinutes(gap.start);
    const gapEnd = toMinutes(gap.end);
    const shownStart = Math.max(gapStart, targetStart);
    const shownEnd = Math.min(gapEnd, targetEnd);
    if (shownEnd <= shownStart) continue;

    const eventStart = Math.max(gapStart + buffers.setupMinutes, targetStart);
    const eventEnd = Math.min(gapEnd - buffers.turnaroundMinutes, targetEnd);
    if (eventEnd <= eventStart) continue;

    slots.push({
      date: day.date,
      start: fromMinutes(shownStart),
      end: fromMinutes(shownEnd),
      eventStart: fromMinutes(eventStart),
      eventEnd: fromMinutes(eventEnd),
    });
  }
  return slots;
}

/** Every local date from `from` to `to`, inclusive. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const [y, m, d] = from.split("-").map(Number);
  for (const day = new Date(Date.UTC(y, m - 1, d)); ; day.setUTCDate(day.getUTCDate() + 1)) {
    const key = day.toISOString().slice(0, 10);
    if (key > to) break;
    dates.push(key);
  }
  return dates;
}

/** AC5: free slots on every target day that falls inside the loaded range. */
export function findFreeSlots(
  range: { from: string; to: string },
  target: AvailabilityTarget,
  bookings: CalendarBooking[],
  periods: DayInput["periods"],
  hours: OperatingHours,
  buffers: VenueBuffers,
): FreeSlot[] {
  const from = target.fromDate > range.from ? target.fromDate : range.from;
  const to = target.toDate < range.to ? target.toDate : range.to;
  if (to < from) return [];
  return datesBetween(from, to).flatMap((date) =>
    freeSlotsForDay({ date, bookings, periods }, hours, buffers, target),
  );
}
