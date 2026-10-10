/**
 * E4-10: the Venue Staff decision on one booking — hold, approve or
 * reject — shared by the three routes so the rules live in one place.
 *
 * The conflict rules are E4-8's, read from the same lib/bookingConflicts
 * and lib/bookingStatus helpers, so a decision and a submission can never
 * disagree about what "free" means.
 *
 * Concurrency (E4-11 AC5: "only the first succeeds"). Two guards, because
 * a decision reads what blocks the venue and then writes a status based on
 * that read:
 *
 *  1. `withVenueLock` (lib/venueLock.ts) serialises every decision for one
 *     venue within this process, so the conflict re-check, the status
 *     write and the auto-rejection of the losers run as one uninterrupted
 *     sequence. Different venues stay fully parallel (AC7).
 *  2. `withVenueBookingLock` (lib/venueBookingLock.ts) is the same
 *     serialisation enforced in the database via venue_booking_locks, so
 *     it also holds across several service instances — guard 1 alone only
 *     covers one process.
 *  3. The check is re-run *after* the write, belt-and-braces against
 *     anything guards 1-2 missed. If a rival booking blocks the same
 *     window by then, this decision lost a race, and it rolls itself back
 *     to `Rejected` rather than leave the venue promised twice. The
 *     tie-break is deterministic (earliest decision, then lowest id), so
 *     of two rivals exactly one yields.
 *
 * This is still not the single database transaction the story's wording
 * suggests — a deliberate project decision, since venue_bookings stores no
 * timing at all (the dates and times live in events-service, AGENTS.md
 * §3a), so a Postgres transaction here could not read what it needs to
 * compare in SQL. venue_booking_locks is the piece that still makes the
 * *outcome* ("only the first succeeds") hold across processes, without
 * requiring that timing data to move into this database.
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
import { fetchVenueBookingInfo, type VenueBookingInfo } from "./eventsClient.js";
import { sendNotifications, type NewNotification } from "./notificationsClient.js";
import { describePeriod, findClashingPeriod } from "./unavailability.js";
import { withVenueLock } from "./venueLock.js";
import { isLockBusy, withVenueBookingLock } from "./venueBookingLock.js";
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
  /** Same two fields the submission conflict carries (E4-8 AC6), so one UI can render either. */
  setupMinutes: number;
  turnaroundMinutes: number;
}

export type Decision = "On Hold" | "Approved" | "Rejected";

/** How many coordinators heard about a decision (AC4); best-effort. */
export interface NotifyOutcome {
  coordinatorsNotified: number;
  notificationsFailed: boolean;
}

export type DecisionResult =
  | ({ status: "ok"; booking: BookingRow; venue: VenueRow; autoRejectedIds: number[] } & NotifyOutcome)
  | { status: "not_found" }
  | { status: "not_assigned" }
  | { status: "blocked"; message: string }
  | { status: "conflict"; message: string; conflict: ConflictDetail }
  | { status: "event_error" }
  | { status: "error" };

/**
 * E4-12, change 4: the coordinator hears about an expiry "before or when it
 * expires" — the system decided, so `decided_by` is null, same as an
 * auto-rejection.
 */
function expiredNotification(
  venue: Pick<VenueRow, "id" | "name">,
  booking: BookingRow,
  event: VenueBookingInfo | undefined,
): NewNotification | null {
  const coordinatorId = event?.coordinatorId;
  if (!coordinatorId) return null;
  const eventName = eventLabel(event, booking.event_id);
  return {
    recipientId: coordinatorId,
    type: "venue_booking_expired",
    title: `${venue.name} — hold expired`,
    body:
      `The hold on ${venue.name} for ${eventName} expired before it was decided. ` +
      "You can request another venue or another time.",
    link: `/events/${booking.event_id}`,
  };
}

/**
 * E4-12: every lapsed `On Hold` row becomes `Expired`, and its coordinator
 * is told (change 4). Best-effort and shared by the single-booking sweep
 * (`sweepIfExpired`) and the queue's bulk sweep, so both notify the same way.
 */
