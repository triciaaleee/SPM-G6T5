import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { normaliseDraftEventRequest, validateEventRequest } from "../lib/validateEventRequest.js";
import { isPositiveInteger } from "../lib/validation.js";
import { assignCoordinator } from "../lib/coordinatorAssignment.js";
import { diffSubmittedDetails, diffSubmittedDetailsStructured } from "../lib/diffSubmittedDetails.js";
import { CLOSED_EVENT_STATUSES, EVENT_STATUS } from "../lib/eventStatus.js";
import { sendNotifications, type NewNotification } from "../lib/notificationsClient.js";
import { fetchCoordinators } from "../lib/usersClient.js";

/**
 * Week 7 change 5: the Event Coordinator Lead oversees incoming requests,
 * assigns them (E2-13) and reassigns them (E2-12). Read-only on the event
 * itself: the Lead never edits, approves or rejects (E1-8 AC2).
 */
const COORDINATOR_LEAD_ROLE = "coordinator_lead";

/**
 * Week 7 change 6: the Safety Officer runs the Operational Safety Check on
 * events in "Safety Review" (E1-10). Read-only on the event, its venues and
 * its equipment; the only decisions are approve / reject / request changes
 * (E3-12, E3-13, E3-14).
 */
const SAFETY_OFFICER_ROLE = "safety_officer";

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
 * E2-6: a coordinator is auto-assigned round-robin at submission time,
 * right as the request reaches "Requested" — not later, whenever a
 * coordinator happens to open it (see lib/coordinatorAssignment.ts). If
 * no coordinators exist yet, the request is flagged "Unassigned" instead
 * and waits in the Event Coordinator Lead's unassigned queue (E1-8) until
 * the Lead assigns it (E2-13). E2-14 replaces the auto-assignment itself.
 */
eventsRouter.post("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const result = validateEventRequest(req.body ?? {});
  if (!result.valid) {
    res.status(400).json({ error: "Validation failed", fields: result.fields });
    return;
  }

  const coordinatorId = await assignCoordinator(supabase);

  const { data, error } = await supabase
    .from("events")
    .insert({
      organiser_id: user.id,
      status: coordinatorId ? "Requested" : "Unassigned",
      coordinator_id: coordinatorId,
      submitted_details: result.value,
    })
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to submit event request" });
    return;
  }

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

const SAFETY_SUBMISSION_COLUMNS =
  "id, event_id, equipment_placement, crowd_movement, emergency_access, venue_restrictions, submitted_at, submitted_by_user:submitted_by(name)";

interface SafetySubmissionRow {
  id: number;
  event_id: number;
  equipment_placement: string;
  crowd_movement: string;
  emergency_access: string;
  venue_restrictions: string;
  submitted_at: string;
  submitted_by_user: { name: string } | { name: string }[] | null;
}

/** The coordinator's safety notes as the Safety Officer reads them. */
function toSafetyNotes(row: SafetySubmissionRow) {
  const submitter = Array.isArray(row.submitted_by_user) ? row.submitted_by_user[0] : row.submitted_by_user;
  return {
    id: row.id,
    equipmentPlacement: row.equipment_placement,
    crowdMovement: row.crowd_movement,
    emergencyAccess: row.emergency_access,
    venueRestrictions: row.venue_restrictions,
    submittedAt: row.submitted_at,
    submittedBy: submitter?.name ?? null,
  };
}

/**
 * Denies anyone but the Safety Officer, recording the attempt the same way
 * a direct-URL attempt on someone else's event is recorded (E1-10 AC5).
 */
async function requireSafetyOfficer(req: AuthedRequest, res: Response, target: string): Promise<boolean> {
  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  if (user.role === SAFETY_OFFICER_ROLE) return true;
  await recordAccessDenial(supabase, user.id, target, "safety_check_role_not_allowed");
  res.status(403).json({ error: "Access denied" });
  return false;
}

/**
 * E1-10 AC1/AC3: the Safety Officer's review queue — every event in
 * "Safety Review" and nothing else, soonest event first, since that is the
 * order the checks fall due. Each carries when its arrangements were
 * submitted for review. Declared before GET /:id so "safety-queue" isn't
 * read as an event id.
 */
