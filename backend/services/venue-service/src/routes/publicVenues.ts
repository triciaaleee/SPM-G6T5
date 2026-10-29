import { Router } from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { BOOKING_STATUS } from "../lib/bookingStatus.js";
import { MAX_EVENT_IDS, parseEventIds } from "../lib/eventIds.js";
import { fetchPublicEvents, type PublicEvent } from "../lib/eventsClient.js";

/**
 * Guests browsing the public landing pages, no login. Two views:
 *
 * - GET /  — every Available venue, with what a visitor would want to know
 *   (name, location, description, capacity, accessibility, layouts,
 *   facilities) and the publicly listed events booked there. Nothing about
 *   bookings, setup/turnaround times or who looks after the venue.
 * - GET /event-venues?eventIds= — the venue names of publicly listed events,
 *   the guest counterpart of attendee-info.
 *
 * Only `Approved` bookings count (a requested or held venue isn't
 * confirmed), and only for events events-service lists publicly — an id for
 * any other event is ignored, so this can't be used to probe private events.
 */
export const publicVenuesRouter = Router();

const PUBLIC_VENUE_COLUMNS = "id, name, location, description, capacity, accessibility, layouts, facilities";

interface ApprovedBookingRow {
  event_id: number;
  venue_id: number;
  venues: { name: string } | { name: string }[] | null;
}

/** Approved bookings for the given events, with each venue's name. */
async function approvedBookings(eventIds: number[]) {
  if (eventIds.length === 0) return { data: [] as ApprovedBookingRow[], error: null };
  const { data, error } = await supabaseAdmin
    .from("venue_bookings")
    .select("event_id, venue_id, venues (name)")
    .in("event_id", eventIds)
    .eq("status", BOOKING_STATUS.approved);
  return { data: (data ?? []) as unknown as ApprovedBookingRow[], error };
}

const dateOf = (event: PublicEvent) => event.proposedDate ?? "9999-12-31";
const timeOf = (event: PublicEvent) => event.startTime ?? "00:00";

/** Soonest first; an event with no date sorts last, and one with no time counts as midnight. */
function byStart(a: PublicEvent, b: PublicEvent): number {
  return dateOf(a).localeCompare(dateOf(b)) || timeOf(a).localeCompare(timeOf(b));
}

// Stryker disable next-line StringLiteral: Express matches "" and "/" to the same route
publicVenuesRouter.get("/", async (_req, res) => {
  const { data: venues, error } = await supabaseAdmin
    .from("venues")
    .select(PUBLIC_VENUE_COLUMNS)
    .eq("status", "Available")
    .order("name");
  if (error) {
    res.status(500).json({ error: "Failed to load venues" });
    return;
  }

  const listed = await fetchPublicEvents();
  if (listed.status === "error") {
    res.status(502).json({ error: "Failed to load events" });
    return;
  }
  const eventById = new Map(listed.events.map((event) => [event.id, event]));

  const bookings = await approvedBookings([...eventById.keys()]);
  if (bookings.error) {
    res.status(500).json({ error: "Failed to load venues" });
    return;
  }

  const eventsByVenue = new Map<number, PublicEvent[]>();
  for (const booking of bookings.data) {
    const event = eventById.get(booking.event_id)!;
    const list = eventsByVenue.get(booking.venue_id) ?? [];
    if (!list.some((e) => e.id === event.id)) list.push(event);
    eventsByVenue.set(booking.venue_id, list);
  }

  res.json({
    venues: (venues ?? []).map((venue) => ({
      ...venue,
      upcomingEvents: (eventsByVenue.get(venue.id) ?? [])
        .sort(byStart)
        .map(({ id, name, proposedDate, startTime }) => ({ id, name, proposedDate, startTime })),
    })),
  });
});

publicVenuesRouter.get("/event-venues", async (req, res) => {
  const requestedIds = parseEventIds(req.query.eventIds);
  if (!requestedIds) {
    res.status(400).json({ error: `eventIds must be 1–${MAX_EVENT_IDS} comma-separated event ids` });
    return;
  }

  const listed = await fetchPublicEvents();
  if (listed.status === "error") {
    res.status(502).json({ error: "Failed to load events" });
    return;
  }
  const listedIds = new Set(listed.events.map((event) => event.id));
  const eventIds = requestedIds.filter((id) => listedIds.has(id));

  const bookings = await approvedBookings(eventIds);
  if (bookings.error) {
    res.status(500).json({ error: "Failed to load venues" });
    return;
  }

  const venues = bookings.data.flatMap((row) => {
    const venue = Array.isArray(row.venues) ? row.venues[0] : row.venues;
    return venue ? [{ eventId: row.event_id, venueName: venue.name }] : [];
  });
  res.json({ venues });
});
