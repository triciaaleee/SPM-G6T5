import { Router } from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { BOOKING_STATUS } from "../lib/bookingStatus.js";
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
const MAX_EVENT_IDS = 100;

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

function startsAt(event: PublicEvent): string {
  return `${event.proposedDate ?? "9999-12-31"}T${event.startTime ?? "00:00"}`;
}

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
    const event = eventById.get(booking.event_id);
    if (!event) continue;
    const list = eventsByVenue.get(booking.venue_id) ?? [];
    if (!list.some((e) => e.id === event.id)) list.push(event);
    eventsByVenue.set(booking.venue_id, list);
  }

  res.json({
    venues: (venues ?? []).map((venue) => ({
      ...venue,
      upcomingEvents: (eventsByVenue.get(venue.id) ?? [])
        .sort((a, b) => startsAt(a).localeCompare(startsAt(b)))
        .map(({ id, name, proposedDate, startTime }) => ({ id, name, proposedDate, startTime })),
    })),
  });
});

publicVenuesRouter.get("/event-venues", async (req, res) => {
  const rawIds = typeof req.query.eventIds === "string" ? req.query.eventIds : "";
  const idStrings = rawIds.split(",").map((id) => id.trim());
  if (rawIds === "" || !idStrings.every((id) => /^[1-9]\d*$/.test(id)) || idStrings.length > MAX_EVENT_IDS) {
    res.status(400).json({ error: `eventIds must be 1–${MAX_EVENT_IDS} comma-separated event ids` });
    return;
  }

  const listed = await fetchPublicEvents();
  if (listed.status === "error") {
    res.status(502).json({ error: "Failed to load events" });
    return;
  }
  const listedIds = new Set(listed.events.map((event) => event.id));
  const eventIds = [...new Set(idStrings.map(Number))].filter((id) => listedIds.has(id));

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
