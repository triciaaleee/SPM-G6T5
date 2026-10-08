import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { blocksVenue, type BookingStatus } from "../lib/bookingStatus.js";
import { BOOKING_COLUMNS, decideBooking, type BookingRow as DecisionBookingRow, type Decision } from "../lib/bookingDecisions.js";
import { assignedVenueIds, NOT_ASSIGNED_MESSAGE } from "../lib/venueStaff.js";
import { fetchVenueBookingInfo } from "../lib/eventsClient.js";
import { extractLayoutAndFacilities } from "../lib/venueRecommendation.js";
import { isRealDate, type VenueRow } from "../lib/venueSearch.js";

/**
 * E1-5: venue staff's view of what's booked at a venue. Staff see enough
 * to set the venue up — event name, date, times, attendance, layout and
 * facilities — and nothing of the wider event plan. Event details come
 * from events-service (via lib/eventsClient.ts), which already limits what
 * it hands venue staff; this router narrows it further, turning the
 * organiser's free text into layout/facility values and dropping the text.
 */
export const staffRouter = Router();

staffRouter.use(requireAuth);

function requireVenueStaff(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "venue_staff") {
    res.status(403).json({ error: "Only venue staff can view venue schedules" });
    return;
  }
  next();
}

staffRouter.use(requireVenueStaff);

const VENUE_ID_PATTERN = /^[1-9]\d*$/;

/** A calendar month view spans at most six weeks. */
const MAX_RANGE_DAYS = 42;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A venue_bookings row: a venue-to-event link plus its approval status (venue_booking_status enum). */
interface BookingRow {
  id: number;
  event_id: number;
  /** venue_status — e.g. Replacement Required after a block-out (E4-3). */
  status: string;
}

/** Times may arrive as "HH:MM:SS"; the UI shows "HH:MM". */
function toHourMinute(time: string | null): string {
  return (time ?? "").slice(0, 5);
}

/** Available venues for the schedule's venue picker. */
staffRouter.get("/venues", async (req: AuthedRequest, res) => {
  const { data, error } = await req.supabase!.from("venues").select("id, name").eq("status", "Available").order("name");

  if (error) {
    res.status(500).json({ error: "Failed to load venues" });
    return;
  }

  res.json({ venues: data ?? [] });
});

/**
 * Every booking at one venue between `from` and `to` (inclusive, local
 * "YYYY-MM-DD" dates), earliest first. Every booking is tied to an event
 * (migration 0015) and carries that event's booking-relevant details.
 */
