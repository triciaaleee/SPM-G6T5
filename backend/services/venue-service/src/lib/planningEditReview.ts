import { createHash } from "node:crypto";
import type { supabaseAdmin } from "./supabaseAdmin.js";
import type { InboundMessage } from "./rabbitConsumer.js";
import { BOOKING_STATUS, canTransition, blocksVenue, type BookingStatus } from "./bookingStatus.js";
import { VENUE_COLUMNS, blockingWindows, type VenueRow } from "./bookingDecisions.js";
import { formatWindow, occupiedWindow, overlaps, type OccupiedWindow } from "./bookingConflicts.js";
import { reportArrangementsChanged } from "./eventsClient.js";
import { getPublisher } from "./rabbitPublisher.js";
import { describePeriod, findClashingPeriod } from "./unavailability.js";

export interface HandleEventEditedDeps {
  supabase: typeof supabaseAdmin;
}

interface BookingToReview {
  id: number;
  venue_id: number;
  event_id: number;
  status: BookingStatus;
  hold_expires_at: string | null;
  purpose: string | null;
  headcount: number | null;
}

type ReviewedVenue = VenueRow & { capacity: number | null };

/** The booking's purpose that stands for the whole programme (lib/bookingPlan.ts DEFAULT_PURPOSE). */
const MAIN_PROGRAMME = "Main programme";

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** A UUID-shaped id that is the same every time for one inbound message and booking, so a redelivery notifies nobody twice. */
function derivedMessageId(inboundMessageId: string, suffix: string): string {
  const hex = createHash("sha256").update(`${inboundMessageId}:${suffix}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Edits made while an event is in Planning (the date, the start or end time, or
 * the expected attendance) can leave its venue bookings invalid. Nothing
 * re-checked them, so a booking could sit on top of another event's, inside a
 * venue block-out, or at a venue now too small, and look fine until it failed
 * later, if it ever did. events-service announces the edit
 * (`event.rescheduled`, `event.attendance_changed`) and this reviews the event's
 * bookings against it. §3a: a booking that no longer fits is identified and
 * flagged, never silently removed.
 *
 * Checked for each `Requested`, `On Hold` (unexpired) and `Approved` booking:
 *  - schedule edits: the new occupied window (setup and turnaround included)
 *    against the venue's block-out periods and against other events' bookings
 *    that block the venue;
 *  - attendance edits: the venue's capacity against the new attendance, for a
 *    booking meant for the whole attendance (no headcount of its own, or the
 *    main programme), so a small breakout room is left alone.
 *
 * What happens to a booking that no longer fits:
 *  - `Approved` becomes `Replacement Required` (the one move §3a allows from
 *    Approved, decided by the system: `decided_by` is null, the reason names
 *    the cause). The coordinator then finds a replacement (E4-15).
 *  - `Requested` and `On Hold` keep their status (cancelling is only allowed
 *    from Approved) and are only reported.
 * Either way the event's coordinator is told (`booking.invalidated_by_edit`).
 * If an Approved booking was flagged, events-service is told the arrangements
 * changed: a Confirmed event moves to Needs Review, one in Planning stays as it
 * is, and a Safety Review one returns to Planning.
 *
 * Safe to run twice: a flagged booking is no longer Approved, so it is not
 * flagged again, and the notification keeps one message id. A change request
 * approval flags Approved bookings itself; whichever runs second finds the
 * booking already moved. Throws when events-service or the database can't be
 * read, so the message goes to the dead-letter queue instead of passing quietly.
 */
export async function handleEventEdited(msg: InboundMessage, deps: HandleEventEditedDeps): Promise<void> {
  if (msg.eventId === null) return;
  const { supabase } = deps;
  const checksSchedule = msg.type === "event.rescheduled";
  const attendance = typeof msg.data.expectedAttendance === "number" ? msg.data.expectedAttendance : null;
  if (!checksSchedule && attendance === null) return;

  const { data: bookingRows, error: bookingsError } = await supabase
    .from("venue_bookings")
    .select("id, venue_id, event_id, status, hold_expires_at, purpose, headcount")
    .eq("event_id", msg.eventId)
    .in("status", [BOOKING_STATUS.requested, BOOKING_STATUS.onHold, BOOKING_STATUS.approved]);
  if (bookingsError) throw bookingsError;

  const now = new Date();
  const bookings = ((bookingRows ?? []) as BookingToReview[]).filter(
    (booking) => booking.status === BOOKING_STATUS.requested || blocksVenue(booking, now),
  );
  if (bookings.length === 0) return;

  const venueIds = [...new Set(bookings.map((booking) => booking.venue_id))];
  const { data: venueRows, error: venuesError } = await supabase
    .from("venues")
    .select(`${VENUE_COLUMNS}, capacity`)
    .in("id", venueIds);
  if (venuesError) throw venuesError;
  const venuesById = new Map(((venueRows ?? []) as ReviewedVenue[]).map((venue) => [venue.id, venue]));

  const schedule = {
    proposedDate: text(msg.data.proposedDate),
    startTime: text(msg.data.startTime),
    endTime: text(msg.data.endTime),
  };

  const eventName = text(msg.data.eventName) ?? `Event #${msg.eventId}`;
  const coordinatorId = text(msg.data.coordinatorId);
  let approvedFlagged = 0;

  for (const booking of bookings) {
    const venue = venuesById.get(booking.venue_id);
    if (!venue) continue;

    const reason = checksSchedule
      ? await scheduleProblem(supabase, venue, booking, occupiedWindow(schedule, venue))
      : capacityProblem(venue, booking, attendance!);
    if (!reason) continue;

    let status: BookingStatus = booking.status;
    // canTransition is the one place §3a says which statuses can become Replacement Required (only Approved).
    if (canTransition(booking.status, BOOKING_STATUS.replacementRequired)) {
      const { data: updated, error: updateError } = await supabase
        .from("venue_bookings")
        .update({
          status: BOOKING_STATUS.replacementRequired,
          decision_reason: reason,
          decided_by: null,
          decided_at: now.toISOString(),
        })
        .eq("id", booking.id)
        .eq("status", booking.status) // only this exact prior status, against a concurrent decision
        .select("id")
        .maybeSingle();
      if (updateError) throw updateError;
      // Someone decided it first (a change request flagged it, or the staff did): leave it alone.
      if (!updated) continue;
      status = BOOKING_STATUS.replacementRequired;
      approvedFlagged += 1;
    }

    await getPublisher().publish({
      messageId: derivedMessageId(msg.messageId, `booking.invalidated_by_edit:${booking.id}`),
      type: "booking.invalidated_by_edit",
      eventId: msg.eventId,
      actorId: null,
      recipients: coordinatorId ? { userIds: [coordinatorId], roles: [] } : { userIds: [], roles: ["coordinator_lead"] },
      data: { eventName, venueName: venue.name, reason, status, coordinatorId },
    });
  }

  if (approvedFlagged > 0) {
    await reportArrangementsChanged(
      msg.eventId,
      `${approvedFlagged} venue booking${approvedFlagged === 1 ? " no longer fits" : "s no longer fit"} after the event was edited`,
    );
  }
}

/** Why the booking can't keep the event's new time, or null when it still can. Throws when that can't be worked out. */
async function scheduleProblem(
  supabase: HandleEventEditedDeps["supabase"],
  venue: ReviewedVenue,
  booking: BookingToReview,
  window: OccupiedWindow | null,
): Promise<string | null> {
  // No usable date to compare against, so nothing to review.
  if (!window) return null;

  const periodResult = await findClashingPeriod(supabase, venue.id, window);
  if (periodResult.status === "error") throw new Error("Failed to check the venue's block-out periods");
  if (periodResult.period) {
    return `${venue.name} is unavailable ${describePeriod(periodResult.period)}: ${periodResult.period.reason}`;
  }

  const blocking = await blockingWindows(supabase, venue, null, booking.id);
  if (blocking === null) throw new Error("Failed to check the venue's other bookings");
  // The event's own other bookings are never a clash for it.
  const clash = blocking.find((other) => other.booking.event_id !== booking.event_id && overlaps(window, other.window));
  if (clash) {
    return `Another booking holds ${venue.name} for ${formatWindow(clash.window)}, which overlaps this event's new time`;
  }
  return null;
}

/** Why the venue is too small for the new attendance, or null when it is fine or the booking isn't for the whole attendance. */
function capacityProblem(venue: ReviewedVenue, booking: BookingToReview, attendance: number): string | null {
  const wholeAttendance = booking.headcount === null || booking.purpose === null || booking.purpose === MAIN_PROGRAMME;
  if (!wholeAttendance) return null;
  if (venue.capacity === null || venue.capacity >= attendance) return null;
  return `${venue.name} holds ${venue.capacity}, fewer than the event's ${attendance} expected attendees`;
}
