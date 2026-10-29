import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import { requireAuthOrInternal } from "../../middleware/auth.js";
import { requireInternal } from "../../middleware/internal.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { EVENT_STATUS } from "../../lib/eventStatus.js";
import { getPublisher } from "../../lib/rabbitPublisher.js";
import { recordAccessDenial, EVENT_COLUMNS, type AssignmentEventRow, eventDisplayName } from "./shared.js";

/**
 * Routes other services call, mounted ahead of requireAuth: event timing and
 * status for venue- and equipment-service, and their reports of a lost venue or
 * equipment arrangement.
 */

export const internalRouter = Router();

// Mounted ahead of eventsRouter's blanket requireAuth: venue-service's
// scheduled expiring-hold sweep (#106 row 4b) has no end-user token to
// forward, so this one route accepts an internal token too. Every other
// route keeps requireAuth only.
internalRouter.get("/venue-booking-info", requireAuthOrInternal, venueBookingInfoHandler);

// venue-service and equipment-service tell us an arrangement the event was
// approved on was lost (see arrangementsChangedHandler). Internal callers only.
internalRouter.post("/:id/arrangements-changed", requireInternal, arrangementsChangedHandler);

/**
 * E1-5: the only fields venue staff may see about an event — what they need
 * to set the venue up. Everything else in submitted_details (purpose,
 * description) and on the row (organiser, coordinator, review outcome) is
 * left out, and clarifications/history are never joined in. The free-text
 * requirement fields are included because venue-service reads layout and
 * facility needs out of them; it drops the text before replying to the
 * browser.
 *
 * E5-1: equipment-service reuses this same batch lookup for Technical
 * Support's equipment request list — it needs exactly the same shape
 * (event name/date/time, plus the Organiser's original equipment note as
 * AC2's reference text), so technical_support is included below rather
 * than standing up a near-duplicate endpoint.
 */

/* Zo note: built a new endpoint instead of just using the existing one but only extracting the needed info for venue because of security purposes. This is more secure compared to using the existing one to fetch and filter.
 */
const VENUE_BOOKING_INFO_FIELDS = [
  "name",
  "proposedDate",
  "startTime",
  "endTime",
  "expectedAttendance",
  "venue",
  "accessibility",
  "equipment",
  "technicalSupport",
] as const;

const MAX_VENUE_BOOKING_INFO_IDS = 100;

const VENUE_BOOKING_INFO_ROLES = new Set(["venue_staff", "coordinator", "technical_support"]);

/**
 * E1-5: booking-relevant info for the events booked at a venue, called by
 * venue-service with the caller's own token. venue_bookings only links a
 * venue to an event, so the event is where a booking's date and times
 * live: venue staff need them for their schedule, and coordinators for
 * venue availability in search/recommendations (coordinators already see
 * every event in full, so this exposes nothing new to them). Declared
 * before GET /:id so "venue-booking-info" isn't
 * read as an event id. Drafts are never returned: a draft can't have been
 * booked, and it isn't anyone's business but the organiser's.
 */
/**
 * A hoisted function declaration (not registered inline) so it can be
 * referenced by the early, internal-auth-aware route registration above
 * requireAuth — see the comment there. `user` is absent for a trusted
 * internal caller (venue-service's sweep); that skips the role check
 * entirely rather than rejecting it, same reasoning as user-service's
 * requireAuthOrInternal routes.
 */