export async function expireLapsedHolds(
  supabase: Supabase,
  lapsed: BookingRow[],
  venuesById: Map<number, Pick<VenueRow, "id" | "name">>,
  authorization: string,
): Promise<void> {
  if (lapsed.length === 0) return;
  const now = new Date();
  const { error } = await supabase
    .from("venue_bookings")
    .update({ status: "Expired", decided_at: now.toISOString(), decided_by: null })
    .in(
      "id",
      lapsed.map((booking) => booking.id),
    )
    .eq("status", "On Hold");
  if (error) return;

  const info = await fetchVenueBookingInfo([...new Set(lapsed.map((booking) => booking.event_id))], authorization);
  const eventsById = info.status === "ok" ? new Map(info.events.map((event) => [event.id, event])) : new Map();

  const notifications = lapsed.flatMap((booking) => {
    const venue = venuesById.get(booking.venue_id);
    if (!venue) return [];
    const notification = expiredNotification(venue, booking, eventsById.get(booking.event_id));
    return notification ? [notification] : [];
  });
  await notifyDecision(notifications, authorization);
}

/**
 * E4-12: a hold that has passed its deadline is `Expired` — it holds
 * nothing and has no approve/hold/reject action. §3a requires expiry to be
 * applied whenever availability is checked, so it is swept here rather
 * than waiting for a scheduled job.
 */
async function sweepIfExpired(
  supabase: Supabase,
  booking: BookingRow,
  venue: VenueRow,
  now: Date,
  authorization: string,
): Promise<boolean> {
  if (booking.status !== "On Hold" || blocksVenue(booking, now)) return false;
  await expireLapsedHolds(supabase, [booking], new Map([[venue.id, venue]]), authorization);
  return true;
}

interface BlockingBookingWindow {
  booking: BookingRow;
  window: OccupiedWindow;
}

