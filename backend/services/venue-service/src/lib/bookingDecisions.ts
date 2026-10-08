/**
 * E4-10: the Venue Staff decision on one booking — hold, approve or
 * reject — shared by the three routes so the rules live in one place.
 *
 * The conflict rules are E4-8's, read from the same lib/bookingConflicts
 * and lib/bookingStatus helpers, so a decision and a submission can never
 * disagree about what "free" means.
 *
 * Concurrency: the check and the update are separate statements, not one
 * transaction (a deliberate project decision). The check is re-run
 * immediately before the write and the result is verified immediately
 * after, which narrows but does not close the window in which two staff
 * acting at the same instant could both succeed. Closing it needs a
 * Postgres exclusion constraint or an RPC.
 */
import type { AuthedRequest } from "../middleware/auth.js";
import {
  UNAVAILABLE_BOOKING_STATUSES,
  blocksVenue,
  canTransition,
  holdExpiryFrom,
  type BookingStatus,
} from "./bookingStatus.js";
import { formatWindow, occupiedWindow, overlaps, type OccupiedWindow } from "./bookingConflicts.js";
import { fetchVenueBookingInfo } from "./eventsClient.js";
import { isAssignedToVenue } from "./venueStaff.js";

type Supabase = NonNullable<AuthedRequest["supabase"]>;

/** §3a, E4-11: the reason a booking is rejected because another one won the venue. */
export const AUTO_REJECT_REASON = "Venue no longer available for this period";

export const BOOKING_COLUMNS = "id, venue_id, event_id, status, hold_expires_at, decision_reason, decided_by, decided_at";

