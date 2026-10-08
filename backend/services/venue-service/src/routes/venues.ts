import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { bookingWindow, findFreeSlots, toOperatingHours, type AvailabilityTarget } from "../lib/availability.js";
import {
  BOOKING_STATUS,
  UNAVAILABLE_BOOKING_STATUSES,
  blocksVenue,
  isBlockingBooking,
  type BookingStatus,
} from "../lib/bookingStatus.js";
import { formatWindow, occupiedWindow, overlaps, type OccupiedWindow } from "../lib/bookingConflicts.js";
import { fetchEvent, fetchVenueBookingInfo, type VenueBookingInfo } from "../lib/eventsClient.js";
import { sendNotifications, type NewNotification } from "../lib/notificationsClient.js";
import { PERIOD_COLUMNS, findBlockedVenueIds, toBuffers, toPeriod, type PeriodRow } from "../lib/unavailability.js";
import { extractRequirements, scheduleQuery, withFeatures } from "../lib/venueRecommendation.js";
import {
  buildFilterOptions,
  isRealDate,
  parseVenueSearch,
  searchVenues,
  type VenueRow,
  type VenueSearchCriteria,
} from "../lib/venueSearch.js";

export const venuesRouter = Router();

venuesRouter.use(requireAuth);

/**
 * Venue search is a coordinator tool — shortlisting venues is part of
 * planning an approved event, not something organisers do themselves.
 * The service-role client bypasses RLS, so this is the actual enforcement.
 */
function requireCoordinator(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "coordinator") {
    res.status(403).json({ error: "Only coordinators can search venues" });
    return;
  }
  next();
}

venuesRouter.use(requireCoordinator);

const VENUE_COLUMNS =
  "id, name, location, description, capacity, accessibility, layouts, facilities, setup_minutes, turnaround_minutes";

async function loadAvailableVenues(supabase: NonNullable<AuthedRequest["supabase"]>) {
  return supabase.from("venues").select(VENUE_COLUMNS).eq("status", "Available");
}

/** A venue_bookings row, as far as availability is concerned. */
interface BlockingBookingRow {
  id: number;
  venue_id: number;
  event_id: number;
  status: BookingStatus;
  hold_expires_at: string | null;
}

const BOOKING_AVAILABILITY_COLUMNS = "id, venue_id, event_id, status, hold_expires_at";

/**
 * The bookings that currently block a venue, paired with the window each
 * one occupies there. Only `On Hold` (while unexpired) and `Approved`
 * bookings block — see lib/bookingStatus.ts — and each window is padded by
 * its own venue's setup/turnaround times. A booking whose event
 * events-service doesn't return (deleted, or a draft) has no schedule to
 * clash with, and one held `forEventId` doesn't count either: that venue is
 * already this event's own. Resolves to null when either lookup fails.
 */
async function loadBlockingWindows(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  venues: VenueRow[],
  authorization: string,
  forEventId?: number,
): Promise<{ booking: BlockingBookingRow; window: OccupiedWindow }[] | null> {
  const { data, error } = await supabase
    .from("venue_bookings")
    .select(BOOKING_AVAILABILITY_COLUMNS)
    .in("status", UNAVAILABLE_BOOKING_STATUSES);
  if (error) return null;

  const now = new Date();
  const bookings = ((data ?? []) as BlockingBookingRow[]).filter(
    (booking) => blocksVenue(booking, now) && booking.event_id !== forEventId,
  );

  const infoResult = await fetchVenueBookingInfo([...new Set(bookings.map((b) => b.event_id))], authorization);
  if (infoResult.status === "error") return null;
  const eventsById = new Map(infoResult.events.map((event) => [event.id, event]));
  const venuesById = new Map(venues.map((venue) => [venue.id, venue]));

  return bookings.flatMap((booking) => {
    const event = eventsById.get(booking.event_id);
    const venue = venuesById.get(booking.venue_id);
    if (!event || !venue) return [];
    const window = occupiedWindow(event, venue);
    return window ? [{ booking, window }] : [];
  });
}

