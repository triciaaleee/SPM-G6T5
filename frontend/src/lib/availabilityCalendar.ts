import type { UnavailabilityPeriod } from "./unavailabilityApi";
import type { AvailabilityBooking, FreeSlot, VenueAvailability } from "./venuesApi";

/**
 * Date and layout helpers for the coordinator's venue availability
 * calendar. Dates are local "YYYY-MM-DD" keys built from date parts (never
 * toISOString(), which shifts a day in UTC+ timezones); times are "HH:MM",
 * with "24:00" for midnight at the end of a day.
 */

export type CalendarView = "month" | "week";

export function toKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

export function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return toKey(fromKey(value)) === value;
}

export function addDays(key: string, days: number): string {
  const date = fromKey(key);
  date.setDate(date.getDate() + days);
  return toKey(date);
}

/** Weeks start on Monday. */
export function startOfWeek(key: string): string {
  const date = fromKey(key);
  return addDays(key, -((date.getDay() + 6) % 7));
}

/** The seven days of the week containing `key`, Monday first. */
export function weekDays(key: string): string[] {
  const monday = startOfWeek(key);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Every day the month grid shows: whole weeks from the one holding the 1st to the one holding the last day. */
export function monthGridDays(key: string): string[] {
  const date = fromKey(key);
  const first = toKey(new Date(date.getFullYear(), date.getMonth(), 1));
  const last = toKey(new Date(date.getFullYear(), date.getMonth() + 1, 0));
  const days: string[] = [];
  for (let day = startOfWeek(first); day <= last || days.length % 7 !== 0; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The dates a view needs loaded (always ≤ 42 days, the API's limit). */
export function visibleRange(view: CalendarView, focus: string): { from: string; to: string } {
  const days = view === "month" ? monthGridDays(focus) : weekDays(focus);
  return { from: days[0], to: days[days.length - 1] };
}

/** The date one step back or forward: a month in month view, a week in week view. */
export function shiftFocus(view: CalendarView, focus: string, step: -1 | 1): string {
  if (view === "week") return addDays(focus, 7 * step);
  const date = fromKey(focus);
  return toKey(new Date(date.getFullYear(), date.getMonth() + step, 1));
}

export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

export function toMinutes(time: string): number {
  const [h, m] = time.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

export const MINUTES_PER_DAY = 24 * 60;

/** The kinds of time on the calendar, each with its own Style.md 3.5 treatment. */
export type BlockKind = "approved" | "on-hold" | "blocked" | "closed" | "free";

export interface DayBlock {
  kind: BlockKind;
  key: string;
  /** Minutes from midnight. */
  start: number;
  end: number;
  label: string;
  /** Bookings only: the advertised event time inside the padded window. */
  core?: { start: number; end: number };
  booking?: AvailabilityBooking;
  period?: UnavailabilityPeriod;
  slot?: FreeSlot;
  /** Side-by-side position when bookings overlap: lane index of `lanes`. */
  lane: number;
  lanes: number;
}

function periodCovers(period: UnavailabilityPeriod, date: string): boolean {
  return period.startDate <= date && period.endDate >= date;
}

export function periodRange(period: UnavailabilityPeriod): { start: number; end: number } {
  if (period.allDay || !period.startTime || !period.endTime) return { start: 0, end: MINUTES_PER_DAY };
  return { start: toMinutes(period.startTime), end: toMinutes(period.endTime) };
}

export function bookingLabel(booking: AvailabilityBooking): string {
  return booking.event.name || `Event #${booking.event.id}`;
}

/** Gives overlapping blocks side-by-side lanes so none hides another. */
function assignLanes(blocks: DayBlock[]): void {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster: DayBlock[] = [];
  let clusterEnd = -1;
  const laneEnds: number[] = [];

  const closeCluster = () => {
    const lanes = Math.max(1, ...cluster.map((b) => b.lane + 1));
    for (const block of cluster) block.lanes = lanes;
    cluster = [];
    laneEnds.length = 0;
  };

  for (const block of sorted) {
    if (block.start >= clusterEnd && cluster.length > 0) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= block.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = block.end;
    block.lane = lane;
    cluster.push(block);
    clusterEnd = Math.max(clusterEnd, block.end);
  }
  if (cluster.length > 0) closeCluster();
}

/**
 * Everything on one day, as positioned blocks: hours outside operating
 * hours (closed), block-out periods, free target slots, and bookings over
 * their padded window. Background kinds span the full column; bookings
 * share lanes when they overlap.
 */
export function blocksForDay(data: VenueAvailability, date: string): DayBlock[] {
  const blocks: DayBlock[] = [];
  const open = toMinutes(data.venue.openingTime);
  const close = toMinutes(data.venue.closingTime);
  const base = { lane: 0, lanes: 1 };

  if (open > 0) blocks.push({ ...base, kind: "closed", key: "closed-am", start: 0, end: open, label: "Closed" });
  if (close < MINUTES_PER_DAY) {
    blocks.push({ ...base, kind: "closed", key: "closed-pm", start: close, end: MINUTES_PER_DAY, label: "Closed" });
  }

  for (const period of data.unavailability) {
    if (!periodCovers(period, date)) continue;
    blocks.push({ ...base, kind: "blocked", key: `period-${period.id}`, ...periodRange(period), label: period.reason, period });
  }

  for (const slot of data.freeSlots) {
    if (slot.date !== date) continue;
    blocks.push({
      ...base,
      kind: "free",
      key: `free-${slot.start}`,
      start: toMinutes(slot.start),
      end: toMinutes(slot.end),
      label: "Available",
      slot,
    });
  }

  const bookings: DayBlock[] = data.bookings
    .filter((b) => b.date === date)
    .map((booking) => ({
      ...base,
      kind: booking.status === "On Hold" ? "on-hold" : "approved",
      key: `booking-${booking.id}`,
      start: toMinutes(booking.occupiedStart),
      end: toMinutes(booking.occupiedEnd),
      core:
        booking.startTime && booking.endTime
          ? { start: toMinutes(booking.startTime), end: toMinutes(booking.endTime) }
          : undefined,
      label: bookingLabel(booking),
      booking,
    }));
  assignLanes(bookings);

  return [...blocks, ...bookings];
}

/** Whether a period blocks the venue for the whole of `date`. */
export function isBlockedAllDay(data: VenueAvailability, date: string): boolean {
  return data.unavailability.some((p) => periodCovers(p, date) && periodRange(p).start === 0 && periodRange(p).end === MINUTES_PER_DAY);
}

export function isInTarget(data: VenueAvailability, date: string): boolean {
  return data.target !== null && date >= data.target.fromDate && date <= data.target.toDate;
}
