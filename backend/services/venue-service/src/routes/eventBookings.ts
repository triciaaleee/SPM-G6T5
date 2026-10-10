import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { BookingStatus } from "../lib/bookingStatus.js";
import { fetchEvent } from "../lib/eventsClient.js";

/**
 * One event's venue bookings and the state each is in (E4-8 AC5), and the
 * venue half of "which arrangements are outstanding" (E3-1 AC3).
 *
 * Deliberately not on venuesRouter: that router is coordinator-only, and
 * E3-1 is an **organiser's** story — they must be able to see whether their
 * own event has a venue. Access is delegated to events-service instead of
 * being decided here: the caller's own token is forwarded to
 * GET /api/events/:id, which admits the owning organiser or a coordinator
 * and refuses everyone else. Whoever may see the event may see where its
 * venue stands. That includes the Safety Officer while the event awaits
 * its Operational Safety Check (E1-10 AC2), who also needs each venue's
 * capacity and layouts — hence those two on the venue.
 */
export const eventBookingsRouter = Router();

eventBookingsRouter.use(requireAuth);

interface VenueSummary {
  id: number;
  name: string;
  location: string;
  capacity: number;
  /** The seating/room layouts the venue supports. */
  layouts: string[];
}

// supabase-js types an embedded table as an array even for a to-one
// relationship, so normalise to the single venue the foreign key gives.
interface BookingWithVenue {
  id: number;
  status: BookingStatus;
  hold_expires_at: string | null;
  decision_reason: string | null;
  created_at: string;
  venues: VenueSummary | VenueSummary[] | null;
}

eventBookingsRouter.get("/:eventId/bookings", async (req: AuthedRequest, res) => {
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

  const { data, error } = await supabase
    .from("venue_bookings")
    .select("id, status, hold_expires_at, decision_reason, created_at, venues (id, name, location, capacity, layouts)")
    .eq("event_id", eventId)
    .order("created_at");
  if (error) {
    res.status(500).json({ error: "Failed to load the event's venue requests" });
    return;
  }

  res.json({
    bookings: ((data ?? []) as unknown as BookingWithVenue[]).map((row) => ({
      id: row.id,
      status: row.status,
      holdExpiresAt: row.hold_expires_at,
      // E4-10 AC4: why Venue Staff refused it — the coordinator is told.
      decisionReason: row.decision_reason,
      createdAt: row.created_at,
      venue: Array.isArray(row.venues) ? (row.venues[0] ?? null) : row.venues,
    })),
  });
});