/**
 * AC2: venues with a blocking booking overlapping the requested window.
 * The requested window is padded by the same venue's setup/turnaround
 * times as the booking it is compared against, so the two are measured the
 * same way. Resolves to null when a lookup fails.
 */
async function findUnavailableVenueIds(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  venues: VenueRow[],
  criteria: VenueSearchCriteria,
  authorization: string,
  forEventId?: number,
): Promise<Set<number> | null> {
  const unavailableVenueIds = new Set<number>();
  if (!criteria.date) return unavailableVenueIds;

  // E4-3 AC3: venues staff have blocked out for this slot are excluded too.
  const blockedVenueIds = await findBlockedVenueIds(supabase, criteria.date, criteria.startTime, criteria.endTime);
  if (blockedVenueIds === null) return null;
  for (const id of blockedVenueIds) unavailableVenueIds.add(id);

  const { data, error } = await supabase
    .from("venue_bookings")
    .select("venue_id, event_id, status, hold_expires_at")
    .in("status", UNAVAILABLE_BOOKING_STATUSES);
  if (error) return null;

  const now = new Date();
  const bookings = (
    (data ?? []) as { venue_id: number; event_id: number; status: string; hold_expires_at: string | null }[]
  ).filter(
    // A lapsed On Hold no longer holds the venue, even before the expiry sweep marks it Expired.
    (booking) => isBlockingBooking(booking, now) && (forEventId === undefined || booking.event_id !== forEventId),
  );
  const infoResult = await fetchVenueBookingInfo([...new Set(bookings.map((b) => b.event_id))], authorization);
  if (infoResult.status === "error") return null;
  const eventsById = new Map(infoResult.events.map((event) => [event.id, event]));

  const venuesById = new Map(venues.map((venue) => [venue.id, venue]));
  const wanted = new Map<number, OccupiedWindow>();
  for (const venue of venues) {
    const window = occupiedWindow(
      { proposedDate: criteria.date, startTime: criteria.startTime, endTime: criteria.endTime },
      venue,
    );
    if (window) wanted.set(venue.id, window);
  }

  // Each booking occupies its venue for the event's times padded by that
  // venue's setup and turnaround, and the requested window is padded the
  // same way, so the two are measured alike (E4-4, E4-8 AC6).
  for (const booking of bookings) {
    const venue = venuesById.get(booking.venue_id);
    const event = eventsById.get(booking.event_id);
    if (!venue || !event) continue;
    const occupied = occupiedWindow(event, venue);
    const requested = wanted.get(booking.venue_id);
    if (occupied && requested && overlaps(requested, occupied)) unavailableVenueIds.add(booking.venue_id);
  }
  return unavailableVenueIds;
}

/** Option lists for the filter bar, derived from the venues table. */
venuesRouter.get("/filters", async (req: AuthedRequest, res) => {
  const { data, error } = await loadAvailableVenues(req.supabase!);

  if (error) {
    res.status(500).json({ error: "Failed to load venue filters" });
    return;
  }

  res.json(buildFilterOptions((data ?? []) as VenueRow[]));
});

/**
 * Search. Criteria are query params (see parseVenueSearch); every one is
 * optional, so no params returns every active venue. When nothing matches,
 * `relax` lists which single filter to drop to get results back (AC3).
 */
venuesRouter.get("/", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;

  const parsed = parseVenueSearch(req.query as Record<string, unknown>);
  if (!parsed.valid) {
    res.status(400).json({ error: "Invalid search", fields: parsed.fields });
    return;
  }
  const { criteria } = parsed;

  const { data: venues, error: venuesError } = await loadAvailableVenues(supabase);
  if (venuesError) {
    res.status(500).json({ error: "Failed to search venues" });
    return;
  }
  const venueRows = (venues ?? []) as VenueRow[];

  const unavailableVenueIds = await findUnavailableVenueIds(supabase, venueRows, criteria, req.headers.authorization!);
  if (!unavailableVenueIds) {
    res.status(500).json({ error: "Failed to check venue availability" });
    return;
  }

  const result = searchVenues(venueRows, criteria, unavailableVenueIds);
  res.json(result);
});

