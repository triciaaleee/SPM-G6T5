import type { VenueBooking } from "./venuesApi";
import type { UnavailabilityPeriod } from "./unavailabilityApi";

/**
 * E1-5: the venue staff's combined calendar. Pure helpers — date maths,
 * turning bookings and block-outs into calendar entries, and laying out
 * entries that overlap in time — so the view stays thin and this is testable.
 */

export type CalendarView = "day" | "week" | "month";

/** Venues viewable at once; the view's dropdown enforces it. */
export const MAX_VENUES = 4;

/** Booking statuses that appear on the calendar (live ones only). */
export const SHOWN_STATUSES: VenueBooking["status"][] = ["Requested", "On Hold", "Approved", "Replacement Required"];

export interface CalendarEntry {
  id: string;
  kind: "booking" | "block";
  venueId: number;
  /** Local "YYYY-MM-DD". */
  date: string;
  /** Minutes from midnight; null for all-day or untimed entries. */
  startMin: number | null;
  endMin: number | null;
  title: string;
  status?: VenueBooking["status"];
  attendance?: number | null;
  /** "HH:MM" strings, for display. */
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
}

export function toKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

export function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key: string, days: number): string {
  const date = fromKey(key);
  date.setDate(date.getDate() + days);
  return toKey(date);
}

/** Monday of the week containing `key`. */
export function startOfWeek(key: string): string {
  const date = fromKey(key);
  return addDays(key, -((date.getDay() + 6) % 7));
}

export function toMinutes(time: string | null): number | null {
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return null;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

export interface VisibleRange {
  from: string;
  to: string;
  /** Every day shown, in order (month: whole weeks, so leading/trailing days). */
  days: string[];
}

export function visibleRange(view: CalendarView, anchor: string): VisibleRange {
  let from = anchor;
  let to = anchor;
  if (view === "week") {
    from = startOfWeek(anchor);
    to = addDays(from, 6);
  } else if (view === "month") {
    const date = fromKey(anchor);
    from = startOfWeek(toKey(new Date(date.getFullYear(), date.getMonth(), 1)));
    to = addDays(startOfWeek(toKey(new Date(date.getFullYear(), date.getMonth() + 1, 0))), 6);
  }
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return { from, to, days };
}

/** Move the anchor one step: a day, a week or a month. */
export function shiftAnchor(view: CalendarView, anchor: string, direction: 1 | -1): string {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, 7 * direction);
  const date = fromKey(anchor);
  return toKey(new Date(date.getFullYear(), date.getMonth() + direction, 1));
}

export function bookingEntries(venueId: number, bookings: VenueBooking[]): CalendarEntry[] {
  return bookings
    .filter((b) => SHOWN_STATUSES.includes(b.status))
    .map((b) => {
      const startMin = toMinutes(b.startTime);
      const endMin = toMinutes(b.endTime);
      const timed = startMin !== null && endMin !== null && endMin > startMin;
      return {
        id: `booking-${b.id}`,
        kind: "booking",
        venueId,
        date: b.date,
        startMin: timed ? startMin : null,
        endMin: timed ? endMin : null,
        title: b.event.name || "Untitled event",
        status: b.status,
        attendance: b.event.expectedAttendance,
        startTime: b.startTime,
        endTime: b.endTime,
        allDay: !timed,
      } satisfies CalendarEntry;
    });
}

/** One entry per day a block-out covers inside [from, to]. */
export function blockEntries(periods: UnavailabilityPeriod[], from: string, to: string): CalendarEntry[] {
  const entries: CalendarEntry[] = [];
  for (const period of periods) {
    const first = period.startDate > from ? period.startDate : from;
    const last = period.endDate < to ? period.endDate : to;
    for (let day = first; day <= last; day = addDays(day, 1)) {
      entries.push({
        id: `block-${period.id}-${day}`,
        kind: "block",
        venueId: period.venueId,
        date: day,
        startMin: period.allDay ? null : toMinutes(period.startTime),
        endMin: period.allDay ? null : toMinutes(period.endTime),
        title: period.reason,
        startTime: period.allDay ? null : period.startTime,
        endTime: period.allDay ? null : period.endTime,
        allDay: period.allDay,
      });
    }
  }
  return entries;
}

export interface Lane {
  lane: number;
  lanes: number;
}

/**
 * Side-by-side layout for timed entries that overlap: each cluster of
 * mutually-chained overlaps shares its width equally, one lane per entry
 * that can't sit above an earlier one. Returned in the input's order.
 */
export function layoutLanes(items: { startMin: number; endMin: number }[]): Lane[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a].startMin - items[b].startMin || items[b].endMin - items[a].endMin);
  const result: Lane[] = items.map(() => ({ lane: 0, lanes: 1 }));
  let cluster: number[] = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];

  const closeCluster = () => {
    for (const i of cluster) result[i].lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };

  for (const i of order) {
    if (cluster.length > 0 && items[i].startMin >= clusterEnd) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= items[i].startMin);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = items[i].endMin;
    result[i].lane = lane;
    cluster.push(i);
    clusterEnd = Math.max(clusterEnd, items[i].endMin);
  }
  closeCluster();
  return result;
}
