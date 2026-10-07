import { Router } from "express";
import type { NextFunction, Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { BOOKING_STATUS } from "../lib/bookingStatus.js";
import { fetchVenueBookingInfo } from "../lib/eventsClient.js";
import { sendNotifications, type NewNotification } from "../lib/notificationsClient.js";
import {
  PERIOD_COLUMNS,
  occupiedWindow,
  parsePeriodInput,
  periodBlocksSlot,
  toBuffers,
  toPeriod,
  type PeriodInput,
  type PeriodRow,
  type VenueBuffers,
} from "../lib/unavailability.js";
import { isRealDate } from "../lib/venueSearch.js";

/**
 * E4-3: venue staff block out periods when a venue can't be used.
 *
 * AC1 — a saved period is returned by GET for the schedule's calendar.
 * AC2 — live bookings (Requested or Approved) whose occupied window — the
 *        event's times widened by the venue's setup and turnaround — falls
 *        inside a new or edited period move to Replacement Required, and
 *        their coordinators are notified (via notification-service). The
 *        events themselves are never touched. POST /preview lists those
 *        bookings before anything is saved, so staff see the impact first.
 * AC3 — venue search excludes blocked venues (lib/unavailability.ts's
 *        findBlockedVenueIds, used by routes/venues.ts).
 */
export const unavailabilityRouter = Router();

unavailabilityRouter.use(requireAuth);

function requireVenueStaff(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== "venue_staff") {
    res.status(403).json({ error: "Only venue staff can manage venue unavailability" });
    return;
  }
  next();
}

unavailabilityRouter.use(requireVenueStaff);

const ID_PATTERN = /^[1-9]\d*$/;

/** Matches the staff schedule: a calendar month view spans at most six weeks. */
const MAX_RANGE_DAYS = 42;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Bookings a block-out can still affect. A pending request is caught as
 * well as an approved one — neither can be honoured once the venue is
 * blocked. Rejected and already-flagged bookings are left alone.
 */
const LIVE_BOOKING_STATUSES = [BOOKING_STATUS.requested, BOOKING_STATUS.approved];

type Supabase = NonNullable<AuthedRequest["supabase"]>;

interface Venue extends VenueBuffers {
  id: number;
  name: string;
}

/** A live booking the period would cut across. coordinatorId stays server-side. */
interface AffectedBooking {
  bookingId: number;
  status: string;
  eventId: number;
  eventName: string | null;
  date: string;
  startTime: string | null;
  endTime: string | null;
  /** The event's times widened by setup/turnaround — what the block was checked against. */
  occupiedStart: string | null;
  occupiedEnd: string | null;
  coordinatorId: string | null;
}

function readId(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  return ID_PATTERN.test(raw) ? Number(raw) : null;
}

async function loadActiveVenue(supabase: Supabase, venueId: number): Promise<{ venue: Venue | null; failed: boolean }> {
  const { data, error } = await supabase
    .from("venues")
    .select("id, name, setup_minutes, turnaround_minutes")
    .eq("id", venueId)
    .eq("active", true)
    .maybeSingle();
  if (error || !data) return { venue: null, failed: Boolean(error) };
  const row = data as { id: number; name: string; setup_minutes: number | null; turnaround_minutes: number | null };
  return { venue: { id: row.id, name: row.name, ...toBuffers(row) }, failed: false };
}

/**
 * Live bookings at the venue whose occupied window falls inside the
 * period. Each booking's date/time comes from its event (migration 0015),
 * so the overlap check happens here rather than in the query. Null when
 * either lookup fails.
 */
async function findAffectedBookings(
  supabase: Supabase,
  venue: Venue,
  period: PeriodInput,
  authorization: string,
): Promise<AffectedBooking[] | null> {
  const { data, error } = await supabase
    .from("venue_bookings")
    .select("id, event_id, status")
    .eq("venue_id", venue.id)
    .in("status", LIVE_BOOKING_STATUSES);
  if (error) return null;

  const bookings = (data ?? []) as { id: number; event_id: number; status: string }[];
  const infoResult = await fetchVenueBookingInfo(
    [...new Set(bookings.map((b) => b.event_id))],
    authorization,
  );
  if (infoResult.status === "error") return null;
  const eventsById = new Map(infoResult.events.map((event) => [event.id, event]));

  const affected: AffectedBooking[] = [];
  for (const booking of bookings) {
    const event = eventsById.get(booking.event_id);
    if (!event?.proposedDate) continue;
    const occupied = occupiedWindow(event.startTime, event.endTime, venue);
    if (!periodBlocksSlot(period, event.proposedDate, occupied.start, occupied.end)) continue;
    affected.push({
      bookingId: booking.id,
      status: booking.status,
      eventId: event.id,
      eventName: event.name,
      date: event.proposedDate,
      startTime: event.startTime,
      endTime: event.endTime,
      occupiedStart: occupied.start,
      occupiedEnd: occupied.end,
      coordinatorId: event.coordinatorId ?? null,
    });
  }
  return affected.sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? ""));
}

