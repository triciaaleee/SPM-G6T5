import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
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

interface BookingRow {
  id: number;
  event_id: number;
  /** venue_status — e.g. Replacement Required after a block-out (E4-3). */
  status: string;
}

/** Times may arrive as "HH:MM:SS"; the UI shows "HH:MM". */
function toHourMinute(time: string | null): string {
  return (time ?? "").slice(0, 5);
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
 * Every booking at one venue between `from` and `to` (inclusive, local
 * "YYYY-MM-DD" dates), earliest first. Every booking is tied to an event
 * (migration 0015) and carries that event's booking-relevant details.
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

  // venue_bookings no longer stores its own timing (migration 0015): each
  // booking's date/time comes from its linked event, so the range filter and
  // sort happen here rather than in the query.
  const { data: bookingData, error: bookingsError } = await supabase
    .from("venue_bookings")
    .select("id, event_id, status")
    .eq("venue_id", venue.id);

  if (bookingsError) {
    res.status(500).json({ error: "Failed to load bookings" });
    return;
  }
  const bookingRows = (bookingData ?? []) as BookingRow[];

  const eventIds = [...new Set(bookingRows.map((b) => b.event_id))];
  const infoResult = await fetchVenueBookingInfo(eventIds, req.headers.authorization!);
  if (infoResult.status === "error") {
    res.status(502).json({ error: "Failed to load the booked events" });
    return;
  }
  const eventsById = new Map(infoResult.events.map((event) => [event.id, event]));

  // Events events-service didn't return (e.g. still a draft) or with no
  // proposed date can't be placed on the schedule, so they're left out.
  const bookings = bookingRows
    .flatMap((booking) => {
      const event = eventsById.get(booking.event_id);
      if (!event?.proposedDate || event.proposedDate < from || event.proposedDate > to) return [];
      return [{ booking, event, date: event.proposedDate, startTime: toHourMinute(event.startTime) }];
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));

  res.json({
    venue: { id: venue.id, name: venue.name },
    bookings: bookings.map(({ booking, event, date, startTime }) => ({
      id: booking.id,
      date,
      startTime,
      endTime: toHourMinute(event.endTime),
      status: booking.status,
      kind: "event",
      event: {
        id: event.id,
        name: event.name,
        expectedAttendance: event.expectedAttendance,
        ...extractLayoutAndFacilities(event, [venue as VenueRow]),
      },
    })),
  });
});
