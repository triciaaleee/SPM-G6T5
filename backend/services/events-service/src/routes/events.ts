import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { normaliseDraftEventRequest, validateEventRequest } from "../lib/validateEventRequest.js";
import { isPositiveInteger } from "../lib/validation.js";
import { diffSubmittedDetails, diffSubmittedDetailsStructured } from "../lib/diffSubmittedDetails.js";
import { CLOSED_EVENT_STATUSES, EVENT_STATUS } from "../lib/eventStatus.js";
import { fitNotificationBody, sendNotifications, type NewNotification } from "../lib/notificationsClient.js";
import { fetchCoordinatorLeads, fetchCoordinators } from "../lib/usersClient.js";
import { fetchEventEquipmentRequests, fetchEventVenueBookings } from "../lib/arrangementsClient.js";
import {
  describeOutstanding,
  findOutstandingArrangements,
  hasOutstanding,
  MAX_SAFETY_DECISION_REASON_LENGTH,
  parseSafetyNotes,
} from "../lib/safetyReview.js";

/**
 * Week 7 change 5: the Event Coordinator Lead oversees incoming requests,
 * assigns them (E2-13) and reassigns them (E2-12). Read-only on the event
 * itself: the Lead never edits, approves or rejects (E1-8 AC2).
 */
const COORDINATOR_LEAD_ROLE = "coordinator_lead";

async function recordAccessDenial(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  userId: string,
  eventId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from("access_denials")
    .insert({ user_id: userId, event_id: eventId, reason });

  if (error) {
    console.error("Failed to record access_denials row", { userId, eventId, reason, error });
  }
}

/**
 * E2-7 AC3: writes one event_history row per changed field. Best-effort —
 * the submitted_details update above is what actually matters, so a
 * failure here is logged, not fatal to the request.
 */
async function recordEventHistory(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  eventId: number,
  changes: { field: string; oldValue: string | null; newValue: string }[],
  changedBy: string,
): Promise<void> {
  if (changes.length === 0) return;

  const { error } = await supabase.from("event_history").insert(
    changes.map((change) => ({
      event_id: eventId,
      field: change.field,
      old_value: change.oldValue,
      new_value: change.newValue,
      changed_by: changedBy,
    })),
  );

  if (error) {
    console.error("Failed to record event_history rows", { eventId, changedBy, error });
  }
}

/**
 * E2-14: a newly-unassigned request waits in the Lead's queue (E1-8) until
 * assigned (E2-13) — notify every Lead so they know there's something to
 * triage. Best-effort: a notification failure never blocks the submission
 * that already committed.
 */
async function notifyCoordinatorLeads(
  authorization: string,
  eventId: number,
  eventName: string,
): Promise<void> {
  const leads = await fetchCoordinatorLeads(authorization);
  if (leads.status === "error" || leads.coordinators.length === 0) return;

  await sendNotifications(
    leads.coordinators.map((lead) => ({
      recipientId: lead.id,
      type: "event_unassigned",
      title: "New request in the unassigned queue",
      body: `"${eventName}" needs a coordinator assigned.`,
      link: `/events/${eventId}`,
    })),
    authorization,
  );
}

export const eventsRouter = Router();

eventsRouter.use(requireAuth);

/**
 * E1-4.2: shared column list for every route that returns an event to the
 * client, including decided_at/decided_by so the Organiser can see who
 * decided and when (AC4) — created_at is submission time, not decision
 * time. E2-6 AC2: `coordinator:coordinator_id(name)` embeds the assigned
 * coordinator's display name via the FK on events.coordinator_id (added
 * in migration 0004), so the frontend can show a name instead of a raw
 * id — coordinator_id itself is kept too, since other logic (e.g. "is the
 * viewer the assigned coordinator?") needs the id, not the name.
 * `organiser:organiser_id(name)` embeds the requester's name the same way,
 * for the "Event Requestor" field on the detail view.
 */
const EVENT_COLUMNS =
  "id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at";

/**
 * E2-1: submit a new event request. Validates the mandatory fields per the
 * story's acceptance criteria, then inserts. Authorization is enforced
 * here in application code — the service-role client bypasses RLS, so
 * organiser_id is always set from the verified JWT's subject, never
 * trusted from the request body.
 *
 * E2-14: every submitted request enters the unassigned queue (E1-8) with
 * no coordinator — replaces E2-6's round-robin auto-assignment, which used
 * to set the request straight to "Requested". The Event Coordinator Lead
 * assigns it from the queue instead (E2-13), and is notified here so they
 * know there's something to triage. Restricted to organisers: notifying
 * the Lead means events-service must resolve Lead ids from user-service
 * using the submitter's own token, and user-service only grants that
 * lookup to the organiser role (see LISTABLE_ROLES_BY_CALLER in
 * user-service's users.ts).
 */
eventsRouter.post("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (user.role === "attendee") {
    res.status(403).json({ error: "Attendees cannot manage events" });
    return;
  }

  if (user.role !== "organiser") {
    res.status(403).json({ error: "Only organisers can submit event requests" });
    return;
  }

  const result = validateEventRequest(req.body ?? {});
  if (!result.valid) {
    res.status(400).json({ error: "Validation failed", fields: result.fields });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .insert({
      organiser_id: user.id,
      status: EVENT_STATUS.Unassigned,
      coordinator_id: null,
      submitted_details: result.value,
    })
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to submit event request" });
    return;
  }

  await notifyCoordinatorLeads(
    req.headers.authorization!,
    data.id,
    eventDisplayName(data as unknown as AssignmentEventRow),
  );

  res.status(201).json({ event: data, message: "Your event request has been submitted." });
});

/**
 * E2-4 AC1: save a new draft. Skips E2-1's validation entirely — a draft
 * may be missing any or all of its mandatory fields — and never assigns a
 * coordinator, since a draft hasn't reached the review pipeline yet.
 */
