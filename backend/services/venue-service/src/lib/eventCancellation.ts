/**
 * E3-6 / AGENTS.md §3a transitions table: "The event is cancelled —
 * every active booking of the event is released at once." Driven by the
 * `event.cancelled` message events-service publishes (RabbitMQ.md #14),
 * consumed here via rabbitConsumer.ts.
 *
 * Unlike a coordinator's own withdraw/release (bookingWithdrawal.ts),
 * this isn't scoped to one booking or gated by who owns it — the
 * organiser already decided to cancel the whole event, so every booking
 * still active (not already Rejected/Expired/Withdrawn) is released in
 * one pass, including `Replacement Required` (which a coordinator can
 * also release individually via bookingWithdrawal.ts, E4-15 AC3).
 */
import type { AuthedRequest } from "../middleware/auth.js";
import { BOOKING_COLUMNS, type BookingRow } from "./bookingDecisions.js";
import { getPublisher } from "./rabbitPublisher.js";
import { reconcileBufferOverlapsSafely } from "./bufferOverlapReview.js";

type Supabase = NonNullable<AuthedRequest["supabase"]>;

/** AGENTS.md §3a: these are the statuses that still "belong" to the event; everything else is already a dead end. */
const ACTIVE_BOOKING_STATUSES = ["Requested", "On Hold", "Approved", "Replacement Required"] as const;

interface VenueRow {
  id: number;
  name: string;
  staff_id: string | null;
}

export interface ReleaseForCancellationResult {
  released: number;
}

/**
 * Why the event's bookings are being released: the Organiser cancelled it
 * (E3-6) or the coordinator rejected it (`event.rejected`, a Planning event
 * rejected through a clarification, AGENTS.md section 3).
 */
export type EventReleaseReason = "event_cancelled" | "event_rejected";

/**
 * RabbitMQ.md #33: each released booking tells its venue's staff member,
 * the same `booking.withdrawn` type a coordinator's own withdraw/release
 * uses, told apart by `data.reason` (`event_cancelled` or `event_rejected`).
 */
export async function releaseBookingsForCancelledEvent(
  supabase: Supabase,
  eventId: number,
  actorId: string | null,
  eventName: string,
  reason: EventReleaseReason = "event_cancelled",
): Promise<ReleaseForCancellationResult> {
  const { data: updatedData, error: updateError } = await supabase
    .from("venue_bookings")
    .update({ status: "Withdrawn", decided_at: new Date().toISOString(), decided_by: actorId, hold_expires_at: null })
    .eq("event_id", eventId)
    .in("status", ACTIVE_BOOKING_STATUSES)
    .select(BOOKING_COLUMNS);

  if (updateError) throw updateError;

  const updated = (updatedData ?? []) as BookingRow[];
  if (updated.length === 0) return { released: 0 };

  const venueIds = [...new Set(updated.map((booking) => booking.venue_id))];
  const { data: venueRows, error: venueError } = await supabase
    .from("venues")
    .select("id, name, staff_id")
    .in("id", venueIds);
  if (venueError) throw venueError;

  const venueById = new Map(((venueRows ?? []) as VenueRow[]).map((venue) => [venue.id, venue]));
  const publisher = getPublisher();

  // Best-effort, same stance as bookingWithdrawal.ts: the status change
  // already committed, so a failed publish never undoes it.
  for (const booking of updated) {
    const venue = venueById.get(booking.venue_id);
    if (!venue?.staff_id) continue;
    await publisher.publish({
      type: "booking.withdrawn",
      eventId,
      actorId,
      recipients: { userIds: [venue.staff_id], roles: [] },
      data: { bookingId: booking.id, venueName: venue.name, eventName, reason },
    });
  }

  // E4-13 AC3: any Approved/On-Hold booking just released left
  // UNAVAILABLE_BOOKING_STATUSES, which can resolve an overlap it was part
  // of. One reconciliation call per distinct venue — this cancellation can
  // release bookings across several venues at once (change 3). No caller
  // token exists here (this runs off a RabbitMQ consumer, not a request),
  // so `authorization: null` makes loadLiveBookings sign its own internal
  // token, same as the expiring-hold sweep does.
  for (const venueId of venueIds) {
    const venue = venueById.get(venueId);
    await reconcileBufferOverlapsSafely(supabase, venueId, null, {
      venueName: venue?.name,
      venueStaffId: venue?.staff_id,
    });
  }

  return { released: updated.length };
}