/**
 * Recommended venues for one event request: every venue that meets all of
 * the event's requirements — fits the expected attendance (capacity equal
 * to attendance counts), is free at the event's date and time, and has
 * every main accessibility feature, layout and facility the organiser asked for
 * (see lib/venueRecommendation.ts). All of them are returned, tightest
 * capacity fit first, along with the
 * requirements that were checked so the coordinator can see why.
 */
venuesRouter.get("/recommendations/:eventId", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;
  const rawId = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;

  if (!/^[1-9]\d*$/.test(rawId)) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }
  const eventId = Number(rawId);

  const eventResult = await fetchEvent(eventId, req.headers.authorization!);
  if (eventResult.status === "not_found") {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  if (eventResult.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }

  const { data: venues, error: venuesError } = await loadAvailableVenues(supabase);
  if (venuesError) {
    res.status(500).json({ error: "Failed to load venues" });
    return;
  }
  const venueRows = (venues ?? []) as VenueRow[];

  const requirements = extractRequirements(eventResult.event.submitted_details ?? {}, venueRows);
  const parsed = parseVenueSearch(scheduleQuery(requirements));
  if (!parsed.valid) {
    res.status(422).json({ error: "This event's date, time or attendance is invalid", fields: parsed.fields });
    return;
  }
  const criteria = withFeatures(parsed.criteria, requirements);

  const unavailableVenueIds = await findUnavailableVenueIds(supabase, venueRows, criteria, req.headers.authorization!, eventId);
  if (!unavailableVenueIds) {
    res.status(500).json({ error: "Failed to check venue availability" });
    return;
  }

  const { venues: suitable } = searchVenues(venueRows, criteria, unavailableVenueIds);
  res.json({
    requirements,
    venues: suitable,
  });
});

/**
 * E4-8 AC1: tell the venue's staff a request is waiting on them. The
 * recipient is whoever the venue is assigned to (`venues.staff_id`,
 * migration 0015) — read here rather than carried on the venue row the
 * search returns, so a coordinator's results never expose staff identities.
 *
 * Best-effort: the booking is already created, and a request nobody was
 * notified about still appears in the staff queue. Resolves false when
 * there is no one assigned or the send failed.
 */
async function notifyVenueStaff(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  venue: VenueRow,
  eventId: number,
  details: Record<string, unknown>,
  authorization: string,
): Promise<boolean> {
  const { data, error } = await supabase.from("venues").select("staff_id").eq("id", venue.id).maybeSingle();
  const staffId = (data as { staff_id: string | null } | null)?.staff_id;
  if (error || !staffId) return false;

  const eventName = typeof details.name === "string" && details.name ? details.name : `Event #${eventId}`;
  const date = typeof details.proposedDate === "string" ? details.proposedDate : null;
  const startTime = typeof details.startTime === "string" ? details.startTime : null;
  const endTime = typeof details.endTime === "string" ? details.endTime : null;
  const when = date ? `${date}${startTime && endTime ? `, ${startTime}–${endTime}` : ""}` : "a date to be confirmed";

  const notification: NewNotification = {
    recipientId: staffId,
    type: "venue_booking_requested",
    title: `New booking request for ${venue.name}`,
    body: `${eventName} has requested ${venue.name} for ${when}. Hold, approve or reject it from your booking requests.`,
    link: "/venue-requests",
  };

  return sendNotifications([notification], authorization);
}

const VENUE_ID_PATTERN = /^[1-9]\d*$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A month view spans at most six weeks, as on the venue staff schedule. */
const MAX_RANGE_DAYS = 42;

