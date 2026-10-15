import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import {
  BOOKING_PLAN_COLUMNS,
  checkSuitability,
  effectivePlan,
  eventDefaults,
  holdsMainProgramme,
  type BookingPlanColumns,
} from "../lib/bookingPlan.js";
import type { BookingStatus } from "../lib/bookingStatus.js";
import { fetchEvent } from "../lib/eventsClient.js";
import type { VenueRow } from "../lib/venueSearch.js";

/**
 * E4-17: is each venue booking of an event suitable for what it's for?
 * Checking only — nothing here creates, changes or blocks a booking.
 *
 * Each booking is judged on its own purpose, headcount and requirements
 * (AC2–AC4), so an unsuitable breakout room never marks the event's other
 * bookings unsuitable. The response also carries the event's defaults,
 * which pre-fill the coordinator's "Plan a venue booking" form.
 *
 * Coordinator-only, like venue search and recommendations; events-service
 * still decides (via the forwarded token) whether the caller may see the event.
 */
export const suitabilityRouter = Router();

suitabilityRouter.use(requireAuth);

function requireCoordinator(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "coordinator") {
    res.status(403).json({ error: "Only coordinators can check venue suitability" });
    return;
  }
  next();
}

suitabilityRouter.use(requireCoordinator);

/** Bookings that still hold, or are still asking for, their venue. */
const LIVE_STATUSES: readonly BookingStatus[] = ["Requested", "On Hold", "Approved", "Replacement Required"];

const VENUE_COLUMNS = "id, name, location, description, capacity, accessibility, layouts, facilities";

type BookingRow = BookingPlanColumns & { id: number; venue_id: number; status: BookingStatus };

suitabilityRouter.get("/:eventId", async (req: AuthedRequest, res) => {
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

  const { data: bookingData, error: bookingsError } = await supabase
    .from("venue_bookings")
    .select(`id, venue_id, status, ${BOOKING_PLAN_COLUMNS}`)
    .eq("event_id", eventId)
    .order("created_at");
  if (bookingsError) {
    res.status(500).json({ error: "Failed to load the event's venue bookings" });
    return;
  }
  const bookings = (bookingData ?? []) as BookingRow[];

  // Every venue, not just Available ones: a booking's venue may have been
  // taken out of use since, and the event's free text is read against the
  // whole catalogue (as recommendations do).
  const { data: venueData, error: venuesError } = await supabase.from("venues").select(VENUE_COLUMNS);
  if (venuesError) {
    res.status(500).json({ error: "Failed to load venues" });
    return;
  }
  const venues = (venueData ?? []) as VenueRow[];
  const venuesById = new Map(venues.map((venue) => [venue.id, venue]));

  const defaults = eventDefaults(eventResult.event.submitted_details ?? {}, venues);

  res.json({
    defaults: {
      ...defaults,
      liveBookingCount: bookings.filter((b) => LIVE_STATUSES.includes(b.status)).length,
      // Team decision: the main programme is booked first, for everyone (AC6);
      // every later booking is for part of the event. A main venue that needs
      // replacing (or was withdrawn/rejected) no longer counts, so the
      // replacement is planned as the main programme again (E4-15).
      hasMainProgramme: holdsMainProgramme(bookings, defaults),
    },
    bookings: bookings.map((booking) => {
      const plan = effectivePlan(booking, defaults);
      const venue = venuesById.get(booking.venue_id);
      return {
        bookingId: booking.id,
        status: booking.status,
        purpose: plan.purpose,
        purposeDetail: plan.purposeDetail,
        headcount: plan.headcount,
        requirements: plan.requirements,
        // A venue deleted out from under the booking can't be judged.
        suitability: venue ? checkSuitability(venue, plan) : null,
      };
    }),
  });
});