eventsRouter.post("/draft", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (user.role === "attendee") {
    res.status(403).json({ error: "Attendees cannot manage events" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .insert({
      organiser_id: user.id,
      status: "Draft",
      submitted_details: normaliseDraftEventRequest(req.body ?? {}),
    })
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to save draft" });
    return;
  }

  res.status(201).json({ event: data });
});

/**
 * E2-4 AC1/AC2: save progress on an existing draft without submitting it —
 * same relaxed validation as creating one. Only the owning organiser may
 * update it, and only while it's still a draft (once submitted, further
 * changes go through the normal PATCH /:id edit rules instead).
 */
eventsRouter.patch("/:id/draft", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { data: existing, error: fetchError } = await supabase
    .from("events")
    .select("id, status, organiser_id")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (fetchError) {
    res.status(500).json({ error: "Failed to load draft" });
    return;
  }

  if (!existing || existing.organiser_id !== user.id) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (existing.status !== "Draft") {
    res.status(409).json({ error: "This request is no longer a draft" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .update({ submitted_details: normaliseDraftEventRequest(req.body ?? {}) })
    .eq("id", existing.id)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to save draft" });
    return;
  }

  res.json({ event: data });
});

/**
 * E2-5.2 AC1: delete a draft. Same ownership/status guard as the draft
 * PATCH above — only the owning organiser, and only while it's still a
 * draft (a submitted request isn't deletable through this route).
 */
eventsRouter.delete("/:id/draft", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { data: existing, error: fetchError } = await supabase
    .from("events")
    .select("id, status, organiser_id")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (fetchError) {
    res.status(500).json({ error: "Failed to load draft" });
    return;
  }

  if (!existing || existing.organiser_id !== user.id) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (existing.status !== "Draft") {
    res.status(409).json({ error: "This request is no longer a draft" });
    return;
  }

  const { error } = await supabase.from("events").delete().eq("id", existing.id);

  if (error) {
    res.status(500).json({ error: "Failed to delete draft" });
    return;
  }

  res.status(204).send();
});

/**
 * List events. Coordinators get full pipeline visibility (all events) but
 * never see drafts — a draft hasn't been submitted, so it's not yet part
 * of the review pipeline (E2-5.1 AC2). The Event Coordinator Lead sees the
 * same set: change 5 has the Lead view every coordinator assignment and
 * active event. Everyone else sees only events they organised, drafts
 * included (E2-5.1 AC1 relies on the Organiser's own list containing
 * both). Since the service-role client bypasses RLS, this filter is the
 * actual enforcement, not just defense-in-depth.
 */
eventsRouter.get("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (user.role === "attendee") {
    res.status(403).json({ error: "Attendees cannot manage events" });
    return;
  }

  let query = supabase.from("events").select(EVENT_COLUMNS);

  if (user.role !== "coordinator" && user.role !== COORDINATOR_LEAD_ROLE) {
    query = query.eq("organiser_id", user.id);
  } else {
    query = query.neq("status", "Draft");
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  res.json({ events: data });
});

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
eventsRouter.get("/venue-booking-info", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const rawIds = typeof req.query.ids === "string" ? req.query.ids : "";

  if (!VENUE_BOOKING_INFO_ROLES.has(user.role)) {
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
});

/**
 * E6: the only fields an Attendee may see about an event — what is safe to
 * show someone who is not part of the planning. Built as a whitelist, never
 * by filtering a fuller object, so a field added to submitted_details later
 * stays private until it is listed here. No organiser, coordinator, purpose,
 * equipment, accessibility, review outcome, history or clarifications.
 */
const ATTENDEE_INFO_FIELDS = ["name", "description", "proposedDate", "startTime", "endTime"] as const;

/** Whole-field answers that mean "nothing to note" (same list venue-service uses for requirements). */
const NO_ACCESSIBILITY_INFO_PATTERN =
  /^(n\/?a|nil|none|no|nope|-+|not applicable|no preference|no requirements?|not required|not needed)\.?$/i;

/**
 * The organiser's accessibility note, as written, for attendees. Blank or a
 * "NA"/"None" style answer is no note at all, so the card shows nothing
 * rather than "None".
 */
function attendeeAccessibility(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" || NO_ACCESSIBILITY_INFO_PATTERN.test(text) ? null : text;
}

const MAX_ATTENDEE_INFO_IDS = 100;

/**
 * "Open for registration": the event is Confirmed (safety-approved, so it
 * will go ahead), the organiser asked for registration, and it hasn't
 * ended yet. Lives here, with the event data, so registration-service
 * doesn't re-derive it. Date/time are the event's local wall-clock values.
 */
function isOpenForRegistration(status: string, details: Record<string, unknown>, now: Date = new Date()): boolean {
  if (status !== "Confirmed" || details.registrationNeeded !== true) return false;

  const date = typeof details.proposedDate === "string" ? details.proposedDate : null;
  const endTime = typeof details.endTime === "string" ? details.endTime : "23:59";
  if (!date) return false;

  const endsAt = new Date(`${date}T${endTime}`);
  return Number.isNaN(endsAt.getTime()) ? false : endsAt.getTime() > now.getTime();
}

/**
 * E6: attendee-facing info for a batch of events, called by
 * registration-service with the caller's own token. Attendees only — other
 * roles have fuller routes. Declared before GET /:id so "attendee-info"
 * isn't read as an event id. Drafts are never returned.
 *
 * An event is returned whether or not it is open: registration-service
 * decides whether *this* attendee may see it (registered, or open), using
 * the `open` flag computed here. Ids that don't exist are simply absent.
 */
eventsRouter.get("/attendee-info", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const rawIds = typeof req.query.ids === "string" ? req.query.ids : "";

  if (user.role !== "attendee") {
    await recordAccessDenial(supabase, user.id, rawIds, "attendee_info_role_not_allowed");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const idStrings = rawIds.split(",").map((id) => id.trim());
  if (rawIds === "" || !idStrings.every(isPositiveInteger) || idStrings.length > MAX_ATTENDEE_INFO_IDS) {
    res.status(400).json({ error: `ids must be 1–${MAX_ATTENDEE_INFO_IDS} comma-separated event ids` });
    return;
  }
  const ids = [...new Set(idStrings.map(Number))];

  const { data, error } = await supabase
    .from("events")
    .select("id, status, submitted_details")
    .in("id", ids)
    .neq("status", "Draft");

  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  const events = (data ?? []).map((row) => {
    const details = (row.submitted_details ?? {}) as Record<string, unknown>;
    const info: Record<string, unknown> = {
      id: row.id,
      registrationNeeded: details.registrationNeeded === true,
      open: isOpenForRegistration(row.status, details),
      accessibility: attendeeAccessibility(details.accessibility),
    };
    for (const field of ATTENDEE_INFO_FIELDS) info[field] = details[field] ?? null;
    return info;
  });

  res.json({ events });
});

/**
 * E6: Confirmed events currently open for registration, so an attendee can
 * find something to register for. Same whitelist as GET /attendee-info.
 * Declared before GET /:id.
 */
