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
import { fetchVenueBookingInfo, fetchVenueBookingInfoInternal, type VenueBookingInfo } from "./eventsClient.js";
import type { OutboundMessage } from "./rabbitPublisher.js";

type Supabase = NonNullable<AuthedRequest["supabase"]>;

/** A booking at the venue that still holds it, with its event's details. */
export interface LiveBooking {
  id: number;
  status: BookingStatus;
  event: VenueBookingInfo;
  /** E4-17: this booking's own headcount; null (pre-E4-17) means the event's whole attendance. */
  headcount?: number | null;
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
    // E4-17: judged on the booking's own headcount (a breakout room isn't
    // short just because the whole event is bigger). submitted_details is
    // free-form JSON, so the event's attendance may arrive as a string.
    const attendance =
      booking.headcount ?? (event.expectedAttendance === null ? NaN : Number(event.expectedAttendance));
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

/** Every pair of `bookings` whose occupied window overlaps another's under one `padding`. */
function overlappingPairs(bookings: LiveBooking[], padding: WindowPadding, today: string): BufferOverlap[] {
  const windows = bookings.flatMap((booking) => {
    if (!booking.event.proposedDate || booking.event.proposedDate < today) return [];
    const window = occupiedWindow(booking.event, padding);
    return window ? [{ booking, window }] : [];
  });

  const side = ({ booking, window }: (typeof windows)[number]) => ({
    bookingId: booking.id,
    eventId: booking.event.id,
    eventName: booking.event.name,
    window: formatWindow(window),
    coordinatorId: booking.event.coordinatorId ?? null,
  });

  const result: BufferOverlap[] = [];
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i];
      const b = windows[j];
      // Two bookings of the same event at one venue are that event's own business.
      if (a.booking.event.id === b.booking.event.id) continue;
      if (overlaps(a.window, b.window)) result.push({ first: side(a), second: side(b) });
    }
  }
  return result;
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

  const before = new Set(overlappingPairs(bookings, previous, today).map((pair) => pairKey(pair)));
  return overlappingPairs(bookings, next, today).filter((pair) => !before.has(pairKey(pair)));
}

function pairKey(pair: BufferOverlap): string {
  return pair.first.bookingId < pair.second.bookingId
    ? `${pair.first.bookingId}:${pair.second.bookingId}`
    : `${pair.second.bookingId}:${pair.first.bookingId}`;
}

/**
 * E4-13 AC2/AC3: every pair of `bookings` that currently overlaps under the
 * venue's *current* padding — not a diff against a previous padding, unlike
 * `findBufferOverlaps`. This is what the persisted review list
 * (lib/bufferOverlapReview.ts's `reconcileBufferOverlaps`) reconciles
 * against: a pair stays listed for as long as it appears here, and a pair
 * that stops appearing here (because a booking left the unavailable set, or
 * padding was changed back) is the one that "leaves the review list".
 */
export function findAllBufferOverlaps(bookings: LiveBooking[], padding: WindowPadding, today: string): BufferOverlap[] {
  return overlappingPairs(bookings, padding, today);
}

/**
 * Normalizes a pair of booking ids so the lower one is always first —
 * matches the `venue_buffer_overlaps` table's check constraint
 * (`booking_id_a < booking_id_b`). Every place that reads or writes a pair
 * uses this, so the same unordered pair is never stored or looked up two
 * different ways.
 */
export function normalizePair(idA: number, idB: number): [number, number] {
  return idA < idB ? [idA, idB] : [idB, idA];
}

/**
 * Bookings that still hold the venue (Approved, or On Hold and unexpired)
 * with their events' details. Null when either lookup fails.
 *
 * `authorization` is `null` for callers with no end-user token to forward
 * (e.g. reconciliation triggered from the RabbitMQ event-cancelled
 * consumer, lib/eventCancellation.ts) — the same situation
 * `fetchVenueBookingInfoInternal` exists for (#106 row 4b's sweep). Those
 * callers sign a fresh internal token instead of forwarding one.
 */
