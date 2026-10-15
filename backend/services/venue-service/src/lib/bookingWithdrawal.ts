/**
 * E4-9: the Event Coordinator gives up a booking they no longer want.
 *
 * Two actions land on the same `Withdrawn` status (AGENTS.md §3a) but are
 * not interchangeable:
 *  - "withdraw" — a pending request (`Requested` or `On Hold`) is dropped.
 *    Any hold is released and another venue can be requested for the event.
 *  - "release" — a confirmed (`Approved`) booking is given up. Attempting
 *    to *withdraw* an Approved booking is refused and the coordinator is
 *    pointed at "release" instead (AC2); the reverse also holds.
 *
 * Other bookings of the same event are untouched (AC3): this only ever
 * updates the one row by id.
 *
 * RabbitMQ.md #18: both actions publish `booking.withdrawn` to the venue's
 * staff member, told apart by `data.reason` (notification-service already
 * has a template for this type).
 */
import type { AuthedRequest } from "../middleware/auth.js";
import { BOOKING_COLUMNS, type BookingRow } from "./bookingDecisions.js";
import { fetchEvent } from "./eventsClient.js";
import { getPublisher, type OutboundMessage } from "./rabbitPublisher.js";

type Supabase = NonNullable<AuthedRequest["supabase"]>;

export type WithdrawalAction = "withdraw" | "release";

interface VenueRow {
  id: number;
  name: string;
  location: string;
  staff_id: string | null;
}

const VENUE_COLUMNS = "id, name, location, staff_id";

export interface WithdrawalInput {
  bookingId: number;
  action: WithdrawalAction;
  coordinatorId: string;
  authorization: string;
}

export type WithdrawalResult =
  | { status: "ok"; booking: BookingRow; venue: Omit<VenueRow, "staff_id">; staffNotified: boolean }
  | { status: "not_found" }
  | { status: "not_owner" }
  | { status: "blocked"; message: string }
  | { status: "event_error" }
  | { status: "error" };

/**
 * Whether `action` may be applied to a booking currently in `status`, and
 * if not, the message that explains why (AC2: a blocked withdraw points at
 * release, and vice versa).
 */
function checkAction(action: WithdrawalAction, status: BookingRow["status"]): string | null {
  if (action === "withdraw") {
    if (status === "Requested" || status === "On Hold") return null;
    if (status === "Approved") {
      return "This booking is already Approved — release it instead of withdrawing the request.";
    }
    return `A ${status} booking cannot be withdrawn.`;
  }

  // action === "release"
  if (status === "Approved") return null;
  if (status === "Requested" || status === "On Hold") {
    return "This booking isn't Approved yet — withdraw the request instead of releasing it.";
  }
  return `A ${status} booking cannot be released.`;
}

/** RabbitMQ.md section 2 `data.reason` — why this booking.withdrawn happened. */
const WITHDRAWAL_REASON: Record<WithdrawalAction, string> = {
  withdraw: "coordinator_withdrew",
  release: "coordinator_released",
};

/** #18: the venue's assigned staff member hears the coordinator gave up the booking. */
function withdrawalMessage(
  venue: VenueRow,
  booking: BookingRow,
  action: WithdrawalAction,
  actorId: string,
): OutboundMessage | null {
  if (!venue.staff_id) return null;
  return {
    type: "booking.withdrawn",
    eventId: booking.event_id,
    actorId,
    recipients: { userIds: [venue.staff_id], roles: [] },
    data: { bookingId: booking.id, venueName: venue.name, reason: WITHDRAWAL_REASON[action] },
  };
}

export async function withdrawBooking(supabase: Supabase, input: WithdrawalInput): Promise<WithdrawalResult> {
  const { data: bookingData, error: bookingError } = await supabase
    .from("venue_bookings")
    .select(BOOKING_COLUMNS)
    .eq("id", input.bookingId)
    .maybeSingle();
  if (bookingError) return { status: "error" };
  if (!bookingData) return { status: "not_found" };
  const booking = bookingData as BookingRow;

  // Only the event's assigned coordinator may withdraw or release its
  // bookings (mirrors E4-8's own-event check).
  const eventResult = await fetchEvent(booking.event_id, input.authorization);
  if (eventResult.status === "not_found") return { status: "not_found" };
  if (eventResult.status === "error") return { status: "event_error" };
  if (eventResult.event.coordinator_id !== input.coordinatorId) return { status: "not_owner" };

  const blockedMessage = checkAction(input.action, booking.status);
  if (blockedMessage) return { status: "blocked", message: blockedMessage };

  const now = new Date();
  const { data: updatedData, error: updateError } = await supabase
    .from("venue_bookings")
    .update({
      status: "Withdrawn",
      decided_at: now.toISOString(),
      decided_by: input.coordinatorId,
      hold_expires_at: null,
    })
    .eq("id", booking.id)
    // Nothing else may have moved this booking in the meantime.
    .eq("status", booking.status)
    .select(BOOKING_COLUMNS)
    .maybeSingle();
  if (updateError) return { status: "error" };
  if (!updatedData) {
    return {
      status: "blocked",
      message: "This booking was changed by someone else — reload and try again.",
    };
  }
  const updated = updatedData as BookingRow;

  const { data: venueData, error: venueError } = await supabase
    .from("venues")
    .select(VENUE_COLUMNS)
    .eq("id", booking.venue_id)
    .maybeSingle();
  if (venueError || !venueData) return { status: "error" };
  const venue = venueData as VenueRow;

  // Best-effort, exactly like E4-8/E4-10: the status change is already
  // committed, so a failed publish never undoes it.
  const message = withdrawalMessage(venue, updated, input.action, input.coordinatorId);
  const staffNotified = message ? await getPublisher().publish(message) : false;

  return {
    status: "ok",
    booking: updated,
    venue: { id: venue.id, name: venue.name, location: venue.location },
    staffNotified,
  };
}
