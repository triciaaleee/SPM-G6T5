import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { bookingWindow, findFreeSlots, toOperatingHours, type AvailabilityTarget } from "../lib/availability.js";
import { BOOKING_STATUS, UNAVAILABLE_BOOKING_STATUSES, isBlockingBooking } from "../lib/bookingStatus.js";
import { fetchEvent, fetchVenueBookingInfo, type VenueBookingInfo } from "../lib/eventsClient.js";
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

const VENUE_COLUMNS = "id, name, location, description, capacity, accessibility, layouts, facilities";

async function loadActiveVenues(supabase: NonNullable<AuthedRequest["supabase"]>) {
  return supabase.from("venues").select(VENUE_COLUMNS).eq("active", true);
}

/**
 * Does a booked event occupy `date` during `startTime`–`endTime`? Two
 * windows overlap when each starts before the other ends. Without a
 * window, any booking that day counts; an event with no times recorded
 * occupies its whole day. Times are "HH:MM", so they compare as strings.
 */
function occupies(event: VenueBookingInfo, date: string, startTime?: string, endTime?: string): boolean {
  if (event.proposedDate !== date) return false;
  if (!startTime || !endTime || !event.startTime || !event.endTime) return true;
  return event.startTime < endTime && event.endTime > startTime;
}

/**
 * AC2: venues with a booking overlapping the requested window. A booking
 * only links a venue to an event, so its date and times are the booked
 * event's own, read from events-service. Only requested or approved
 * bookings count — a rejected one no longer holds the venue — and a
 * booking whose event events-service doesn't return (deleted, or a draft)
 * has no schedule to clash with. A booking held for `forEventId` doesn't
 * count either: that venue is already this event's own. Resolves to null
 * when either lookup fails.
 */
async function findUnavailableVenueIds(
  supabase: NonNullable<AuthedRequest["supabase"]>,
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

  for (const booking of bookings) {
    const event = eventsById.get(booking.event_id);
    if (event && occupies(event, criteria.date, criteria.startTime, criteria.endTime)) {
      unavailableVenueIds.add(booking.venue_id);
    }
  }
  return unavailableVenueIds;
}

/** Option lists for the filter bar, derived from the venues table. */
venuesRouter.get("/filters", async (req: AuthedRequest, res) => {
  const { data, error } = await loadActiveVenues(req.supabase!);

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

  const { data: venues, error: venuesError } = await loadActiveVenues(supabase);
  if (venuesError) {
    res.status(500).json({ error: "Failed to search venues" });
    return;
  }

  const unavailableVenueIds = await findUnavailableVenueIds(supabase, criteria, req.headers.authorization!);
  if (!unavailableVenueIds) {
    res.status(500).json({ error: "Failed to check venue availability" });
    return;
  }

  const result = searchVenues((venues ?? []) as VenueRow[], criteria, unavailableVenueIds);
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

  const { data: venues, error: venuesError } = await loadActiveVenues(supabase);
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

  const unavailableVenueIds = await findUnavailableVenueIds(supabase, criteria, req.headers.authorization!, eventId);
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