eventsRouter.get("/safety-queue", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  if (!(await requireSafetyOfficer(req, res, "safety_queue"))) return;

  const { data, error } = await supabase
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("status", EVENT_STATUS.SafetyReview);

  if (error) {
    res.status(500).json({ error: "Failed to load the safety review queue" });
    return;
  }

  const events = (data ?? []) as unknown as { id: number; submitted_details: Record<string, unknown> | null }[];

  const submittedAt = new Map<number, string>();
  if (events.length > 0) {
    const { data: submissions, error: submissionsError } = await supabase
      .from("event_safety_submissions")
      .select("event_id, submitted_at")
      .in(
        "event_id",
        events.map((e) => e.id),
      )
      .order("submitted_at", { ascending: false });

    if (submissionsError) {
      res.status(500).json({ error: "Failed to load the safety review queue" });
      return;
    }

    // Newest first, so the first row seen per event is its latest submission.
    for (const row of (submissions ?? []) as { event_id: number; submitted_at: string }[]) {
      if (!submittedAt.has(row.event_id)) submittedAt.set(row.event_id, row.submitted_at);
    }
  }

  const eventDate = (e: (typeof events)[number]) => {
    const date = e.submitted_details?.proposedDate;
    const time = e.submitted_details?.startTime;
    return `${typeof date === "string" ? date : "9999-12-31"}T${typeof time === "string" ? time : "99:99"}`;
  };

  res.json({
    events: [...events]
      .sort((a, b) => eventDate(a).localeCompare(eventDate(b)) || a.id - b.id)
      .map((e) => ({ ...e, safety_submitted_at: submittedAt.get(e.id) ?? null })),
  });
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
 *
 * E1-10 AC2: the Safety Officer may open an event awaiting their
 * Operational Safety Check — and only then. venue-service and
 * equipment-service forward the caller's token here to decide who may see
 * an event's bookings and equipment, so this is also what lets the Safety
 * Officer read those (AC2), read-only (AC4).
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
  const isSafetyOfficer = user.role === SAFETY_OFFICER_ROLE && data?.status === EVENT_STATUS.SafetyReview;

  if (!data || (!isOwner && !isCoordinator && !isLead && !isSafetyOfficer)) {
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
 * E1-10 AC2: the Operational Safety Check view's own data — the event
 * (expected attendance and accessibility requirements are in
 * submitted_details) and the coordinator's latest safety notes: equipment
 * placement, crowd movement, emergency access and known restrictions, as
 * entered when the event was submitted for review (E3-4, migration 0026).
 * Venue bookings and equipment come from venue-service and
 * equipment-service, which own them.
 *
 * AC5: Safety Officer only — anyone else is denied and the attempt
 * recorded, even a coordinator who could otherwise see the event. The view
 * exists only while the event is awaiting the check.
 */
eventsRouter.get("/:id/safety-check", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!(await requireSafetyOfficer(req, res, eventId))) return;

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { data: event, error } = await supabase
    .from("events")
    .select(EVENT_COLUMNS)
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

  if ((event as unknown as { status: string }).status !== EVENT_STATUS.SafetyReview) {
    res.status(409).json({ error: "This event isn't awaiting an Operational Safety Check" });
    return;
  }

  const { data: submission, error: submissionError } = await supabase
    .from("event_safety_submissions")
    .select(SAFETY_SUBMISSION_COLUMNS)
    .eq("event_id", Number(eventId))
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (submissionError) {
    res.status(500).json({ error: "Failed to load the safety notes" });
    return;
  }

  res.json({
    event,
    safetyNotes: submission ? toSafetyNotes(submission as unknown as SafetySubmissionRow) : null,
  });
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
  // validation as a fresh request, and the same auto-assignment as POST /.
  const isDraftSubmit = existing.status === "Draft";

  if (!isClarificationResponse && !isDirectEdit && !isDraftSubmit) {
    res.status(409).json({
      error:
        "This request has already been approved and can no longer be edited directly. Contact your coordinator to request a change.",
    });
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
    const coordinatorId = await assignCoordinator(supabase);
    updatePayload.status = coordinatorId ? "Requested" : "Unassigned";
    updatePayload.coordinator_id = coordinatorId;
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