function queryString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Venue availability calendar: one venue's unavailable time between `from`
 * and `to` (inclusive local dates, at most 42 days), so a coordinator can
 * see when they could realistically request it.
 *
 * AC1/AC2 — Approved and unexpired On Hold bookings, each with its status so
 *           the calendar can tell them apart. A lapsed hold counts as
 *           Expired (AGENTS.md §3a) and is left out.
 * AC3     — Requested, Rejected, Expired, Withdrawn and Replacement Required
 *           bookings never come back: they don't block the venue.
 * AC4     — block-out periods (venue_unavailability) and the venue's daily
 *           operating hours; everything outside those hours is unavailable.
 * AC5     — with targetFrom (and optionally targetTo, targetStart, targetEnd),
 *           the free slots inside that target, per day.
 * AC6     — each booking's occupiedStart/occupiedEnd is its event's times
 *           padded by the venue's setup and turnaround.
 *
 * Event details come from events-service with the caller's own token; only
 * the event's id, name and times are passed on.
 */
venuesRouter.get("/:venueId/availability", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;
  const rawId = Array.isArray(req.params.venueId) ? req.params.venueId[0] : req.params.venueId;
  if (!VENUE_ID_PATTERN.test(rawId)) {
    res.status(400).json({ error: "Invalid venue id" });
    return;
  }

  const from = queryString(req.query.from);
  const to = queryString(req.query.to);
  const targetFrom = queryString(req.query.targetFrom);
  const targetTo = queryString(req.query.targetTo) || targetFrom;
  const targetStart = queryString(req.query.targetStart);
  const targetEnd = queryString(req.query.targetEnd);

  const fields: Record<string, string> = {};
  if (!isRealDate(from)) fields.from = "Enter a valid date (YYYY-MM-DD).";
  if (!isRealDate(to)) fields.to = "Enter a valid date (YYYY-MM-DD).";
  if (!fields.from && !fields.to) {
    const days = (Date.parse(to) - Date.parse(from)) / DAY_MS;
    if (days < 0) fields.to = "The end date must not be before the start date.";
    else if (days >= MAX_RANGE_DAYS) fields.to = `The range can cover at most ${MAX_RANGE_DAYS} days.`;
  }
  if (targetFrom || targetStart || targetEnd) {
    if (!isRealDate(targetFrom)) fields.targetFrom = "Enter a target date.";
    else if (!isRealDate(targetTo)) fields.targetTo = "Enter a valid date (YYYY-MM-DD).";
    else if (targetTo < targetFrom) fields.targetTo = "The end date must not be before the start date.";
    if (targetStart && !TIME_PATTERN.test(targetStart)) fields.targetStart = "Enter a valid time (HH:MM).";
    if (targetEnd && !TIME_PATTERN.test(targetEnd)) fields.targetEnd = "Enter a valid time (HH:MM).";
    if (!fields.targetStart && !fields.targetEnd && targetStart && targetEnd && targetEnd <= targetStart) {
      fields.targetEnd = "The end time must be after the start time.";
    }
  }
  if (Object.keys(fields).length > 0) {
    res.status(400).json({ error: "Invalid request", fields });
    return;
  }

  // select("*") so the calendar still works on a database that predates
  // migration 0019 (no operating hours yet): the venue then reads as open all day.
  const { data: venueRow, error: venueError } = await supabase
    .from("venues")
    .select("*")
    .eq("id", Number(rawId))
    .eq("active", true)
    .maybeSingle();
  if (venueError) {
    res.status(500).json({ error: "Failed to load the venue" });
    return;
  }
  if (!venueRow) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }
  const venue = venueRow as VenueRow & {
    setup_minutes?: number | null;
    turnaround_minutes?: number | null;
    opening_time?: string | null;
    closing_time?: string | null;
  };
  const buffers = toBuffers(venue);
  const hours = toOperatingHours(venue);

  const [bookingsResult, periodsResult] = await Promise.all([
    supabase
      .from("venue_bookings")
      .select("id, event_id, status, hold_expires_at")
      .eq("venue_id", venue.id)
      .in("status", UNAVAILABLE_BOOKING_STATUSES),
    supabase
      .from("venue_unavailability")
      .select(PERIOD_COLUMNS)
      .eq("venue_id", venue.id)
      .lte("start_date", to)
      .gte("end_date", from)
      .order("start_date"),
  ]);
  if (bookingsResult.error || periodsResult.error) {
    res.status(500).json({ error: "Failed to load venue availability" });
    return;
  }

  const now = new Date();
  const bookingRows = (
    (bookingsResult.data ?? []) as { id: number; event_id: number; status: string; hold_expires_at: string | null }[]
  ).filter((booking) => isBlockingBooking(booking, now));

  const infoResult = await fetchVenueBookingInfo(
    [...new Set(bookingRows.map((b) => b.event_id))],
    req.headers.authorization!,
  );
  if (infoResult.status === "error") {
    res.status(502).json({ error: "Failed to load the booked events" });
    return;
  }
  const eventsById = new Map(infoResult.events.map((event) => [event.id, event]));

  // A booking whose event events-service doesn't return (deleted, or a
  // draft) has no date to show, so it can't block anything on the calendar.
  const bookings = bookingRows
    .flatMap((booking) => {
      const event = eventsById.get(booking.event_id);
      if (!event?.proposedDate || event.proposedDate < from || event.proposedDate > to) return [];
      const scheduled = { date: event.proposedDate, startTime: event.startTime, endTime: event.endTime };
      const occupied = bookingWindow(scheduled, buffers);
      return [
        {
          id: booking.id,
          status: booking.status,
          ...scheduled,
          occupiedStart: occupied.start,
          occupiedEnd: occupied.end,
          holdExpiresAt: booking.status === BOOKING_STATUS.onHold ? booking.hold_expires_at : null,
          event: { id: event.id, name: event.name },
        },
      ];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.occupiedStart.localeCompare(b.occupiedStart));

  const periods = ((periodsResult.data ?? []) as PeriodRow[]).map(toPeriod);

  const target: AvailabilityTarget | null = targetFrom
    ? { fromDate: targetFrom, toDate: targetTo, startTime: targetStart || null, endTime: targetEnd || null }
    : null;

  res.json({
    venue: {
      id: venue.id,
      name: venue.name,
      location: venue.location,
      capacity: venue.capacity,
      ...buffers,
      ...hours,
    },
    bookings,
    unavailability: periods,
    target,
    freeSlots: target ? findFreeSlots({ from, to }, target, bookings, periods, hours, buffers) : [],
  });
});

