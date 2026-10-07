import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchEvent, fetchVenueBookingInfo } from "../lib/eventsClient.js";
import { findBlockedVenueIds } from "../lib/unavailability.js";
import { extractRequirements, scheduleQuery, withFeatures } from "../lib/venueRecommendation.js";
import {
  buildFilterOptions,
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
 * AC2: venues with a booking overlapping the requested window. Two
 * windows overlap when each starts before the other ends; without a time
 * window, any booking that day counts. A booking held for `forEventId`
 * doesn't count — that venue is already this event's own. Resolves to
 * null when the lookup fails.
 *
 * venue_bookings no longer stores its own timing (migration 0015) — every
 * booking's date/time comes from its linked event, fetched in bulk from
 * events-service via fetchVenueBookingInfo. This means date filtering can
 * no longer happen at the DB level (there's no local date column to
 * filter on); every booking for every venue is fetched, then compared
 * against each linked event's date/time in application code. Acceptable
 * at this project's scale — see AGENTS.md's venue_bookings notes.
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

  const { data: bookings, error } = await supabase.from("venue_bookings").select("venue_id, event_id");
  if (error) return null;

  const relevantBookings = (bookings ?? []).filter(
    (booking) => forEventId === undefined || booking.event_id !== forEventId,
  );
  const eventIds = [...new Set(relevantBookings.map((booking) => booking.event_id as number))];

  const infoResult = await fetchVenueBookingInfo(eventIds, authorization);
  if (infoResult.status === "error") return null;
  const eventsById = new Map(infoResult.events.map((event) => [event.id, event]));

  for (const booking of relevantBookings) {
    const event = eventsById.get(booking.event_id as number);
    if (!event || event.proposedDate !== criteria.date) continue;
    if (criteria.startTime && criteria.endTime) {
      if (!event.startTime || !event.endTime) continue;
      if (!(event.startTime < criteria.endTime && event.endTime > criteria.startTime)) continue;
    }
    unavailableVenueIds.add(booking.venue_id as number);
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