staffRouter.get("/:venueId/bookings", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;
  const rawId = Array.isArray(req.params.venueId) ? req.params.venueId[0] : req.params.venueId;
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";

  if (!VENUE_ID_PATTERN.test(rawId)) {
    res.status(400).json({ error: "Invalid venue id" });
    return;
  }

  const fields: Record<string, string> = {};
  if (!isRealDate(from)) fields.from = "Enter a valid date (YYYY-MM-DD).";
  if (!isRealDate(to)) fields.to = "Enter a valid date (YYYY-MM-DD).";
  if (!fields.from && !fields.to) {
    const days = (Date.parse(to) - Date.parse(from)) / DAY_MS;
    if (days < 0) fields.to = "The end date must not be before the start date.";
    else if (days >= MAX_RANGE_DAYS) fields.to = `The range can cover at most ${MAX_RANGE_DAYS} days.`;
  }
  if (Object.keys(fields).length > 0) {
    res.status(400).json({ error: "Invalid date range", fields });
    return;
  }

  const { data: venue, error: venueError } = await supabase
    .from("venues")
    .select("id, name, location, description, capacity, accessibility, layouts, facilities, setup_minutes, turnaround_minutes")
    .eq("id", Number(rawId))
    .eq("status", "Available")
    .maybeSingle();

  if (venueError) {
    res.status(500).json({ error: "Failed to load the venue" });
    return;
  }
  if (!venue) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  // venue_bookings no longer stores its own timing (migration 0015): each
  // booking's date/time comes from its linked event, so the range filter and
  // sort happen here rather than in the query.
  const { data: bookingData, error: bookingsError } = await supabase
    .from("venue_bookings")
    .select("id, event_id, status")
    .eq("venue_id", venue.id);

  if (bookingsError) {
    res.status(500).json({ error: "Failed to load bookings" });
    return;
  }
  const bookingRows = (bookingData ?? []) as BookingRow[];

  const eventIds = [...new Set(bookingRows.map((b) => b.event_id))];
  const infoResult = await fetchVenueBookingInfo(eventIds, req.headers.authorization!);
  if (infoResult.status === "error") {
    res.status(502).json({ error: "Failed to load the booked events" });
    return;
  }
  const eventsById = new Map(infoResult.events.map((event) => [event.id, event]));

  // Events events-service didn't return (e.g. still a draft) or with no
  // proposed date can't be placed on the schedule, so they're left out.
  const bookings = bookingRows
    .flatMap((booking) => {
      const event = eventsById.get(booking.event_id);
      if (!event?.proposedDate || event.proposedDate < from || event.proposedDate > to) return [];
      return [{ booking, event, date: event.proposedDate, startTime: toHourMinute(event.startTime) }];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  res.json({
    venue: { id: venue.id, name: venue.name },
    bookings: bookings.map(({ booking, event, date, startTime }) => ({
      id: booking.id,
      date,
      startTime,
      endTime: toHourMinute(event.endTime),
      status: booking.status,
      kind: "event",
      event: {
        id: event.id,
        name: event.name,
        expectedAttendance: event.expectedAttendance,
        ...extractLayoutAndFacilities(event, [venue as VenueRow]),
      },
    })),
  });
});

/**
 * E4-10 AC6: the decision queue — every booking at this staff member's
 * venues still waiting on them, ordered by event date so the most urgent
 * surfaces first. A booking's date lives on its event, so ordering happens
 * here rather than in SQL.
 *
 * Holds that have passed their deadline are swept to `Expired` on the way
 * through and left out: §3a requires expiry to be applied whenever
 * availability is checked, and E4-12 AC4 says an expired booking offers no
 * action.
 */
staffRouter.get("/requests", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;

  const assigned = await assignedVenueIds(supabase, req.user!.id);
  if (assigned.status === "error") {
    res.status(500).json({ error: "Failed to load your venues" });
    return;
  }
  if (assigned.venueIds.length === 0) {
    res.json({ requests: [] });
    return;
  }

  const { data: bookingData, error: bookingsError } = await supabase
    .from("venue_bookings")
    .select(BOOKING_COLUMNS)
    .in("venue_id", assigned.venueIds)
    .in("status", ["Requested", "On Hold"]);
  if (bookingsError) {
    res.status(500).json({ error: "Failed to load booking requests" });
    return;
  }
  const pendingRows = (bookingData ?? []) as DecisionBookingRow[];

  const now = new Date();
  const lapsed = pendingRows.filter((booking) => booking.status === "On Hold" && !blocksVenue(booking, now));
  if (lapsed.length > 0) {
    await supabase
      .from("venue_bookings")
      .update({ status: "Expired", decided_at: now.toISOString(), decided_by: null })
      .in(
        "id",
        lapsed.map((booking) => booking.id),
      )
      .eq("status", "On Hold");
  }
  const pending = pendingRows.filter((booking) => !lapsed.some((expired) => expired.id === booking.id));

  const { data: venueData, error: venuesError } = await supabase
    .from("venues")
    .select("id, name, location, capacity, accessibility, layouts, facilities, setup_minutes, turnaround_minutes")
    .in("id", assigned.venueIds);
  if (venuesError) {
    res.status(500).json({ error: "Failed to load your venues" });
    return;
  }
  const venuesById = new Map(((venueData ?? []) as VenueRow[]).map((venue) => [venue.id, venue]));

  const queueInfo = await fetchVenueBookingInfo(
    [...new Set(pending.map((booking) => booking.event_id))],
    req.headers.authorization!,
  );
  if (queueInfo.status === "error") {
    res.status(502).json({ error: "Failed to load the requested events" });
    return;
  }
  const queueEventsById = new Map(queueInfo.events.map((event) => [event.id, event]));

  // A booking whose event events-service won't return (deleted, or back to
  // draft) has nothing to decide on.
  const requests = pending
    .flatMap((booking) => {
      const event = queueEventsById.get(booking.event_id);
      const venue = venuesById.get(booking.venue_id);
      return event && venue ? [{ booking, event, venue }] : [];
    })
    .sort(
      (a, b) =>
        (a.event.proposedDate ?? "").localeCompare(b.event.proposedDate ?? "") ||
        (a.event.startTime ?? "").localeCompare(b.event.startTime ?? ""),
    );

  res.json({
    requests: requests.map(({ booking, event, venue }) => ({
      id: booking.id,
      status: booking.status,
      holdExpiresAt: booking.hold_expires_at,
      venue: {
        id: venue.id,
        name: venue.name,
        location: venue.location,
        setupMinutes: venue.setup_minutes ?? 0,
        turnaroundMinutes: venue.turnaround_minutes ?? 0,
      },
      event: {
        id: event.id,
        name: event.name,
        date: event.proposedDate,
        startTime: event.startTime,
        endTime: event.endTime,
        expectedAttendance: event.expectedAttendance,
        ...extractLayoutAndFacilities(event, [venue]),
      },
    })),
  });
});