eventsRouter.get("/open-for-registration", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  if (user.role !== "attendee") {
    await recordAccessDenial(supabase, user.id, "", "open_for_registration_role_not_allowed");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .select("id, status, submitted_details")
    .eq("status", "Confirmed");

  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  const events = (data ?? [])
    .map((row) => ({ row, details: (row.submitted_details ?? {}) as Record<string, unknown> }))
    .filter(({ row, details }) => isOpenForRegistration(row.status, details))
    .map(({ row, details }) => {
      const info: Record<string, unknown> = {
        id: row.id,
        registrationNeeded: true,
        open: true,
        accessibility: attendeeAccessibility(details.accessibility),
      };
      for (const field of ATTENDEE_INFO_FIELDS) info[field] = details[field] ?? null;
      return info;
    });

  res.json({ events });
});

/**
 * E1-8 AC1/AC3: the Event Coordinator Lead's unassigned queue — every
 * submitted request still waiting for a coordinator, oldest submission
 * first so the longest-waiting request is allocated first. Lead only; any
 * other role is denied and the attempt recorded, same as a direct-URL
 * attempt on someone else's event. Declared before GET /:id so
 * "unassigned" isn't read as an event id.
 */
eventsRouter.get("/unassigned", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  if (user.role !== COORDINATOR_LEAD_ROLE) {
    await recordAccessDenial(supabase, user.id, "unassigned_queue", "unassigned_queue_role_not_allowed");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("status", EVENT_STATUS.Unassigned)
    .is("coordinator_id", null)
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: "Failed to load the unassigned queue" });
    return;
  }

  res.json({ events: data ?? [] });
});

/**
 * E1-10: the Safety Officer's queue — every event awaiting an Operational
 * Safety Check, with the coordinator's safety notes from their latest
 * submission (E3-4), so the Safety Officer can assess without a second
 * request. Any Safety Officer sees every event in Safety Review — there's
 * no per-officer assignment. Declared before GET /:id so
 * "safety-review-queue" isn't read as an event id.
 */
eventsRouter.get("/safety-review-queue", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  if (user.role !== "safety_officer") {
    await recordAccessDenial(supabase, user.id, "safety_review_queue", "safety_review_queue_role_not_allowed");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data: events, error } = await supabase
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("status", EVENT_STATUS.SafetyReview)
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: "Failed to load the safety review queue" });
    return;
  }

  const eventIds = (events ?? []).map((event) => event.id);
  const { data: submissions, error: submissionsError } = await supabase
    .from("event_safety_submissions")
    .select("event_id, equipment_placement, crowd_movement, emergency_access, venue_restrictions, submitted_at")
    .in("event_id", eventIds.length > 0 ? eventIds : [-1])
    .order("submitted_at", { ascending: false });

  if (submissionsError) {
    res.status(500).json({ error: "Failed to load safety notes" });
    return;
  }

  // Keep only the latest submission per event — resubmission after a
  // reject/changes-requested gets fresh notes and the earlier ones no
  // longer apply (E3-12 AC4).
  const latestByEvent = new Map<number, (typeof submissions)[number]>();
  for (const submission of submissions ?? []) {
    if (!latestByEvent.has(submission.event_id)) latestByEvent.set(submission.event_id, submission);
  }

  const result = (events ?? []).map((event) => {
    const submission = latestByEvent.get(event.id);
    return {
      ...event,
      safetyNotes: submission
        ? {
            equipmentPlacement: submission.equipment_placement,
            crowdMovement: submission.crowd_movement,
            emergencyAccess: submission.emergency_access,
            venueRestrictions: submission.venue_restrictions,
          }
        : null,
    };
  });

  res.json({ events: result });
});

/**
 * Fetch a single event by id. The service-role client returns any row
 * regardless of ownership, so ownership/role is checked explicitly here;
 * a non-owner (and non-coordinator) request is treated the same as
 * "not found" and the attempt is recorded for audit purposes.
 *
 * E1-8 AC2: the Event Coordinator Lead may open any submitted event (not a
 * draft — a draft hasn't entered the process). Read-only: every write
 * route below rejects the Lead's role.
 */
eventsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!isPositiveInteger(eventId)) {
    await recordAccessDenial(supabase, user.id, eventId, "invalid_id_format");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .select(`${EVENT_COLUMNS}, organiser_id`)
    .eq("id", Number(eventId))
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }

  const isOwner = data?.organiser_id === user.id;
  const isCoordinator = user.role === "coordinator";
  const isLead = user.role === COORDINATOR_LEAD_ROLE && data?.status !== EVENT_STATUS.Draft;

  if (!data || (!isOwner && !isCoordinator && !isLead)) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // organiser_id rides along (E2-15): chat-service needs it to know who a
  // coordinator's message should notify, and who to accept history/send
  // requests from. Not a privacy boundary — the organiser's name is
  // already embedded in EVENT_COLUMNS for any coordinator viewing this.
  res.json({ event: data });
});

/**
 * E2-10: the owning organiser edits event details while clarification is
 * outstanding. The edit itself becomes the reply posted into the
 * clarification thread (AC1) — no separate typed message required — and
 * saving clears the flag back to "Requested" (AC2), putting the request
 * back in the coordinator's normal review queue.
 */
eventsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { data: existing, error: fetchError } = await supabase
    .from("events")
    .select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (fetchError) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }

  if (!existing) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  // E3-7: the assigned coordinator edits event details during Planning —
  // a separate path from the organiser one below, with its own status gate
  // and a locked set of "critical" fields (schedule/venue/capacity) that
  // must go through reject/re-request instead of a silent direct edit.
  const isCoordinatorEditor = user.role === "coordinator";

  if (isCoordinatorEditor) {
    if (existing.coordinator_id !== user.id) {
      await recordAccessDenial(supabase, user.id, eventId, "not_assigned_coordinator");
      res.status(403).json({ error: "Access denied" });
      return;
    }

    if (existing.status !== "Planning") {
      res.status(409).json({ error: "Coordinator edits are only allowed while the event is in Planning." });
      return;
    }

    const result = validateEventRequest(req.body ?? {});
    if (!result.valid) {
      res.status(400).json({ error: "Validation failed", fields: result.fields });
      return;
    }

    const oldDetails = (existing.submitted_details ?? {}) as Record<string, unknown>;
    const changedCriticalFields = COORDINATOR_LOCKED_FIELDS.filter(
      (field) => oldDetails[field] !== (result.value as unknown as Record<string, unknown>)[field],
    );
    if (changedCriticalFields.length > 0) {
      res.status(400).json({
        error: `Coordinators cannot change ${changedCriticalFields.join(", ")} directly.`,
      });
      return;
    }

    const { data, error } = await supabase
      .from("events")
      .update({ submitted_details: result.value })
      .eq("id", existing.id)
      .select(EVENT_COLUMNS)
      .single();

    if (error) {
      res.status(500).json({ error: "Failed to save changes" });
      return;
    }

    await recordEventHistory(
      supabase,
      existing.id,
      diffSubmittedDetailsStructured(oldDetails, result.value!),
      user.id,
    );

    res.json({ event: data });
    return;
  }

  if (existing.organiser_id !== user.id) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // E2-7 AC1/AC2: direct edits are allowed while still pending review
  // (Requested/Unassigned), while still in Planning (per AGENTS.md §3 the
  // lifecycle only truly locks down once Confirmed), or, per E2-10, while
  // responding to an outstanding clarification. Anything past that
  // (Confirmed, Completed, Rejected) is blocked — there's no "raise a
  // change request" flow built yet, so this is a block + message, not a
  // real alternate workflow.
  const isClarificationResponse = existing.status === "Clarification Requested";
  const isDirectEdit = ORGANISER_DIRECT_EDIT_STATUSES.has(existing.status);
  // E2-4 AC3: editing a draft here means submitting it — same E2-1
  // validation as a fresh request, and the same E2-14 handling as POST /.
  const isDraftSubmit = existing.status === "Draft";

  if (!isClarificationResponse && !isDirectEdit && !isDraftSubmit) {
    res.status(409).json({
      error:
        "This request has already been approved and can no longer be edited directly. Contact your coordinator to request a change.",
    });
    return;
  }

  // E2-14: same restriction as POST / — only an organiser's draft reaches
  // the Lead-notification lookup under their own token.
  if (isDraftSubmit && user.role !== "organiser") {
    res.status(403).json({ error: "Only organisers can submit event requests" });
    return;
  }

  const result = validateEventRequest(req.body ?? {});
  if (!result.valid) {
    res.status(400).json({ error: "Validation failed", fields: result.fields });
    return;
  }

  // Clarification responses restore whatever status the event was in
  // before the clarification was requested — "Requested" for the normal
  // pre-approval case, but "Planning" if a coordinator asked a follow-up
  // after already approving. Direct edits (AC1) don't change status at all.
  const updatePayload: Record<string, unknown> = { submitted_details: result.value };
  if (isClarificationResponse) {
    updatePayload.status = existing.status_before_clarification || "Requested";
    updatePayload.status_before_clarification = null;
  } else if (isDraftSubmit) {
    updatePayload.status = EVENT_STATUS.Unassigned;
    updatePayload.coordinator_id = null;
  }

  const { data, error } = await supabase
    .from("events")
    .update(updatePayload)
    .eq("id", existing.id)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to save your response" });
    return;
  }

  const oldDetails = (existing.submitted_details ?? {}) as Record<string, unknown>;

  await recordEventHistory(
    supabase,
    existing.id,
    diffSubmittedDetailsStructured(oldDetails, result.value!),
    user.id,
  );

  if (isClarificationResponse) {
    const diff = diffSubmittedDetails(oldDetails, result.value!);

    if (diff) {
      const { data: openQuestion } = await supabase
        .from("event_clarifications")
        .select("id")
        .eq("event_id", existing.id)
        .is("parent_id", null)
        .eq("resolved", false)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { error: replyError } = await supabase.from("event_clarifications").insert({
        event_id: existing.id,
        parent_id: openQuestion?.id ?? null,
        author_id: user.id,
        author_role: "organiser",
        message: diff,
      });

      if (replyError) {
        console.error("Failed to record clarification response reply", { eventId: existing.id, error: replyError });
      }
    }
  }

  if (isDraftSubmit) {
    await notifyCoordinatorLeads(
      req.headers.authorization!,
      data.id,
      eventDisplayName(data as unknown as AssignmentEventRow),
    );
  }

  res.json({ event: data });
});

/**
 * E2-7 AC3: the structured edit history for this event, chronological.
 * Same visibility rule as the clarification thread: owning organiser or
 * any coordinator.
 */
eventsRouter.get("/:id/history", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await loadEventForClarification(req, res, eventId);
  if (!event) return;

  const { supabase } = req as Required<Pick<AuthedRequest, "supabase">>;
  const { data, error } = await supabase
    .from("event_history")
    .select("id, field, old_value, new_value, changed_by, changed_by_user:changed_by(name, role), changed_at")
    .eq("event_id", event.id)
    .order("changed_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: "Failed to load event history" });
    return;
  }

  res.json({ history: data ?? [] });
});

/**
 * E2-7 AC1 / AGENTS.md §3 edit table: the owning organiser edits directly
 * while the request waits in the unassigned queue, waits on its
 * coordinator's review, or is in Planning.
 */
const ORGANISER_DIRECT_EDIT_STATUSES = new Set<string>([
  EVENT_STATUS.Unassigned,
  EVENT_STATUS.Requested,
  EVENT_STATUS.Planning,
]);

/**
 * E2-13: only the Event Coordinator Lead moves an event out of
 * "Unassigned", so "Unassigned" is deliberately absent from every
 * coordinator decision set below — there is no Unassigned → Planning or
 * Unassigned → Rejected (§3). A coordinator reviews once assigned, i.e.
 * from "Requested".
 */
const COORDINATOR_REVIEW_STATUSES = new Set<string>([EVENT_STATUS.Requested]);
const REJECTABLE_STATUSES = new Set<string>([EVENT_STATUS.Requested, EVENT_STATUS.ClarificationRequested]);

/**
 * E3-7 AC1: fields the assigned coordinator cannot change through the
 * Planning-stage direct edit — schedule/venue/capacity changes are
 * "critical" and go through reject/re-request instead of a silent edit.
 */
const COORDINATOR_LOCKED_FIELDS = ["proposedDate", "startTime", "endTime", "venue", "expectedAttendance"] as const;

interface ReviewEventRow {
  id: number;
  status: string;
  coordinator_id: string | null;
}

/**
 * Shared entry checks for every coordinator decision route (approve/
 * reject/request-clarification): role, id format, existence, the AC5
 * "Rejected is terminal" rule, and ownership — only the event's assigned
 * coordinator may act on it. E2-13 retired E2-6's assign-on-first-action
 * rule: an event with no coordinator is the Lead's to assign, not for any
 * coordinator to claim by acting on it, and E2-12 AC6 relies on the same
 * check to block a previous coordinator after a reassignment. Sends the
 * appropriate error response and returns null if any check fails,
 * otherwise returns the event row for the caller to apply its own
 * status-transition check to.
 */