export async function loadLiveBookings(
  supabase: Supabase,
  venueId: number,
  authorization: string | null,
  now: Date = new Date(),
): Promise<LiveBooking[] | null> {
  const { data, error } = await supabase
    .from("venue_bookings")
    .select("id, event_id, status, hold_expires_at, headcount")
    .eq("venue_id", venueId)
    .in("status", UNAVAILABLE_BOOKING_STATUSES);
  if (error) return null;

  const rows = (
    (data ?? []) as {
      id: number;
      event_id: number;
      status: BookingStatus;
      hold_expires_at: string | null;
      headcount?: number | null;
    }[]
  ).filter((row) => blocksVenue(row, now));
  if (rows.length === 0) return [];

  const eventIds = [...new Set(rows.map((row) => row.event_id))];
  const info = authorization === null
    ? await fetchVenueBookingInfoInternal(eventIds)
    : await fetchVenueBookingInfo(eventIds, authorization);
  if (info.status === "error") return null;
  const eventsById = new Map(info.events.map((event) => [event.id, event]));

  return rows.flatMap((row) => {
    const event = eventsById.get(row.event_id);
    return event ? [{ id: row.id, status: row.status, event, headcount: row.headcount ?? null }] : [];
  });
}

/**
 * `booking.setup_conflict` messages for a set of overlap pairs: one to the
 * venue's staff member per unique pair (#107 row 2), plus one per
 * coordinator per event so an event in two overlaps isn't told twice.
 * Shared by `impactNotifications` (the venue-edit path) and by every other
 * write path that calls `reconcileBufferOverlaps` and wants to notify only
 * for the pairs it newly inserted (AC4) — the message shape must be the one
 * place, not copy-pasted per call site.
 */
export function bufferOverlapNotifications(
  venueName: string,
  bufferOverlaps: BufferOverlap[],
  venueStaffId: string | null,
  told: Set<string> = new Set(),
): OutboundMessage[] {
  const messages: OutboundMessage[] = [];

  for (const overlap of bufferOverlaps) {
    if (venueStaffId) {
      messages.push({
        type: "booking.setup_conflict",
        eventId: overlap.first.eventId,
        actorId: null,
        recipients: { userIds: [venueStaffId], roles: [] },
        data: {
          venueName,
          venueStaffId,
          first: { eventName: overlap.first.eventName, window: overlap.first.window },
          second: { eventName: overlap.second.eventName, window: overlap.second.window },
        },
      });
    }
    for (const [mine, other] of [
      [overlap.first, overlap.second],
      [overlap.second, overlap.first],
    ] as const) {
      const key = `overlap:${mine.coordinatorId}:${mine.eventId}`;
      if (!mine.coordinatorId || told.has(key)) continue;
      told.add(key);
      messages.push({
        type: "booking.setup_conflict",
        eventId: mine.eventId,
        actorId: null,
        recipients: { userIds: [mine.coordinatorId], roles: [] },
        data: {
          venueName,
          venueStaffId,
          eventName: mine.eventName,
          window: mine.window,
          otherEventName: other.eventName,
          otherEventId: other.eventId,
          otherWindow: other.window,
        },
      });
    }
  }
  return messages;
}

/**
 * One message per coordinator per event, so an event in two overlaps isn't
 * told twice — plus one `booking.setup_conflict` message to the venue's
 * staff member per unique overlap pair (#107 row 2). `venue.capacity_reduced`
 * (row 3) has no Venue Staff recipient per the matrix.
 */
export function impactNotifications(
  venueName: string,
  impact: VenueChangeImpact,
  capacity: number,
  venueStaffId: string | null,
): OutboundMessage[] {
  const messages: OutboundMessage[] = [];
  const told = new Set<string>();

  for (const shortfall of impact.capacityShortfalls) {
    if (!shortfall.coordinatorId) continue;
    told.add(`capacity:${shortfall.coordinatorId}:${shortfall.eventId}`);
    messages.push({
      type: "venue.capacity_reduced",
      eventId: shortfall.eventId,
      actorId: null,
      recipients: { userIds: [shortfall.coordinatorId], roles: [] },
      data: {
        venueName,
        capacity,
        eventName: shortfall.eventName,
        date: shortfall.date,
        expectedAttendance: shortfall.expectedAttendance,
      },
    });
  }

  messages.push(...bufferOverlapNotifications(venueName, impact.bufferOverlaps, venueStaffId, told));
  return messages;
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
