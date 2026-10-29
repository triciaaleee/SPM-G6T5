import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { BOOKING_STATUS } from "../lib/bookingStatus.js";
import { MAX_EVENT_IDS, parseEventIds } from "../lib/eventIds.js";

/**
 * E6: where an event is being held, for Attendees. Called by
 * registration-service with the attendee's own token.
 *
 * Deliberately its own router, mounted before venuesRouter (which is
 * coordinator-only for every path under it). It returns venue **names**
 * only, for `Approved` bookings only: no booking id, status, hold or
 * decision details, capacity, setup times or location notes. A requested or
 * held venue isn't confirmed, so an attendee isn't told about it.
 */
export const attendeeInfoRouter = Router();

attendeeInfoRouter.use(requireAuth);

interface BookingWithVenueName {
  event_id: number;
  venues: { name: string } | { name: string }[] | null;
}

// Stryker disable next-line StringLiteral: Express matches "" and "/" to the same route
attendeeInfoRouter.get("/", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;

  if (req.user?.role !== "attendee") {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const eventIds = parseEventIds(req.query.eventIds);
  if (!eventIds) {
    res.status(400).json({ error: `eventIds must be 1–${MAX_EVENT_IDS} comma-separated event ids` });
    return;
  }

  const { data, error } = await supabase
    .from("venue_bookings")
    .select("event_id, venues (name)")
    .in("event_id", eventIds)
    .eq("status", BOOKING_STATUS.approved);

  if (error) {
    res.status(500).json({ error: "Failed to load venues" });
    return;
  }

  const venues = ((data ?? []) as unknown as BookingWithVenueName[]).flatMap((row) => {
    const venue = Array.isArray(row.venues) ? row.venues[0] : row.venues;
    return venue ? [{ eventId: row.event_id, venueName: venue.name }] : [];
  });

  res.json({ venues });
});