async function venueBookingInfoHandler(req: AuthedRequest, res: Response): Promise<void> {
  const { supabase, user } = req;
  if (!supabase) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const rawIds = typeof req.query.ids === "string" ? req.query.ids : "";

  if (user && !VENUE_BOOKING_INFO_ROLES.has(user.role)) {
    await recordAccessDenial(supabase, user.id, rawIds, "venue_booking_info_role_not_allowed");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const idStrings = rawIds.split(",").map((id) => id.trim());
  if (rawIds === "" || !idStrings.every(isPositiveInteger) || idStrings.length > MAX_VENUE_BOOKING_INFO_IDS) {
    res.status(400).json({ error: `ids must be 1–${MAX_VENUE_BOOKING_INFO_IDS} comma-separated event ids` });
    return;
  }
  const ids = [...new Set(idStrings.map(Number))];

  const { data, error } = await supabase
    .from("events")
    .select("id, status, submitted_details, coordinator_id")
    .in("id", ids)
    .neq("status", "Draft");

  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  // The lifecycle status rides along because venue-service needs it to
  // decide on a booking (E4-10 AC2: a venue can only be held or approved
  // while the event is still in "Planning"). Venue staff can't call
  // GET /:id — it is owner-or-coordinator only — and the status says
  // nothing about the event's content, so it belongs in this narrow view
  // rather than widening that one.
  const events = (data ?? []).map((row) => {
    const details = (row.submitted_details ?? {}) as Record<string, unknown>;
    // E4-3: venue-service needs the assigned coordinator's id (only the id,
    // never their name or contact details) to tell them a blocked-out
    // venue means their booking needs a replacement.
    const info: Record<string, unknown> = {
      id: row.id,
      status: row.status,
      coordinatorId: row.coordinator_id ?? null,
    };
    for (const field of VENUE_BOOKING_INFO_FIELDS) info[field] = details[field] ?? null;
    return info;
  });

  res.json({ events });
}

/**
 * venue-service / equipment-service: an arrangement the event relied on is
 * gone (a booking became Replacement Required, a reserved unit became
 * unusable). Internal callers only. Confirmed -> Needs Review; Safety
 * Review -> Planning; an event already in Needs Review just has its safety
 * approval marked stale. Any other status needs nothing: Planning is being
 * arranged anyway and the rest are closed or not yet approved. Idempotent,
 * so a repeat call after the event has moved is a harmless no-op.
 */
async function arrangementsChangedHandler(req: AuthedRequest, res: Response): Promise<void> {
  // Loaded on use: this is the one route with no end-user request to carry a client.
  const { supabaseAdmin: supabase } = await import("../../lib/supabaseAdmin.js");
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "A reason is required" });
    return;
  }

  const { data: event, error } = await supabase
    .from("events")
    .select(`${EVENT_COLUMNS}, organiser_id`)
    .eq("id", Number(eventId))
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const row = event as unknown as AssignmentEventRow & { status: string; coordinator_id: string | null; organiser_id: string | null };
  const from = row.status;
  let to: string | null = null;
  if (from === EVENT_STATUS.Confirmed) to = EVENT_STATUS.NeedsReview;
  else if (from === EVENT_STATUS.SafetyReview) to = EVENT_STATUS.Planning;
  else if (from === EVENT_STATUS.NeedsReview) to = EVENT_STATUS.NeedsReview;

  if (to === null) {
    res.json({ changed: false, status: from });
    return;
  }

  const { data: updated, error: updateError } = await supabase
    .from("events")
    .update({ status: to, safety_approval_stale: true })
    .eq("id", row.id)
    .eq("status", from)
    .select("id");
  if (updateError) {
    res.status(500).json({ error: "Failed to update the event" });
    return;
  }
  if ((updated ?? []).length === 0) {
    res.status(409).json({ error: "The event changed status; try again" });
    return;
  }

  if (to === from) {
    res.json({ changed: false, status: to });
    return;
  }

  const eventName = eventDisplayName(row);
  const userIds = [row.coordinator_id, row.organiser_id].filter((id): id is string => Boolean(id));
  const fromSafety = from === EVENT_STATUS.SafetyReview;
  const published = await getPublisher().publish({
    type: fromSafety ? "event.returned_to_planning" : "event.needs_review",
    eventId: row.id,
    actorId: null,
    recipients: { userIds, roles: fromSafety ? ["safety_officer"] : [] },
    data: { eventName, reason },
  });

  res.json({ changed: true, status: to, notificationsFailed: !published });
}