/** Statuses that mean this event still holds (or is still asking for) the venue. */
const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ["Requested", "On Hold", "Approved"];

/**
 * The event's own schedule as a window at `venue`, or the reason it can't
 * be worked out. The date, times and attendance all come from the event
 * (events.submitted_details) — a booking never stores its own timing (§3a),
 * so a request carries nothing but the event and the venue.
 */
function eventWindow(
  event: { submitted_details: Record<string, unknown> },
  venue: VenueRow,
  venues: VenueRow[],
): { ok: true; window: OccupiedWindow } | { ok: false; fields: Record<string, string> } {
  const requirements = extractRequirements(event.submitted_details ?? {}, venues);
  const parsed = parseVenueSearch(scheduleQuery(requirements));
  if (!parsed.valid) return { ok: false, fields: parsed.fields };

  const window = occupiedWindow(
    {
      proposedDate: parsed.criteria.date,
      startTime: parsed.criteria.startTime,
      endTime: parsed.criteria.endTime,
    },
    venue,
  );
  if (!window) return { ok: false, fields: { date: "This event has no date to book a venue for." } };
  return { ok: true, window };
}

/**
 * E4-8: request a venue for one event. The booking is created as
 * `Requested`, which does not yet hold the venue — Venue Staff decide
 * (E4-10). An event may have any number of venue bookings (§3a change 3)
 * and each is checked on its own, so requesting a second venue never
 * touches the first.
 *
 * A request that overlaps a booking already blocking the venue is refused
 * here rather than created and auto-rejected later (AC4), and the clashing
 * occupied window — setup and turnaround included — comes back with it so
 * the coordinator can pick another time or venue (AC6).
 *
 * The check and the insert are two statements, not one transaction: two
 * simultaneous submissions can both succeed, which is harmless because
 * `Requested` blocks nothing and the first booking to reach `On Hold` or
 * `Approved` auto-rejects the rest (§3a, E4-10/E4-11).
 */
