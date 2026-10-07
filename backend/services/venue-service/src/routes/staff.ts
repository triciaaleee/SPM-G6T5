import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import type { BookingStatus } from "../lib/bookingStatus.js";
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

/** A venue_bookings row: a venue-to-event link plus its approval status (venue_status enum). */
interface BookingRow {
  id: number;
  event_id: number;
  status: BookingStatus;
}

/** Active venues for the schedule's venue picker. */
staffRouter.get("/venues", async (req: AuthedRequest, res) => {
  const { data, error } = await req.supabase!.from("venues").select("id, name").eq("active", true).order("name");

  if (error) {
    res.status(500).json({ error: "Failed to load venues" });
    return;
  }

  res.json({ venues: data ?? [] });
});

/**
 * Every booking at one venue whose event falls between `from` and `to`
 * (inclusive, local "YYYY-MM-DD" dates), earliest first. venue_bookings
 * only links a venue to an event, so a booking's date and times are the
 * event's own, from events-service. Bookings whose event events-service
 * doesn't return (deleted, or still a draft) are left out: there's
 * nothing to set up for them.
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
    .select("id, name, location, description, capacity, accessibility, layouts, facilities")
    .eq("id", Number(rawId))
    .eq("active", true)
    .maybeSingle();

  if (venueError) {
    res.status(500).json({ error: "Failed to load the venue" });
    return;
  }
  if (!venue) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  const { data: bookingData, error: bookingsError } = await supabase
    .from("venue_bookings")
    .select("id, event_id, status")
    .eq("venue_id", venue.id);

  if (bookingsError) {
    res.status(500).json({ error: "Failed to load bookings" });
    return;
  }
  const bookings = (bookingData ?? []) as BookingRow[];

  const eventIds = [...new Set(bookings.map((b) => b.event_id))];
  const infoResult = await fetchVenueBookingInfo(eventIds, req.headers.authorization!);
  if (infoResult.status === "error") {
    res.status(502).json({ error: "Failed to load the booked events" });
    return;
  }
  const eventsById = new Map(infoResult.events.map((event) => [event.id, event]));

  // Pair each booking with its event, keep those in range, earliest first.
  const scheduled = bookings
    .flatMap((booking) => {
      const event = eventsById.get(booking.event_id);
      const inRange = event?.proposedDate && event.proposedDate >= from && event.proposedDate <= to;
      return event && inRange ? [{ booking, event }] : [];
    })
    .sort(
      (a, b) =>
        a.event.proposedDate!.localeCompare(b.event.proposedDate!) ||
        (a.event.startTime ?? "").localeCompare(b.event.startTime ?? ""),
    );

  res.json({
    venue: { id: venue.id, name: venue.name },
    bookings: scheduled.map(({ booking, event }) => ({
      id: booking.id,
      date: event.proposedDate,
      startTime: event.startTime,
      endTime: event.endTime,
      status: booking.status,
      event: {
        id: event.id,
        name: event.name,
        expectedAttendance: event.expectedAttendance,
        ...extractLayoutAndFacilities(event, [venue as VenueRow]),
      },
    })),
  });
});