/** Every booking that currently blocks `venue`, with the window it occupies. */
async function blockingWindows(
  supabase: Supabase,
  venue: VenueRow,
  authorization: string,
  exceptBookingId: number,
): Promise<BlockingBookingWindow[] | null> {
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

function conflictResult(clash: BlockingBookingWindow, ownWindow: OccupiedWindow, venue: VenueRow): DecisionResult {
  return {
    status: "conflict",
    message: "Venue is not available for this period",
    conflict: {
      bookingId: clash.booking.id,
      status: clash.booking.status,
      window: formatWindow(clash.window),
      requestedWindow: formatWindow(ownWindow),
      setupMinutes: venue.setup_minutes ?? 0,
      turnaroundMinutes: venue.turnaround_minutes ?? 0,
    },
  };
}

/**
 * Of two bookings that both ended up blocking one window, which one gives
 * way? The one decided later, and the higher id when the timestamps match.
 * Both sides of a race evaluate this the same way, so exactly one yields
 * and the venue is never left promised twice (nor freed entirely).
 */
function yieldsTo(rival: BookingRow, mine: BookingRow): boolean {
  const rivalAt = rival.decided_at ? Date.parse(rival.decided_at) : 0;
  const myAt = mine.decided_at ? Date.parse(mine.decided_at) : 0;
  if (rivalAt !== myAt) return rivalAt < myAt;
  return rival.id < mine.id;
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
): Promise<{ ids: number[]; losers: { booking: BookingRow; event?: VenueBookingInfo }[] } | null> {
  const { data, error } = await supabase
    .from("venue_bookings")
    .select(BOOKING_COLUMNS)
    .eq("venue_id", venue.id)
    .eq("status", "Requested");
  if (error) return null;

  const rows = ((data ?? []) as BookingRow[]).filter((row) => row.id !== exceptBookingId);
  if (rows.length === 0) return { ids: [], losers: [] };

  const info = await fetchVenueBookingInfo([...new Set(rows.map((r) => r.event_id))], authorization);
  if (info.status === "error") return null;
  const eventsById = new Map(info.events.map((event) => [event.id, event]));

  const losing = rows.filter((row) => {
    const event = eventsById.get(row.event_id);
    const window = event ? occupiedWindow(event, venue) : null;
    return window ? overlaps(window, winning) : false;
  });
  if (losing.length === 0) return { ids: [], losers: [] };

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

  return {
    ids: losing.map((row) => row.id),
    losers: losing.map((row) => ({ booking: row, event: eventsById.get(row.event_id) })),
  };
}

function eventLabel(event: VenueBookingInfo | undefined, eventId: number): string {
  return event?.name || `Event #${eventId}`;
}

/**
 * E4-11 AC4: a coordinator whose request lost the venue is told, so they
 * can request another venue or time. `decided_by` is null on these rows —
 * the system made the call — so the notification says why.
 */
function autoRejectedNotification(
  venue: VenueRow,
  loser: { booking: BookingRow; event?: VenueBookingInfo },
): NewNotification | null {
  const coordinatorId = loser.event?.coordinatorId;
  if (!coordinatorId) return null;
  const eventName = eventLabel(loser.event, loser.booking.event_id);
  return {
    recipientId: coordinatorId,
    type: "venue_booking_auto_rejected",
    title: `Venue request for ${eventName} was rejected`,
    body:
      `${venue.name} was booked for another event over the same period, so your request for ${eventName} ` +
      `was rejected: ${AUTO_REJECT_REASON}. You can request another venue or another time.`,
    link: `/events/${loser.booking.event_id}`,
  };
}

/** E4-10: the coordinator hears the decision on their own request. */
function decidedNotification(
  venue: VenueRow,
  booking: BookingRow,
  event: VenueBookingInfo | undefined,
  decision: Decision,
  reason: string,
): NewNotification | null {
  const coordinatorId = event?.coordinatorId;
  if (!coordinatorId) return null;
  const eventName = eventLabel(event, booking.event_id);

  const outcome =
    decision === "Approved"
      ? `is approved for ${eventName}`
      : decision === "On Hold"
        ? `is on hold for ${eventName} while arrangements are finalised`
        : `was rejected for ${eventName}`;

  return {
    recipientId: coordinatorId,
    type: "venue_booking_decided",
    title: `${venue.name} — booking ${decision === "Rejected" ? "rejected" : decision.toLowerCase()}`,
    body: decision === "Rejected" ? `${venue.name} ${outcome}: ${reason}` : `${venue.name} ${outcome}.`,
    link: `/events/${booking.event_id}`,
  };
}

/**
 * Sends whatever notifications a decision produced. Best-effort and always
 * after the writes have landed: a slow or failing notification-service must
 * never undo a committed decision or hold the venue lock.
 */
async function notifyDecision(notifications: NewNotification[], authorization: string): Promise<NotifyOutcome> {
  const recipients = new Set(notifications.map((n) => n.recipientId));
  if (recipients.size === 0) return { coordinatorsNotified: 0, notificationsFailed: false };
  const sent = await sendNotifications(notifications, authorization);
  return { coordinatorsNotified: sent ? recipients.size : 0, notificationsFailed: !sent };
}

export interface DecisionInput {
  bookingId: number;
  decision: Decision;
  staffId: string;
  authorization: string;
  /** Required for a rejection (AC4); ignored otherwise. */
  reason?: string;
}

/** The lock's result: an outcome, plus what still needs notifying afterwards. */
type GuardedResult =
  | { outcome: DecisionResult; notifications?: never }
  | { outcome: DecisionResult; notifications: NewNotification[] };

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

  const { data: venueData, error: venueError } = await supabase
    .from("venues")
    .select(VENUE_COLUMNS)
    .eq("id", booking.venue_id)
    .maybeSingle();
  if (venueError) return { status: "error" };
  if (!venueData) return { status: "not_found" };
  const venue = venueData as VenueRow;

  if (await sweepIfExpired(supabase, booking, venue, now, input.authorization)) {
    return { status: "blocked", message: "This hold has expired, so it can no longer be decided" };
  }

  if (!canTransition(booking.status, input.decision)) {
    return {
      status: "blocked",
      message: `A ${booking.status} booking cannot be ${input.decision === "Rejected" ? "rejected" : `moved to ${input.decision}`}`,
    };
  }

  const result =
    input.decision === "Rejected"
      ? await rejectBooking(supabase, booking, venue, input, now)
      : await holdOrApprove(supabase, booking, venue, input, now);

  if (result.outcome.status !== "ok" || !result.notifications) return result.outcome;

  const notified = await notifyDecision(result.notifications, input.authorization);
  return { ...result.outcome, ...notified };
}

