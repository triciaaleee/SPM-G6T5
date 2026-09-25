import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { buildFilterOptions, parseVenueSearch, searchVenues, type VenueRow } from "../lib/venueSearch.js";

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

  // AC2: venues with a booking overlapping the requested window. Two
  // windows overlap when each starts before the other ends; without a time
  // window, any booking that day counts.
  const unavailableVenueIds = new Set<number>();
  if (criteria.date) {
    let bookingsQuery = supabase.from("venue_bookings").select("venue_id").eq("booking_date", criteria.date);
    if (criteria.startTime && criteria.endTime) {
      bookingsQuery = bookingsQuery.lt("start_time", criteria.endTime).gt("end_time", criteria.startTime);
    }

    const { data: bookings, error: bookingsError } = await bookingsQuery;
    if (bookingsError) {
      res.status(500).json({ error: "Failed to check venue availability" });
      return;
    }
    for (const booking of bookings ?? []) unavailableVenueIds.add(booking.venue_id as number);
  }

  const result = searchVenues((venues ?? []) as VenueRow[], criteria, unavailableVenueIds);
  res.json(result);
});