async function authorizeCoordinatorReview(
  req: AuthedRequest,
  res: Response,
  eventId: string,
): Promise<ReviewEventRow | null> {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }

  if (user.role !== "coordinator") {
    res.status(403).json({ error: "Only coordinators can review event requests" });
    return null;
  }

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }

  const { data, error } = await supabase
    .from("events")
    .select("id, status, coordinator_id")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to load event" });
    return null;
  }

  if (!data) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }

  if (!data.coordinator_id) {
    await recordAccessDenial(supabase, user.id, eventId, "coordinator_not_assigned");
    res.status(403).json({
      error: "This request hasn't been assigned to a coordinator yet. The Event Coordinator Lead assigns it.",
    });
    return null;
  }

  if (data.coordinator_id !== user.id) {
    await recordAccessDenial(supabase, user.id, eventId, "coordinator_mismatch");
    res.status(403).json({ error: "This request is assigned to another coordinator" });
    return null;
  }

  if (data.status === "Rejected") {
    res.status(409).json({ error: "This request has been rejected and cannot be moved forward" });
    return null;
  }

  return data as ReviewEventRow;
}

/**
 * E1-4.2 AC1 / E2-3: approve — from "Requested", or from "Clarification
 * Requested" once every top-level question raised on this event has been
 * marked resolved (an event already decided is blocked upstream in
 * authorizeCoordinatorReview). Sets status to "Planning".
 */
eventsRouter.post("/:id/approve", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (!COORDINATOR_REVIEW_STATUSES.has(event.status)) {
    if (event.status !== "Clarification Requested") {
      res.status(409).json({ error: "This request cannot be approved from its current status" });
      return;
    }

    const { supabase: clarificationSupabase } = req as Required<Pick<AuthedRequest, "supabase">>;
    const { data: questions, error: questionsError } = await clarificationSupabase
      .from("event_clarifications")
      .select("id, resolved")
      .eq("event_id", event.id)
      .is("parent_id", null);

    if (questionsError) {
      res.status(500).json({ error: "Failed to check the clarification thread" });
      return;
    }

    if ((questions ?? []).some((q: { resolved: boolean }) => !q.resolved)) {
      res.status(409).json({ error: "This request has an outstanding clarification request and cannot be approved yet" });
      return;
    }
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { data, error } = await supabase
    .from("events")
    .update({
      status: "Planning",
      decided_at: new Date().toISOString(),
      decided_by: user.id,
    })
    .eq("id", event.id)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to approve event request" });
    return;
  }

  res.json({ event: data });
});

/**
 * E1-4.2 AC2/AC3/AC5: reject — requires a reason, allowed from "Requested"
 * or "Clarification Requested" (an event already in Planning is out of
 * this story's scope; already-Rejected is blocked upstream in
 * authorizeCoordinatorReview per AC5).
 */
eventsRouter.post("/:id/reject", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (!REJECTABLE_STATUSES.has(event.status)) {
    res.status(409).json({ error: "This request cannot be rejected from its current status" });
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "A reason is required to reject a request" });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { data, error } = await supabase
    .from("events")
    .update({
      status: "Rejected",
      review_outcome: reason,
      decided_at: new Date().toISOString(),
      decided_by: user.id,
    })
    .eq("id", event.id)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to reject event request" });
    return;
  }

  res.json({ event: data });
});

/**
 * E3-4: the assigned coordinator submits a Planning event for the Safety
 * Officer's Operational Safety Check (Planning → Safety Review, AGENTS.md §3).
 * Checked in order: the caller is the assigned coordinator (AC7, in
 * authorizeCoordinatorReview), the event is in Planning (AC6), the safety
 * notes are all given (AC5), and the venue and equipment arrangements are
 * settled (AC1–AC4) — read from venue-service and equipment-service. The
 * status change and the notes are then written together by
 * submit_event_for_safety_review (migration 0026). A resubmission after the
 * Safety Officer rejects or requests changes takes the same path, since
 * both return the event to Planning (AC8), and gets a fresh submission row.
 * Notifying the Safety Officer and Organiser is deferred to E7 (AC9).
 */
eventsRouter.post("/:id/submit-safety-review", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (event.status !== EVENT_STATUS.Planning) {
    res.status(409).json({ error: "Only an event in Planning can be submitted for safety review" });
    return;
  }

  const parsed = parseSafetyNotes(req.body);
  if (!parsed.valid) {
    res.status(400).json({ error: "Safety notes are required", fields: parsed.fields });
    return;
  }

  const authorization = req.headers.authorization!;
  const [bookings, equipment] = await Promise.all([
    fetchEventVenueBookings(event.id, authorization),
    fetchEventEquipmentRequests(event.id, authorization),
  ]);
  if (bookings.status === "error" || equipment.status === "error") {
    res.status(502).json({ error: "Couldn't check this event's venue and equipment arrangements. Please try again." });
    return;
  }

  const outstanding = findOutstandingArrangements(bookings.value, equipment.value);
  if (hasOutstanding(outstanding)) {
    res.status(409).json({ error: describeOutstanding(outstanding), outstanding });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { notes } = parsed;
  const { data: submissionId, error: submitError } = await supabase.rpc("submit_event_for_safety_review", {
    p_event_id: event.id,
    p_submitted_by: user.id,
    p_equipment_placement: notes.equipmentPlacement,
    p_crowd_movement: notes.crowdMovement,
    p_emergency_access: notes.emergencyAccess,
    p_venue_restrictions: notes.venueRestrictions,
  });
  if (submitError) {
    res.status(500).json({ error: "Failed to submit the event for safety review" });
    return;
  }
  if (submissionId === null) {
    // Moved on, or reassigned, since the checks above.
    res.status(409).json({ error: "This event is no longer in Planning or no longer assigned to you" });
    return;
  }

  const { data, error } = await supabase.from("events").select(EVENT_COLUMNS).eq("id", event.id).single();
  if (error) {
    res.status(500).json({ error: "Submitted for safety review, but failed to reload the event" });
    return;
  }

  res.json({ event: data, submissionId });
});

interface SafetyReviewEventRow {
  id: number;
  status: string;
  coordinator_id: string | null;
  organiser_id: string | null;
}

/**
 * E3-12/13/14: shared entry checks for the Safety Officer's decision
 * routes. Unlike authorizeCoordinatorReview, there's no per-event
 * assignment to check — any Safety Officer may act on any event in Safety
 * Review (E1-10 AC4/AC5).
 */
async function authorizeSafetyOfficerReview(
  req: AuthedRequest,
  res: Response,
  eventId: string,
): Promise<SafetyReviewEventRow | null> {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }

  if (user.role !== "safety_officer") {
    res.status(403).json({ error: "Only the Safety Officer can decide an Operational Safety Check" });
    return null;
  }

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }

  const { data, error } = await supabase
    .from("events")
    .select("id, status, coordinator_id, organiser_id")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to load event" });
    return null;
  }

  if (!data) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }

  return data as SafetyReviewEventRow;
}