/**
 * AC4: a rejection needs a reason, releases any hold, and takes the venue
 * from nobody — so it needs neither the venue lock nor a conflict check,
 * and goes through whatever the event is doing.
 */
async function rejectBooking(
  supabase: Supabase,
  booking: BookingRow,
  venue: VenueRow,
  input: DecisionInput,
  now: Date,
): Promise<GuardedResult> {
  const reason = (input.reason ?? "").trim();
  const { data: updated, error: updateError } = await supabase
    .from("venue_bookings")
    .update({
      status: "Rejected",
      decided_at: now.toISOString(),
      decision_reason: reason,
      decided_by: input.staffId,
      hold_expires_at: null,
    })
    .eq("id", booking.id)
    .eq("status", booking.status)
    .select(BOOKING_COLUMNS)
    .maybeSingle();
  if (updateError) return { outcome: { status: "error" } };
  if (!updated) {
    return { outcome: { status: "blocked", message: "This booking was decided by someone else — reload the queue" } };
  }

  // Only now, with the rejection recorded, is the coordinator looked up:
  // telling them is best-effort and must not decide whether this succeeds.
  const info = await fetchVenueBookingInfo([booking.event_id], input.authorization);
  const event = info.status === "ok" ? info.events[0] : undefined;
  const notification = decidedNotification(venue, booking, event, "Rejected", reason);

  return {
    outcome: {
      status: "ok",
      booking: updated as BookingRow,
      venue,
      autoRejectedIds: [],
      coordinatorsNotified: 0,
      notificationsFailed: false,
    },
    notifications: notification ? [notification] : [],
  };
}

/**
 * AC1/AC2/AC3: holding or approving takes the venue, so the event must
 * still be in Planning and nothing else may hold the period. Both the
 * status and the schedule come from venue-booking-info — the one view of
 * an event venue staff are allowed to read.
 */
async function holdOrApprove(
  supabase: Supabase,
  booking: BookingRow,
  venue: VenueRow,
  input: DecisionInput,
  now: Date,
): Promise<GuardedResult> {
  const info = await fetchVenueBookingInfo([booking.event_id], input.authorization);
  if (info.status === "error") return { outcome: { status: "event_error" } };
  const event = info.events[0];
  if (!event) {
    return { outcome: { status: "blocked", message: "This booking's event is no longer available" } };
  }

  if (event.status !== "Planning") {
    return {
      outcome: {
        status: "blocked",
        message: `This event is ${event.status}, so its venue booking can no longer be ${input.decision === "On Hold" ? "held" : "approved"}`,
      },
    };
  }

  const ownWindow = occupiedWindow(event, venue);
  if (!ownWindow) {
    return { outcome: { status: "blocked", message: "This event has no date or time to book a venue for" } };
  }

  // §3a change 2: a venue marked unavailable over this window can't be held
  // or approved for it — a pending booking keeps its status when a block-out
  // lands on it, so the decision is where that is enforced.
  const blockOut = await findClashingPeriod(supabase, venue.id, ownWindow);
  if (blockOut.status === "error") return { outcome: { status: "error" } };
  if (blockOut.period) {
    return {
      outcome: {
        status: "blocked",
        message:
          `${venue.name} is unavailable ${describePeriod(blockOut.period)}: ${blockOut.period.reason}. ` +
          `This booking can't be ${input.decision === "On Hold" ? "held" : "approved"} while it overlaps that period.`,
      },
    };
  }

  // AC5: the re-check, the write, the post-write verification and the
  // auto-rejection are one sequence per venue — no other decision for this
  // venue can interleave with them, in this process (withVenueLock) or any
  // other (withVenueBookingLock).
  return withVenueLock(booking.venue_id, async (): Promise<GuardedResult> => {
    const locked = await withVenueBookingLock(supabase, booking.venue_id, () =>
      decideUnderLock(supabase, booking, venue, input, now, event, ownWindow),
    );
    if (isLockBusy(locked)) {
      return {
        outcome: {
          status: "blocked",
          message: "Another decision for this venue is still being processed — please try again.",
        },
      };
    }
    return locked;
  });
}

