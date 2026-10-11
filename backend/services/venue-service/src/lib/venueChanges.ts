/**
 * What an edit to a venue record does to the bookings already made there.
 *
 * - E4-1 AC6: reducing capacity below a future Approved booking's expected
 *   attendance notifies that event's coordinator.
 * - §3a change 1 (E4-13): a longer setup or turnaround can make two
 *   bookings' occupied windows overlap. They are identified and reported,
 *   never removed.
 *
 * The rules are pure functions over already-loaded bookings, so the preview
 * and the save report exactly the same thing.
 */
import type { AuthedRequest } from "../middleware/auth.js";
import { UNAVAILABLE_BOOKING_STATUSES, blocksVenue, type BookingStatus } from "./bookingStatus.js";
import { formatWindow, occupiedWindow, overlaps, type WindowPadding } from "./bookingConflicts.js";
import { fetchVenueBookingInfo, type VenueBookingInfo } from "./eventsClient.js";
import type { NewNotification } from "./notificationsClient.js";

type Supabase = NonNullable<AuthedRequest["supabase"]>;

/** A booking at the venue that still holds it, with its event's details. */
export interface LiveBooking {
  id: number;
  status: BookingStatus;
  event: VenueBookingInfo;
}

/** A future Approved booking whose expected attendance no longer fits. */
export interface CapacityShortfall {
  bookingId: number;
  eventId: number;
  eventName: string | null;
  date: string;
  expectedAttendance: number;
  coordinatorId: string | null;
}

/** Two bookings whose occupied windows overlap under the new setup/turnaround but didn't before. */
export interface BufferOverlap {
  first: { bookingId: number; eventId: number; eventName: string | null; window: string; coordinatorId: string | null };
  second: { bookingId: number; eventId: number; eventName: string | null; window: string; coordinatorId: string | null };
}

export interface VenueChangeImpact {
  capacityShortfalls: CapacityShortfall[];
  bufferOverlaps: BufferOverlap[];
}

/** Local "YYYY-MM-DD" — the same calendar the event dates are written in. */
export function localDateKey(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * AC6. Only when capacity actually goes down: an event that was already
 * over capacity before this edit isn't news to its coordinator.
 */
export function findCapacityShortfalls(
  bookings: LiveBooking[],
  oldCapacity: number,
  newCapacity: number,
  today: string,
): CapacityShortfall[] {
  if (newCapacity >= oldCapacity) return [];
  return bookings.flatMap((booking) => {
    const { event } = booking;
    if (booking.status !== "Approved" || !event.proposedDate || event.proposedDate < today) return [];
    // submitted_details is free-form JSON, so attendance may arrive as a string.
    const attendance = event.expectedAttendance === null ? NaN : Number(event.expectedAttendance);
    if (!Number.isFinite(attendance) || attendance <= newCapacity) return [];
    return [
      {
        bookingId: booking.id,
        eventId: event.id,
        eventName: event.name,
        date: event.proposedDate,
        expectedAttendance: attendance,
        coordinatorId: event.coordinatorId ?? null,
      },
    ];
  });
}

/** Pairs of future bookings that overlap with `next` padding but not with `previous`. */
export function findBufferOverlaps(
  bookings: LiveBooking[],
  previous: WindowPadding,
  next: WindowPadding,
  today: string,
): BufferOverlap[] {
  const unchanged =
    (previous.setup_minutes ?? 0) === (next.setup_minutes ?? 0) &&
    (previous.turnaround_minutes ?? 0) === (next.turnaround_minutes ?? 0);
  if (unchanged) return [];

  const windows = bookings.flatMap((booking) => {
    if (!booking.event.proposedDate || booking.event.proposedDate < today) return [];
    const before = occupiedWindow(booking.event, previous);
    const after = occupiedWindow(booking.event, next);
    return before && after ? [{ booking, before, after }] : [];
  });

  const side = ({ booking, after }: (typeof windows)[number]) => ({
    bookingId: booking.id,
    eventId: booking.event.id,
    eventName: booking.event.name,
    window: formatWindow(after),
    coordinatorId: booking.event.coordinatorId ?? null,
  });

  const result: BufferOverlap[] = [];
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i];
      const b = windows[j];
      // Two bookings of the same event at one venue are that event's own business.
      if (a.booking.event.id === b.booking.event.id) continue;
      if (overlaps(a.after, b.after) && !overlaps(a.before, b.before)) result.push({ first: side(a), second: side(b) });
    }
  }
  return result;
}