venuesRouter.post("/bookings", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;
  const body = (req.body ?? {}) as { eventId?: unknown; venueId?: unknown };

  const fields: Record<string, string> = {};
  const eventId = Number(body.eventId);
  const venueId = Number(body.venueId);
  if (!Number.isInteger(eventId) || eventId < 1) fields.eventId = "Choose an event to request a venue for.";
  if (!Number.isInteger(venueId) || venueId < 1) fields.venueId = "Choose a venue to request.";
  if (Object.keys(fields).length > 0) {
    res.status(400).json({ error: "Invalid booking request", fields });
    return;
  }

  // events-service is asked with the coordinator's own token, so its access
  // rules decide whether this event is theirs to plan.
  const eventResult = await fetchEvent(eventId, req.headers.authorization!);
  if (eventResult.status === "not_found") {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  if (eventResult.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }
  // §3a: — → `Requested` happens while venue arrangements are being made.
  if (eventResult.event.status !== "Planning") {
    res.status(409).json({ error: "A venue can only be requested while the event is in Planning" });
    return;
  }

  const { data: venues, error: venuesError } = await loadAvailableVenues(supabase);
  if (venuesError) {
    res.status(500).json({ error: "Failed to load venues" });
    return;
  }
  const venueRows = (venues ?? []) as VenueRow[];
  const venue = venueRows.find((row) => row.id === venueId);
  if (!venue) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  const requested = eventWindow(eventResult.event, venue, venueRows);
  if (!requested.ok) {
    res.status(422).json({ error: "This event's date or time is invalid", fields: requested.fields });
    return;
  }

  const { data: existing, error: existingError } = await supabase
    .from("venue_bookings")
    .select("id, status")
    .eq("event_id", eventId)
    .eq("venue_id", venueId)
    .in("status", ACTIVE_BOOKING_STATUSES);
  if (existingError) {
    res.status(500).json({ error: "Failed to check existing bookings" });
    return;
  }
  const alreadyRequested = ((existing ?? []) as { id: number; status: BookingStatus }[])[0];
  if (alreadyRequested) {
    res.status(409).json({
      error: `This event already has a ${alreadyRequested.status} booking for this venue`,
      booking: { id: alreadyRequested.id, status: alreadyRequested.status },
    });
    return;
  }

  const blocking = await loadBlockingWindows(supabase, venueRows, req.headers.authorization!, eventId);
  if (!blocking) {
    res.status(500).json({ error: "Failed to check venue availability" });
    return;
  }
  const clash = blocking.find(
    ({ booking, window }) => booking.venue_id === venueId && overlaps(requested.window, window),
  );
  if (clash) {
    res.status(409).json({
      error: "Venue is not available for this period",
      conflict: {
        bookingId: clash.booking.id,
        status: clash.booking.status,
        window: formatWindow(clash.window),
        requestedWindow: formatWindow(requested.window),
        setupMinutes: venue.setup_minutes ?? 0,
        turnaroundMinutes: venue.turnaround_minutes ?? 0,
      },
    });
    return;
  }

  // AC3: stated outright rather than left to the column default.
  const { data: booking, error: insertError } = await supabase
    .from("venue_bookings")
    .insert({ venue_id: venueId, event_id: eventId, status: "Requested" })
    .select("id, status, created_at")
    .single();
  if (insertError || !booking) {
    res.status(500).json({ error: "Failed to submit the booking request" });
    return;
  }

  // AC1: routed to Venue Staff — it is in their queue either way, and they
  // are told about it when the venue has someone assigned.
  const staffNotified = await notifyVenueStaff(
    supabase,
    venue,
    eventId,
    (eventResult.event.submitted_details ?? {}) as Record<string, unknown>,
    req.headers.authorization!,
  );

  res.status(201).json({
    staffNotified,
    booking: {
      id: (booking as { id: number }).id,
      status: (booking as { status: BookingStatus }).status,
      createdAt: (booking as { created_at: string }).created_at,
      venue: { id: venue.id, name: venue.name, location: venue.location },
    },
  });
});