/**
 * E3-12: the Safety Officer approves the Operational Safety Check (Safety
 * Review -> Confirmed, AGENTS.md §3). The decision and status change land
 * together in approve_event_safety_review (migration 0028), which also
 * links the decision to the submission it answers. The assigned
 * coordinator and Organiser are notified (AC1); a failure to notify never
 * blocks the already-committed decision.
 */
eventsRouter.post("/:id/safety-review/approve", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeSafetyOfficerReview(req, res, eventId);
  if (!event) return;

  if (event.status !== EVENT_STATUS.SafetyReview) {
    res.status(409).json({ error: "Only an event in Safety Review can be approved" });
    return;
  }

  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim() : null;

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { data: reviewId, error: approveError } = await supabase.rpc("approve_event_safety_review", {
    p_event_id: event.id,
    p_officer_id: user.id,
    p_reason: reason,
  });
  if (approveError) {
    res.status(500).json({ error: "Failed to approve the safety review" });
    return;
  }
  if (reviewId === null) {
    res.status(409).json({ error: "This event is no longer in Safety Review" });
    return;
  }

  const { data, error } = await supabase.from("events").select(EVENT_COLUMNS).eq("id", event.id).single();
  if (error) {
    res.status(500).json({ error: "Approved, but failed to reload the event" });
    return;
  }

  const authorization = req.headers.authorization!;
  const recipients = [event.coordinator_id, event.organiser_id].filter(
    (id): id is string => typeof id === "string",
  );
  const eventName = ((data.submitted_details ?? {}) as Record<string, unknown>).name;
  await sendNotifications(
    recipients.map((recipientId) => ({
      recipientId,
      type: "event_safety_approved",
      title: "Safety review approved",
      body: `"${typeof eventName === "string" ? eventName : "Your event"}" passed its Operational Safety Check and is now Confirmed.`,
      link: `/events/${event.id}`,
    })),
    authorization,
  );

  res.json({ event: data, reviewId });
});

/**
 * E3-13: the Safety Officer rejects the Operational Safety Check (Safety
 * Review -> Planning, AGENTS.md §3). A reason is required (AC2). The
 * decision and status change land together in reject_event_safety_review
 * (migration 0029); the event's venue bookings and equipment reservations
 * are left as they are, for the coordinator to rework. Only the assigned
 * coordinator is notified, with the reason (AC1); a failure to notify
 * never blocks the already-committed decision.
 */
eventsRouter.post("/:id/safety-review/reject", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeSafetyOfficerReview(req, res, eventId);
  if (!event) return;

  if (event.status !== EVENT_STATUS.SafetyReview) {
    res.status(409).json({ error: "Only an event in Safety Review can be rejected" });
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "A reason is required to reject a safety review" });
    return;
  }
  if (reason.length > MAX_SAFETY_DECISION_REASON_LENGTH) {
    res.status(400).json({ error: `Keep the reason under ${MAX_SAFETY_DECISION_REASON_LENGTH} characters` });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { data: reviewId, error: rejectError } = await supabase.rpc("reject_event_safety_review", {
    p_event_id: event.id,
    p_officer_id: user.id,
    p_reason: reason,
  });
  if (rejectError) {
    res.status(500).json({ error: "Failed to reject the safety review" });
    return;
  }
  if (reviewId === null) {
    res.status(409).json({ error: "This event is no longer in Safety Review" });
    return;
  }

  const { data, error } = await supabase.from("events").select(EVENT_COLUMNS).eq("id", event.id).single();
  if (error) {
    res.status(500).json({ error: "Rejected, but failed to reload the event" });
    return;
  }

  if (event.coordinator_id) {
    const eventName = ((data.submitted_details ?? {}) as Record<string, unknown>).name;
    await sendNotifications(
      [
        {
          recipientId: event.coordinator_id,
          type: "event_safety_rejected",
          title: "Safety review rejected",
          body: fitNotificationBody(
            `"${typeof eventName === "string" ? eventName : "Your event"}" failed its Operational Safety Check and is back in Planning. Reason: ${reason}`,
          ),
          link: `/events/${event.id}`,
        },
      ],
      req.headers.authorization!,
    );
  }

  res.json({ event: data, reviewId });
});

/**
 * Statuses a coordinator can request clarification from: "Requested",
 * plus "Planning" — a coordinator may realise they need more information
 * after already approving an event. Either way the event's current status
 * is captured into status_before_clarification so the organiser's
 * response (PATCH /:id) knows whether to restore it to "Requested" or back
 * to "Planning".
 */
const CLARIFICATION_REQUESTABLE_STATUSES = new Set<string>([...COORDINATOR_REVIEW_STATUSES, EVENT_STATUS.Planning]);

/**
 * Request clarification/amendment from the Organiser — from a
 * pending-review status, or from "Planning" for a post-approval follow-up
 * question. Resolving an outstanding request (Organiser amends and
 * resubmits) is not built yet; until it is, this is a one-way transition
 * that leaves approval blocked (AC1's "no outstanding clarification").
 */
eventsRouter.post("/:id/request-clarification", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (!CLARIFICATION_REQUESTABLE_STATUSES.has(event.status)) {
    res.status(409).json({ error: "Clarification can only be requested while this request is pending review" });
    return;
  }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "A message is required to request clarification" });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { data, error } = await supabase
    .from("events")
    .update({
      status: "Clarification Requested",
      status_before_clarification: event.status,
      review_outcome: message,
      decided_at: new Date().toISOString(),
      decided_by: user.id,
    })
    .eq("id", event.id)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to request clarification" });
    return;
  }

  // Seeds the thread the clarification popup renders (AC3) with this
  // first question. Best-effort: the status transition above is the part
  // that actually gates approval, so a failure here is logged, not fatal.
  const { error: threadError } = await supabase
    .from("event_clarifications")
    .insert({ event_id: event.id, author_id: user.id, author_role: "coordinator", message });

  if (threadError) {
    console.error("Failed to record clarification thread entry", { eventId: event.id, error: threadError });
  }

  res.json({ event: data });
});

interface ClarificationRow {
  id: number;
  parent_id: number | null;
  author_id: string;
  author_role: string;
  message: string;
  resolved: boolean;
  created_at: string;
}

const CLARIFICATION_COLUMNS = "id, parent_id, author_id, author_role, message, resolved, created_at";

/**
 * Shared visibility check for the clarification thread and history routes:
 * same rule as GET /:id (owning organiser, any coordinator, or the Event
 * Coordinator Lead for a submitted event — E2-12 AC2 has the Lead read a
 * reassignment back from the history), but returns the fields those routes
 * need (organiser_id/coordinator_id/status) rather than the full event
 * payload. Write routes apply their own, narrower check on top.
 */