/**
 * Bookings that still hold the venue (Approved, or On Hold and unexpired)
 * with their events' details. Null when either lookup fails.
 */
export async function loadLiveBookings(
  supabase: Supabase,
  venueId: number,
  authorization: string,
  now: Date = new Date(),
): Promise<LiveBooking[] | null> {
  const { data, error } = await supabase
    .from("venue_bookings")
    .select("id, event_id, status, hold_expires_at")
    .eq("venue_id", venueId)
    .in("status", UNAVAILABLE_BOOKING_STATUSES);
  if (error) return null;

  const rows = (
    (data ?? []) as { id: number; event_id: number; status: BookingStatus; hold_expires_at: string | null }[]
  ).filter((row) => blocksVenue(row, now));
  if (rows.length === 0) return [];

  const info = await fetchVenueBookingInfo([...new Set(rows.map((row) => row.event_id))], authorization);
  if (info.status === "error") return null;
  const eventsById = new Map(info.events.map((event) => [event.id, event]));

  return rows.flatMap((row) => {
    const event = eventsById.get(row.event_id);
    return event ? [{ id: row.id, status: row.status, event }] : [];
  });
}

/** One notification per coordinator per event, so an event in two overlaps isn't told twice. */
export function impactNotifications(venueName: string, impact: VenueChangeImpact, capacity: number): NewNotification[] {
  const notifications: NewNotification[] = [];
  const told = new Set<string>();

  for (const shortfall of impact.capacityShortfalls) {
    if (!shortfall.coordinatorId) continue;
    told.add(`capacity:${shortfall.coordinatorId}:${shortfall.eventId}`);
    const name = shortfall.eventName || `Event #${shortfall.eventId}`;
    notifications.push({
      recipientId: shortfall.coordinatorId,
      type: "venue_capacity_reduced",
      title: `${venueName} capacity reduced`,
      body: `${venueName} now holds at most ${capacity} people, but ${name} on ${shortfall.date} expects ${shortfall.expectedAttendance}. Check whether the event still fits or request another venue.`,
      link: `/events/${shortfall.eventId}`,
    });
  }

  for (const overlap of impact.bufferOverlaps) {
    for (const [mine, other] of [
      [overlap.first, overlap.second],
      [overlap.second, overlap.first],
    ] as const) {
      const key = `overlap:${mine.coordinatorId}:${mine.eventId}`;
      if (!mine.coordinatorId || told.has(key)) continue;
      told.add(key);
      const name = mine.eventName || `Event #${mine.eventId}`;
      notifications.push({
        recipientId: mine.coordinatorId,
        type: "venue_setup_conflict",
        title: `${venueName} booking now overlaps another`,
        body: `${venueName}'s setup or turnaround time changed. ${name} now needs the venue ${mine.window}, which overlaps ${other.eventName || `Event #${other.eventId}`} (${other.window}). Neither booking has been removed.`,
        link: `/events/${mine.eventId}`,
      });
    }
  }
  return notifications;
}

/** The impact without coordinator ids, for the browser. */
export function toPublicImpact(impact: VenueChangeImpact) {
  const strip = <T extends { coordinatorId: string | null }>({ coordinatorId, ...rest }: T) => ({
    ...rest,
    hasCoordinator: coordinatorId !== null,
  });
  return {
    capacityShortfalls: impact.capacityShortfalls.map(strip),
    bufferOverlaps: impact.bufferOverlaps.map((overlap) => ({
      first: strip(overlap.first),
      second: strip(overlap.second),
    })),
  };
}