async function decideUnderLock(
  supabase: Supabase,
  booking: BookingRow,
  venue: VenueRow,
  input: DecisionInput,
  now: Date,
  event: VenueBookingInfo,
  ownWindow: OccupiedWindow,
): Promise<GuardedResult> {
  const blocking = await blockingWindows(supabase, venue, input.authorization, booking.id);
  if (!blocking) return { outcome: { status: "error" } };
  const clash = blocking.find((candidate) => overlaps(candidate.window, ownWindow));
  if (clash) return { outcome: conflictResult(clash, ownWindow, venue) };

  const { data: updatedData, error: updateError } = await supabase
    .from("venue_bookings")
    .update({
      status: input.decision,
      decided_at: now.toISOString(),
      decided_by: input.staffId,
      hold_expires_at: input.decision === "On Hold" ? holdExpiryFrom(now) : null,
    })
    .eq("id", booking.id)
    // Nothing else may have moved this booking in the meantime.
    .eq("status", booking.status)
    .select(BOOKING_COLUMNS)
    .maybeSingle();
  if (updateError) return { outcome: { status: "error" } };
  if (!updatedData) {
    return {
      outcome: { status: "blocked", message: "This booking was decided by someone else — reload the queue" },
    };
  }
  const updated = updatedData as BookingRow;

  // AC5, second guard: belt-and-braces in case anything above missed a
  // rival. Re-read, and if one now blocks the same window and this
  // booking is the one that must give way, undo it instead of leaving the
  // venue promised twice.
  const after = await blockingWindows(supabase, venue, input.authorization, booking.id);
  if (!after) return { outcome: { status: "error" } };
  const rival = after.find((candidate) => overlaps(candidate.window, ownWindow));
  if (rival && yieldsTo(rival.booking, updated)) {
    const { error: rollbackError } = await supabase
      .from("venue_bookings")
      .update({
        status: "Rejected",
        decision_reason: AUTO_REJECT_REASON,
        decided_by: null,
        decided_at: now.toISOString(),
        hold_expires_at: null,
      })
      .eq("id", booking.id)
      .eq("status", input.decision);
    if (rollbackError) return { outcome: { status: "error" } };
    return { outcome: conflictResult(rival, ownWindow, venue) };
  }

  // Only a decision that kept the venue rejects the requests that lost
  // it — one that yielded above must not drag them down with it.
  const autoRejected = await autoRejectOverlapping(supabase, venue, ownWindow, input.authorization, booking.id, now);
  if (!autoRejected) return { outcome: { status: "error" } };

  const notifications = [
    decidedNotification(venue, booking, event, input.decision, ""),
    ...autoRejected.losers.map((loser) => autoRejectedNotification(venue, loser)),
  ].filter((n): n is NewNotification => n !== null);

  return {
    outcome: {
      status: "ok",
      booking: updated,
      venue,
      autoRejectedIds: autoRejected.ids,
      coordinatorsNotified: 0,
      notificationsFailed: false,
    },
    notifications,
  };
}