async function loadEventForClarification(
  req: AuthedRequest,
  res: Response,
  eventId: string,
): Promise<{ id: number; status: string; organiser_id: string; coordinator_id: string | null } | null> {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }

  const { data, error } = await supabase
    .from("events")
    .select("id, status, organiser_id, coordinator_id")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to load event" });
    return null;
  }

  const isOwner = data?.organiser_id === user.id;
  const isCoordinator = user.role === "coordinator";
  const isLead = user.role === COORDINATOR_LEAD_ROLE && data?.status !== EVENT_STATUS.Draft;

  if (!data || (!isOwner && !isCoordinator && !isLead)) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return data;
}

/** AC3: the full exchange, chronological, for anyone with access to the event. */
eventsRouter.get("/:id/clarifications", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await loadEventForClarification(req, res, eventId);
  if (!event) return;

  const { supabase } = req as Required<Pick<AuthedRequest, "supabase">>;
  const { data, error } = await supabase
    .from("event_clarifications")
    .select(CLARIFICATION_COLUMNS)
    .eq("event_id", event.id)
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: "Failed to load clarifications" });
    return;
  }

  res.json({ clarifications: (data ?? []) as ClarificationRow[] });
});

/**
 * Coordinator asks a follow-up question. The main "Request Clarification/
 * Amendment" action (POST /:id/request-clarification) makes the *first*
 * ask and flips the status; once outstanding, that button disables (AC2),
 * so this — the popup's "+" — is how the assigned coordinator keeps
 * asking without a way to re-open a request that's already flagged.
 */
eventsRouter.post("/:id/clarifications", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (event.status !== "Clarification Requested") {
    res.status(409).json({ error: "Additional questions can only be added while clarification is outstanding" });
    return;
  }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "A question is required" });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { data, error } = await supabase
    .from("event_clarifications")
    .insert({ event_id: event.id, author_id: user.id, author_role: "coordinator", message })
    .select(CLARIFICATION_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to add question" });
    return;
  }

  res.status(201).json({ clarification: data as ClarificationRow });
});

/** Either party replies within a question's thread. */
eventsRouter.post("/:id/clarifications/:questionId/replies", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await loadEventForClarification(req, res, eventId);
  if (!event) return;

  const { user, supabase } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const isOwner = event.organiser_id === user.id;
  const isAssignedCoordinator =
    user.role === "coordinator" && event.coordinator_id === user.id;

  if (!isOwner && !isAssignedCoordinator) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (event.status !== "Clarification Requested") {
    res.status(409).json({ error: "This clarification is no longer open for replies" });
    return;
  }

  const questionId = Array.isArray(req.params.questionId) ? req.params.questionId[0] : req.params.questionId;
  if (!isPositiveInteger(questionId)) {
    res.status(404).json({ error: "Question not found" });
    return;
  }

  const { data: question, error: questionError } = await supabase
    .from("event_clarifications")
    .select("id, event_id, parent_id, resolved")
    .eq("id", Number(questionId))
    .maybeSingle();

  if (questionError) {
    res.status(500).json({ error: "Failed to load question" });
    return;
  }

  if (!question || question.event_id !== event.id || question.parent_id !== null) {
    res.status(404).json({ error: "Question not found" });
    return;
  }

  if (question.resolved) {
    res.status(409).json({ error: "This question has been resolved and is no longer open for replies" });
    return;
  }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "A reply is required" });
    return;
  }

  const authorRole = user.role === "coordinator" ? "coordinator" : "organiser";
  const { data, error } = await supabase
    .from("event_clarifications")
    .insert({ event_id: event.id, parent_id: question.id, author_id: user.id, author_role: authorRole, message })
    .select(CLARIFICATION_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to add reply" });
    return;
  }

  res.status(201).json({ clarification: data as ClarificationRow });
});

/**
 * Coordinator marks a top-level question resolved — once every question
 * on the event is resolved, /approve unblocks (see its status check).
 */
eventsRouter.post("/:id/clarifications/:questionId/resolve", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (event.status !== "Clarification Requested") {
    res.status(409).json({ error: "Questions can only be resolved while clarification is outstanding" });
    return;
  }

  const questionId = Array.isArray(req.params.questionId) ? req.params.questionId[0] : req.params.questionId;
  if (!isPositiveInteger(questionId)) {
    res.status(404).json({ error: "Question not found" });
    return;
  }

  const { supabase } = req as Required<Pick<AuthedRequest, "supabase">>;
  const { data: question, error: questionError } = await supabase
    .from("event_clarifications")
    .select("id, event_id, parent_id")
    .eq("id", Number(questionId))
    .maybeSingle();

  if (questionError) {
    res.status(500).json({ error: "Failed to load question" });
    return;
  }

  if (!question || question.event_id !== event.id || question.parent_id !== null) {
    res.status(404).json({ error: "Question not found" });
    return;
  }

  const { data, error } = await supabase
    .from("event_clarifications")
    .update({ resolved: true })
    .eq("id", question.id)
    .select(CLARIFICATION_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to resolve question" });
    return;
  }

  res.json({ clarification: data as ClarificationRow });
});

interface AssignmentEventRow {
  id: number;
  status: string;
  organiser_id: string;
  coordinator_id: string | null;
  coordinator: { name: string } | null;
  submitted_details: Record<string, unknown> | null;
}

/**
 * Shared entry checks for assign (E2-13) and reassign (E2-12): Lead role
 * (AC "including directly via the API"), id format, existence, a
 * coordinatorId in the body, and that it names an active coordinator.
 * Status rules differ between the two and are left to the caller. Sends
 * the error response and returns null if any check fails.
 */
async function authorizeLeadAssignment(
  req: AuthedRequest,
  res: Response,
  eventId: string,
): Promise<{ event: AssignmentEventRow; coordinator: { id: string; name: string } } | null> {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }

  if (user.role !== COORDINATOR_LEAD_ROLE) {
    await recordAccessDenial(supabase, user.id, eventId, "assignment_role_not_allowed");
    res.status(403).json({ error: "Only the Event Coordinator Lead can assign or reassign coordinators" });
    return null;
  }

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }

  const coordinatorId = typeof req.body?.coordinatorId === "string" ? req.body.coordinatorId.trim() : "";
  if (!coordinatorId) {
    res.status(400).json({ error: "Choose a coordinator" });
    return null;
  }

  const { data, error } = await supabase
    .from("events")
    .select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to load event" });
    return null;
  }

  if (!data || data.status === EVENT_STATUS.Draft) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }

  const coordinators = await fetchCoordinators(req.headers.authorization!);
  if (coordinators.status === "error") {
    res.status(502).json({ error: "Failed to load the list of coordinators" });
    return null;
  }

  const coordinator = coordinators.coordinators.find((c) => c.id === coordinatorId);
  if (!coordinator) {
    res.status(400).json({ error: "That user is not an active Event Coordinator" });
    return null;
  }

  return { event: data as unknown as AssignmentEventRow, coordinator };
}