const BOOKING_ID_PATTERN = /^[1-9]\d*$/;

/**
 * E4-10: one decision endpoint shape for hold, approve and reject — the
 * rules are in lib/bookingDecisions.ts so all three agree. A refusal is a
 * 409 carrying why (AC2), since the staff member needs to know whether the
 * venue is taken, the event moved on, or the hold already lapsed.
 */
async function decide(req: AuthedRequest, res: Response, decision: Decision): Promise<void> {
  const rawId = Array.isArray(req.params.bookingId) ? req.params.bookingId[0] : req.params.bookingId;
  if (!BOOKING_ID_PATTERN.test(rawId)) {
    res.status(400).json({ error: "Invalid booking id" });
    return;
  }

  const reason = typeof (req.body as { reason?: unknown })?.reason === "string" ? (req.body as { reason: string }).reason : "";
  if (decision === "Rejected" && reason.trim() === "") {
    // AC4: a rejection must carry a reason — the coordinator is told it.
    res.status(400).json({ error: "A reason is required", fields: { reason: "Give a reason for rejecting this request." } });
    return;
  }

  const result = await decideBooking(req.supabase!, {
    bookingId: Number(rawId),
    decision,
    staffId: req.user!.id,
    authorization: req.headers.authorization!,
    reason,
  });

  switch (result.status) {
    case "not_found":
      res.status(404).json({ error: "Booking not found" });
      return;
    case "not_assigned":
      res.status(403).json({ error: NOT_ASSIGNED_MESSAGE });
      return;
    case "blocked":
      res.status(409).json({ error: result.message });
      return;
    case "conflict":
      res.status(409).json({ error: result.message, conflict: result.conflict });
      return;
    case "event_error":
      res.status(502).json({ error: "Failed to load the booked event" });
      return;
    case "error":
      res.status(500).json({ error: "Failed to update the booking" });
      return;
    default:
      res.json({
        booking: {
          id: result.booking.id,
          status: result.booking.status,
          holdExpiresAt: result.booking.hold_expires_at,
          decisionReason: result.booking.decision_reason,
          decidedAt: result.booking.decided_at,
          venue: { id: result.venue.id, name: result.venue.name, location: result.venue.location },
        },
        // §3a/E4-11 AC4: the other requests this decision knocked out.
        autoRejectedBookingIds: result.autoRejectedIds,
      });
  }
}

/** AC1: hold the venue tentatively, with an expiry (E4-12). */
staffRouter.post("/bookings/:bookingId/hold", (req: AuthedRequest, res) => decide(req, res, "On Hold"));

/** AC3: confirm the booking. */
staffRouter.post("/bookings/:bookingId/approve", (req: AuthedRequest, res) => decide(req, res, "Approved"));

/** AC4: refuse the booking, with a reason, releasing any hold. */
staffRouter.post("/bookings/:bookingId/reject", (req: AuthedRequest, res) => decide(req, res, "Rejected"));