/** What venue staff see of an affected booking — no coordinator ids. */
function toPublicAffected({ coordinatorId, ...booking }: AffectedBooking) {
  return { ...booking, hasCoordinator: coordinatorId !== null };
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function describePeriod(period: PeriodInput): string {
  const days =
    period.startDate === period.endDate
      ? formatDate(period.startDate)
      : `${formatDate(period.startDate)} – ${formatDate(period.endDate)}`;
  return period.allDay ? `${days} (all day)` : `${days}, ${period.startTime}–${period.endTime}`;
}

function buildNotification(venue: Venue, period: PeriodInput, booking: AffectedBooking): NewNotification | null {
  if (!booking.coordinatorId) return null;
  const eventName = booking.eventName || "Your event";
  return {
    recipientId: booking.coordinatorId,
    type: "venue_unavailable",
    title: `Alternative venue needed for ${eventName}`,
    body:
      `${venue.name} is unavailable ${describePeriod(period)}: ${period.reason}. ` +
      `${eventName} on ${formatDate(booking.date)} needs a replacement venue.`,
    link: `/events/${booking.eventId}`,
  };
}

/**
 * AC2, after a period is saved: flag the affected bookings and tell their
 * coordinators. Only the booking's own status changes — the event record is
 * preserved. Re-checking the live statuses keeps a booking decided in the
 * meantime from being overwritten. Resolves false if the flagging failed.
 */
async function flagAndNotify(
  supabase: Supabase,
  venue: Venue,
  period: PeriodInput,
  affected: AffectedBooking[],
  authorization: string,
): Promise<{ flagged: boolean; coordinatorsNotified: number; notificationsFailed: boolean }> {
  if (affected.length > 0) {
    const { error } = await supabase
      .from("venue_bookings")
      .update({ status: BOOKING_STATUS.replacementRequired })
      .in(
        "id",
        affected.map((b) => b.bookingId),
      )
      .in("status", LIVE_BOOKING_STATUSES);
    if (error) return { flagged: false, coordinatorsNotified: 0, notificationsFailed: false };
  }

  const notifications = affected
    .map((booking) => buildNotification(venue, period, booking))
    .filter((n): n is NewNotification => n !== null);
  const sent = await sendNotifications(notifications, authorization);
  return {
    flagged: true,
    coordinatorsNotified: sent ? new Set(notifications.map((n) => n.recipientId)).size : 0,
    notificationsFailed: !sent,
  };
}

function toRow(period: PeriodInput) {
  return {
    start_date: period.startDate,
    end_date: period.endDate,
    all_day: period.allDay,
    start_time: period.startTime,
    end_time: period.endTime,
    reason: period.reason,
  };
}

function invalid(res: Response, fields: Record<string, string>): void {
  res.status(400).json({ error: "Invalid block-out period", fields });
}

/** AC1: periods at one venue overlapping `from`..`to` (inclusive local dates), earliest first. */
unavailabilityRouter.get("/", async (req: AuthedRequest, res) => {
  const venueId = readId(req.query.venueId);
  const from = typeof req.query.from === "string" ? req.query.from : "";
  const to = typeof req.query.to === "string" ? req.query.to : "";

  const fields: Record<string, string> = {};
  if (venueId === null) fields.venueId = "Pick a venue.";
  if (!isRealDate(from)) fields.from = "Enter a valid date (YYYY-MM-DD).";
  if (!isRealDate(to)) fields.to = "Enter a valid date (YYYY-MM-DD).";
  if (!fields.from && !fields.to) {
    const days = (Date.parse(to) - Date.parse(from)) / DAY_MS;
    if (days < 0) fields.to = "The end date must not be before the start date.";
    else if (days >= MAX_RANGE_DAYS) fields.to = `The range can cover at most ${MAX_RANGE_DAYS} days.`;
  }
  if (Object.keys(fields).length > 0) {
    res.status(400).json({ error: "Invalid request", fields });
    return;
  }

  const { data, error } = await req
    .supabase!.from("venue_unavailability")
    .select(PERIOD_COLUMNS)
    .eq("venue_id", venueId!)
    .lte("start_date", to)
    .gte("end_date", from)
    .order("start_date")
    .order("start_time", { nullsFirst: true });

  if (error) {
    res.status(500).json({ error: "Failed to load unavailability" });
    return;
  }

  res.json({ periods: ((data ?? []) as PeriodRow[]).map(toPeriod) });
});

/** AC2, before saving: which live bookings this period would affect. Nothing is written. */
unavailabilityRouter.post("/preview", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;
  const venueId = readId(req.body?.venueId);
  const parsed = parsePeriodInput(req.body);

  if (venueId === null || !parsed.valid) {
    const fields = parsed.valid ? {} : parsed.fields;
    if (venueId === null) fields.venueId = "Pick a venue.";
    invalid(res, fields);
    return;
  }

  const { venue, failed } = await loadActiveVenue(supabase, venueId);
  if (failed) {
    res.status(500).json({ error: "Failed to load the venue" });
    return;
  }
  if (!venue) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  const affected = await findAffectedBookings(supabase, venue, parsed.period, req.headers.authorization!);
  if (affected === null) {
    res.status(502).json({ error: "Failed to check this venue's bookings" });
    return;
  }

  res.json({
    affected: affected.map(toPublicAffected),
    setupMinutes: venue.setupMinutes,
    turnaroundMinutes: venue.turnaroundMinutes,
  });
});