function eventDisplayName(event: AssignmentEventRow): string {
  const name = event.submitted_details?.name;
  return typeof name === "string" && name.trim() ? name.trim() : `Event #${event.id}`;
}

/**
 * E2-13: the Event Coordinator Lead assigns a request from the unassigned
 * queue. AC1: the coordinator becomes the event's single point of contact
 * and the status moves Unassigned → Requested (§3); both the coordinator
 * and the Organiser are notified. AC2: an event that already has a
 * coordinator is blocked — that is a reassignment (E2-12). AC3: with no
 * active coordinator there is nobody valid to name, so the request stays
 * Unassigned. AC4: Lead only.
 *
 * The update only matches while the event is still Unassigned with no
 * coordinator, so if two Leads assign the same request at once exactly one
 * wins and the other gets a 409 — an event never ends up with two.
 *
 * Notifications are best-effort and sent after the write lands, so a slow
 * or failing notification-service never undoes an assignment.
 */
eventsRouter.post("/:id/assign", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const authorized = await authorizeLeadAssignment(req, res, eventId);
  if (!authorized) return;
  const { event, coordinator } = authorized;

  if (event.coordinator_id) {
    res.status(409).json({
      error: "This event already has a coordinator. An event has at most one — use reassignment instead.",
    });
    return;
  }

  if (event.status !== EVENT_STATUS.Unassigned) {
    res.status(409).json({ error: "Only a request in the unassigned queue can be assigned" });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { data, error } = await supabase
    .from("events")
    .update({ status: EVENT_STATUS.Requested, coordinator_id: coordinator.id })
    .eq("id", event.id)
    .eq("status", EVENT_STATUS.Unassigned)
    .is("coordinator_id", null)
    .select(EVENT_COLUMNS)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to assign the coordinator" });
    return;
  }

  if (!data) {
    res.status(409).json({ error: "This request was assigned by someone else just now. Refresh to see who." });
    return;
  }

  await recordEventHistory(
    supabase,
    event.id,
    [
      { field: "Coordinator", oldValue: null, newValue: coordinator.name },
      { field: "Status", oldValue: EVENT_STATUS.Unassigned, newValue: EVENT_STATUS.Requested },
    ],
    user.id,
  );

  const eventName = eventDisplayName(event);
  const link = `/events/${event.id}`;
  const notified = await sendNotifications(
    [
      {
        recipientId: coordinator.id,
        type: "event_assigned",
        title: "New event assigned to you",
        body: `"${eventName}" has been assigned to you. You are now its coordinator.`,
        link,
      },
      {
        recipientId: event.organiser_id,
        type: "event_coordinator_assigned",
        title: "Your event has a coordinator",
        body: `${coordinator.name} is now the coordinator for "${eventName}".`,
        link,
      },
    ],
    req.headers.authorization!,
  );

  res.json({ event: data, notificationsFailed: !notified });
});

/**
 * E2-12: the Event Coordinator Lead hands an assigned event to a different
 * active coordinator. AC1: the new coordinator becomes the only one and the
 * previous assignment ends; the status does not change (§3 lists this as
 * Requested → Requested, and it applies in any open status). AC2: recorded
 * in the event history — previous coordinator, new coordinator, when, and
 * by whom (changed_by). AC3: blocked once the event is Rejected, Cancelled
 * or Completed. AC4: an event without a coordinator is assigned (E2-13),
 * not reassigned. AC5: Lead only. AC6 needs nothing here: every
 * coordinator action checks events.coordinator_id live, so the previous
 * coordinator is blocked and the new one can act the moment this commits.
 * AC7: the Organiser and both coordinators are notified.
 *
 * The update only matches while the previous coordinator is still the
 * assigned one, so two simultaneous reassignments can't both apply.
 */
eventsRouter.post("/:id/reassign", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const authorized = await authorizeLeadAssignment(req, res, eventId);
  if (!authorized) return;
  const { event, coordinator } = authorized;

  if (CLOSED_EVENT_STATUSES.has(event.status)) {
    res.status(409).json({ error: `This event is ${event.status}. Closed events cannot be reassigned.` });
    return;
  }

  if (!event.coordinator_id) {
    res.status(409).json({
      error: "This event has no coordinator yet. Assign one from the unassigned queue instead.",
    });
    return;
  }

  if (event.coordinator_id === coordinator.id) {
    res.status(400).json({ error: "Choose a different coordinator from the one already assigned" });
    return;
  }

  const previousCoordinatorId = event.coordinator_id;
  const previousCoordinatorName = event.coordinator?.name ?? previousCoordinatorId;

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { data, error } = await supabase
    .from("events")
    .update({ coordinator_id: coordinator.id })
    .eq("id", event.id)
    .eq("coordinator_id", previousCoordinatorId)
    .eq("status", event.status)
    .select(EVENT_COLUMNS)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to reassign the coordinator" });
    return;
  }

  if (!data) {
    res.status(409).json({ error: "This event changed while you were reassigning it. Refresh and try again." });
    return;
  }

  await recordEventHistory(
    supabase,
    event.id,
    [{ field: "Coordinator", oldValue: previousCoordinatorName, newValue: coordinator.name }],
    user.id,
  );

  const eventName = eventDisplayName(event);
  const link = `/events/${event.id}`;
  const notifications: NewNotification[] = [
    {
      recipientId: event.organiser_id,
      type: "event_coordinator_reassigned",
      title: "Your event has a new coordinator",
      body: `${coordinator.name} is now the coordinator for "${eventName}", taking over from ${previousCoordinatorName}.`,
      link,
    },
    {
      recipientId: previousCoordinatorId,
      type: "event_reassigned_away",
      title: "Event reassigned",
      body: `"${eventName}" has been reassigned to ${coordinator.name}. You can still view it, but you can no longer act on it.`,
      link,
    },
    {
      recipientId: coordinator.id,
      type: "event_assigned",
      title: "Event reassigned to you",
      body: `"${eventName}" has been reassigned to you from ${previousCoordinatorName}. You are now its coordinator.`,
      link,
    },
  ];
  const notified = await sendNotifications(notifications, req.headers.authorization!);

  res.json({ event: data, notificationsFailed: !notified });
});