export interface BookingRow {
  id: number;
  venue_id: number;
  event_id: number;
  status: BookingStatus;
  hold_expires_at: string | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

interface VenueRow {
  id: number;
  name: string;
  location: string;
  setup_minutes: number | null;
  turnaround_minutes: number | null;
}

const VENUE_COLUMNS = "id, name, location, setup_minutes, turnaround_minutes";

export interface ConflictDetail {
  bookingId: number;
  status: BookingStatus;
  window: string;
  requestedWindow: string;
}

export type Decision = "On Hold" | "Approved" | "Rejected";

export type DecisionResult =
  | { status: "ok"; booking: BookingRow; venue: VenueRow; autoRejectedIds: number[] }
  | { status: "not_found" }
  | { status: "not_assigned" }
  | { status: "blocked"; message: string }
  | { status: "conflict"; message: string; conflict: ConflictDetail }
  | { status: "event_error" }
  | { status: "error" };

/**
 * E4-12: a hold that has passed its deadline is `Expired` — it holds
 * nothing and has no approve/hold/reject action. §3a requires expiry to be
 * applied whenever availability is checked, so it is swept here rather
 * than waiting for a scheduled job.
 */
async function sweepIfExpired(supabase: Supabase, booking: BookingRow, now: Date): Promise<boolean> {
  if (booking.status !== "On Hold" || blocksVenue(booking, now)) return false;
  await supabase
    .from("venue_bookings")
    .update({ status: "Expired", decided_at: now.toISOString(), decided_by: null })
    .eq("id", booking.id)
    .eq("status", "On Hold");
  return true;
}

/** Every booking that currently blocks `venue`, with the window it occupies. */
async function blockingWindows(
  supabase: Supabase,
  venue: VenueRow,
  authorization: string,
  exceptBookingId: number,
): Promise<{ booking: BookingRow; window: OccupiedWindow }[] | null> {
  const { data, error } = await supabase
    .from("venue_bookings")
    .select(BOOKING_COLUMNS)
    .eq("venue_id", venue.id)
    .in("status", UNAVAILABLE_BOOKING_STATUSES);
  if (error) return null;

  const now = new Date();
  const rows = ((data ?? []) as BookingRow[]).filter(
    (row) => row.id !== exceptBookingId && blocksVenue(row, now),
  );
  if (rows.length === 0) return [];

  const info = await fetchVenueBookingInfo([...new Set(rows.map((r) => r.event_id))], authorization);
  if (info.status === "error") return null;
  const eventsById = new Map(info.events.map((event) => [event.id, event]));

  return rows.flatMap((row) => {
    const event = eventsById.get(row.event_id);
    if (!event) return [];
    const window = occupiedWindow(event, venue);
    return window ? [{ booking: row, window }] : [];
  });
}

/**
 * Every other `Requested` booking at this venue whose window overlaps the
 * one that just won it (§3a "first to reach On Hold or Approved wins",
 * E4-11 AC4). They are rejected with the fixed reason and no decider: the
 * system made the call, not a person.
 */
async function autoRejectOverlapping(
  supabase: Supabase,
  venue: VenueRow,
  winning: OccupiedWindow,
  authorization: string,
  exceptBookingId: number,
  now: Date,
): Promise<number[] | null> {
  const { data, error } = await supabase
    .from("venue_bookings")
    .select(BOOKING_COLUMNS)
    .eq("venue_id", venue.id)
    .eq("status", "Requested");
  if (error) return null;

  const rows = ((data ?? []) as BookingRow[]).filter((row) => row.id !== exceptBookingId);
  if (rows.length === 0) return [];

  const info = await fetchVenueBookingInfo([...new Set(rows.map((r) => r.event_id))], authorization);
  if (info.status === "error") return null;
  const eventsById = new Map(info.events.map((event) => [event.id, event]));

  const losing = rows.filter((row) => {
    const event = eventsById.get(row.event_id);
    const window = event ? occupiedWindow(event, venue) : null;
    return window ? overlaps(window, winning) : false;
  });
  if (losing.length === 0) return [];

  const { error: rejectError } = await supabase
    .from("venue_bookings")
    .update({
      status: "Rejected",
      decision_reason: AUTO_REJECT_REASON,
      decided_by: null,
      decided_at: now.toISOString(),
    })
    .in(
      "id",
      losing.map((row) => row.id),
    )
    .eq("status", "Requested");
  if (rejectError) return null;

  return losing.map((row) => row.id);
}

export interface DecisionInput {
  bookingId: number;
  decision: Decision;
  staffId: string;
  authorization: string;
  /** Required for a rejection (AC4); ignored otherwise. */
  reason?: string;
}

export async function decideBooking(supabase: Supabase, input: DecisionInput): Promise<DecisionResult> {
  const now = new Date();

  const { data: bookingData, error: bookingError } = await supabase
    .from("venue_bookings")
    .select(BOOKING_COLUMNS)
    .eq("id", input.bookingId)
    .maybeSingle();
  if (bookingError) return { status: "error" };
  if (!bookingData) return { status: "not_found" };
  const booking = bookingData as BookingRow;

  // AC7: venue staff decide for their own venues only.
  const assignment = await isAssignedToVenue(supabase, input.staffId, booking.venue_id);
  if (assignment.status === "error") return { status: "error" };
  if (!assignment.assigned) return { status: "not_assigned" };

  if (await sweepIfExpired(supabase, booking, now)) {
    return { status: "blocked", message: "This hold has expired, so it can no longer be decided" };
  }

  if (!canTransition(booking.status, input.decision)) {
    return {
      status: "blocked",
      message: `A ${booking.status} booking cannot be ${input.decision === "Rejected" ? "rejected" : `moved to ${input.decision}`}`,
    };
  }

  const { data: venueData, error: venueError } = await supabase
    .from("venues")
    .select(VENUE_COLUMNS)
    .eq("id", booking.venue_id)
    .maybeSingle();
  if (venueError) return { status: "error" };
  if (!venueData) return { status: "not_found" };
  const venue = venueData as VenueRow;

  const update: Record<string, unknown> = { status: input.decision, decided_at: now.toISOString() };

  if (input.decision === "Rejected") {
    // AC4: a reason is required, and any hold is released immediately.
    update.decision_reason = (input.reason ?? "").trim();
    update.decided_by = input.staffId;
    update.hold_expires_at = null;
  } else {
    // AC1/AC2/AC3: holding or approving takes the venue, so the event must
    // still be in Planning and nothing else may hold the period. Both the
    // status and the schedule come from venue-booking-info — the one view
    // of an event venue staff are allowed to read.
    const info = await fetchVenueBookingInfo([booking.event_id], input.authorization);
    if (info.status === "error") return { status: "event_error" };
    const event = info.events[0];
    if (!event) return { status: "blocked", message: "This booking's event is no longer available" };

    if (event.status !== "Planning") {
      return {
        status: "blocked",
        message: `This event is ${event.status}, so its venue booking can no longer be ${input.decision === "On Hold" ? "held" : "approved"}`,
      };
    }

    const ownWindow = occupiedWindow(event, venue);
    if (!ownWindow) return { status: "blocked", message: "This event has no date or time to book a venue for" };

    const blocking = await blockingWindows(supabase, venue, input.authorization, booking.id);
    if (!blocking) return { status: "error" };
    const clash = blocking.find((candidate) => overlaps(candidate.window, ownWindow));
    if (clash) {
      return {
        status: "conflict",
        message: "Venue is not available for this period",
        conflict: {
          bookingId: clash.booking.id,
          status: clash.booking.status,
          window: formatWindow(clash.window),
          requestedWindow: formatWindow(ownWindow),
        },
      };
    }

    update.decided_by = input.staffId;
    update.hold_expires_at = input.decision === "On Hold" ? holdExpiryFrom(now) : null;

    const { data: updated, error: updateError } = await supabase
      .from("venue_bookings")
      .update(update)
      .eq("id", booking.id)
      // Nothing else may have moved this booking in the meantime.
      .eq("status", booking.status)
      .select(BOOKING_COLUMNS)
      .maybeSingle();
    if (updateError) return { status: "error" };
    if (!updated) {
      return { status: "blocked", message: "This booking was decided by someone else — reload the queue" };
    }

    const autoRejectedIds = await autoRejectOverlapping(
      supabase,
      venue,
      ownWindow,
      input.authorization,
      booking.id,
      now,
    );
    if (!autoRejectedIds) return { status: "error" };

    return { status: "ok", booking: updated as BookingRow, venue, autoRejectedIds };
  }

  const { data: updated, error: updateError } = await supabase
    .from("venue_bookings")
    .update(update)
    .eq("id", booking.id)
    .eq("status", booking.status)
    .select(BOOKING_COLUMNS)
    .maybeSingle();
  if (updateError) return { status: "error" };
  if (!updated) {
    return { status: "blocked", message: "This booking was decided by someone else — reload the queue" };
  }

  return { status: "ok", booking: updated as BookingRow, venue, autoRejectedIds: [] };
}