/** AC1 + AC2: save a new period, flag affected bookings and notify their coordinators. */
unavailabilityRouter.post("/", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;
  const venueId = readId(req.body?.venueId);
  const parsed = parsePeriodInput(req.body);

  if (venueId === null || !parsed.valid) {
    const fields = parsed.valid ? {} : parsed.fields;
    if (venueId === null) fields.venueId = "Pick a venue.";
    invalid(res, fields);
    return;
  }
  const period = parsed.period;

  const { venue, failed } = await loadActiveVenue(supabase, venueId);
  if (failed) {
    res.status(500).json({ error: "Failed to load the venue" });
    return;
  }
  if (!venue) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  // Checked before saving: if the affected bookings can't be worked out,
  // saving would block the venue without telling anyone who's booked it.
  const affected = await findAffectedBookings(supabase, venue, period, req.headers.authorization!);
  if (affected === null) {
    res.status(502).json({ error: "Failed to check this venue's bookings" });
    return;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("venue_unavailability")
    .insert({ venue_id: venue.id, ...toRow(period), created_by: req.user!.id })
    .select(PERIOD_COLUMNS)
    .single();

  if (insertError || !inserted) {
    res.status(500).json({ error: "Failed to save the block-out period" });
    return;
  }

  const outcome = await flagAndNotify(supabase, venue, period, affected, req.headers.authorization!);
  if (!outcome.flagged) {
    res.status(500).json({
      error: "The period was saved, but the affected bookings couldn't be flagged. Please try again.",
      period: toPeriod(inserted as PeriodRow),
    });
    return;
  }

  res.status(201).json({
    period: toPeriod(inserted as PeriodRow),
    affected: affected.map(toPublicAffected),
    coordinatorsNotified: outcome.coordinatorsNotified,
    notificationsFailed: outcome.notificationsFailed,
  });
});

/**
 * Edit a period. Bookings the new dates/hours newly cut across are flagged
 * and notified just like on create; ones already flagged stay flagged.
 */
unavailabilityRouter.put("/:id", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;
  const id = readId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid period id" });
    return;
  }

  const parsed = parsePeriodInput(req.body);
  if (!parsed.valid) {
    invalid(res, parsed.fields);
    return;
  }
  const period = parsed.period;

  const { data: existing, error: existingError } = await supabase
    .from("venue_unavailability")
    .select("id, venue_id")
    .eq("id", id)
    .maybeSingle();
  if (existingError) {
    res.status(500).json({ error: "Failed to load the block-out period" });
    return;
  }
  if (!existing) {
    res.status(404).json({ error: "Block-out period not found" });
    return;
  }

  // A period stays with its venue; moving a block to another venue is a
  // remove plus a new block-out.
  const { venue, failed } = await loadActiveVenue(supabase, (existing as { venue_id: number }).venue_id);
  if (failed) {
    res.status(500).json({ error: "Failed to load the venue" });
    return;
  }
  if (!venue) {
    res.status(404).json({ error: "Venue not found" });
    return;
  }

  const affected = await findAffectedBookings(supabase, venue, period, req.headers.authorization!);
  if (affected === null) {
    res.status(502).json({ error: "Failed to check this venue's bookings" });
    return;
  }

  const { data: updated, error: updateError } = await supabase
    .from("venue_unavailability")
    .update(toRow(period))
    .eq("id", id)
    .select(PERIOD_COLUMNS)
    .single();

  if (updateError || !updated) {
    res.status(500).json({ error: "Failed to save the block-out period" });
    return;
  }

  const outcome = await flagAndNotify(supabase, venue, period, affected, req.headers.authorization!);
  if (!outcome.flagged) {
    res.status(500).json({
      error: "The period was saved, but the affected bookings couldn't be flagged. Please try again.",
      period: toPeriod(updated as PeriodRow),
    });
    return;
  }

  res.json({
    period: toPeriod(updated as PeriodRow),
    affected: affected.map(toPublicAffected),
    coordinatorsNotified: outcome.coordinatorsNotified,
    notificationsFailed: outcome.notificationsFailed,
  });
});

/**
 * Lift a block-out. Bookings already moved to Replacement Required stay
 * there: their coordinators may already be rebooking elsewhere.
 */
unavailabilityRouter.delete("/:id", async (req: AuthedRequest, res) => {
  const id = readId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid period id" });
    return;
  }

  const { data, error } = await req
    .supabase!.from("venue_unavailability")
    .delete()
    .eq("id", id)
    .select("id");

  if (error) {
    res.status(500).json({ error: "Failed to remove the block-out period" });
    return;
  }
  if (!data || data.length === 0) {
    res.status(404).json({ error: "Block-out period not found" });
    return;
  }

  res.status(204).end();
});
