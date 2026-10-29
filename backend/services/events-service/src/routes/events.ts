import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { validateEventRequest } from "../lib/validateEventRequest.js";
import { isPositiveInteger } from "../lib/validation.js";
import { diffSubmittedDetails, diffSubmittedDetailsStructured } from "../lib/diffSubmittedDetails.js";
import { EVENT_STATUS } from "../lib/eventStatus.js";
import { announceAttendanceChange, announceReschedule, attendanceChanged, scheduleChanged } from "../lib/reschedule.js";
import { getPublisher } from "../lib/rabbitPublisher.js";
import { eventStartsAt, hasEventStarted, localDateStart } from "../lib/eventTiming.js";
import {
  getRegistrationState,
  isListed,
  REGISTRATION_CUTOFF_DAYS,
  REGISTRATION_DATE_EDITABLE_STATUSES,
  REGISTRATION_OVERRIDE,
  REGISTRATION_STATE,
} from "../lib/registrationPeriod.js";
import type { RegistrationOverride } from "../lib/registrationPeriod.js";
import {
  COORDINATOR_LEAD_ROLE,
  recordAccessDenial,
  recordEventHistory,
  EVENT_COLUMNS,
  authorizeCoordinatorReview,
  hasSafetySubmission,
  loadEventForClarification,
  type AssignmentEventRow,
  eventDisplayName,
} from "./events/shared.js";
import { internalRouter } from "./events/internal.js";
import { draftsRouter } from "./events/drafts.js";
import { assignmentRouter } from "./events/assignment.js";
import { reviewRouter } from "./events/review.js";
import { lifecycleRouter } from "./events/lifecycle.js";
import { safetyReviewRouter } from "./events/safetyReview.js";
import { changeRequestsRouter } from "./events/changeRequests.js";

/**
 * E2-14: a newly-unassigned request waits in the Lead's queue (E1-8) until
 * assigned (E2-13) — notify every Lead so they know there's something to
 * triage, and the submitting organiser with a confirmation (#104 row 1).
 * Best-effort: a notification failure never blocks the submission that
 * already committed.
 *
 * Lead ids are resolved by notification-service after this publishes
 * (`recipients.roles`), not fetched from user-service here first — events-
 * service has no REST dependency on user-service in this path at all.
 */
async function notifyCoordinatorLeads(eventId: number, eventName: string, actorId: string): Promise<void> {
  await getPublisher().publish({
    type: "request.submitted",
    eventId,
    actorId,
    recipients: { userIds: [actorId], roles: ["coordinator_lead"] },
    data: { eventName, organiserId: actorId },
  });
}

export const eventsRouter = Router();

// Service-to-service routes; they bring their own auth, so they go first.
eventsRouter.use(internalRouter);

eventsRouter.use(requireAuth);
eventsRouter.use(draftsRouter);
eventsRouter.use(assignmentRouter);
eventsRouter.use(reviewRouter);
eventsRouter.use(lifecycleRouter);
eventsRouter.use(safetyReviewRouter);
eventsRouter.use(changeRequestsRouter);

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

  await notifyCoordinatorLeads(data.id, eventDisplayName(data as unknown as AssignmentEventRow), user.id);

  res.status(201).json({ event: data, message: "Your event request has been submitted." });
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
 * E6: the only fields an Attendee may see about an event — what is safe to
 * show someone who is not part of the planning. Built as a whitelist, never
 * by filtering a fuller object, so a field added to submitted_details later
 * stays private until it is listed here. No coordinator, purpose, equipment,
 * review outcome, history or clarifications, and of the organiser only their
 * display name (never their id, email or contact details). The accessibility
 * note and the capacity (expected attendance) are added explicitly by the
 * routes below.
 */
export const ATTENDEE_INFO_FIELDS = ["name", "description", "proposedDate", "startTime", "endTime"] as const;

/** Whole-field answers that mean "nothing to note" (same list venue-service uses for requirements). */
const NO_ACCESSIBILITY_INFO_PATTERN =
  /^(n\/?a|nil|none|no|nope|-+|not applicable|no preference|no requirements?|not required|not needed)\.?$/i;

/**
 * The organiser's accessibility note, as written, for attendees. Blank or a
 * "NA"/"None" style answer is no note at all, so the card shows nothing
 * rather than "None".
 */
export function attendeeAccessibility(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" || NO_ACCESSIBILITY_INFO_PATTERN.test(text) ? null : text;
}

/**
 * How many attendees may register, shown to attendees as slots left. The
 * single place capacity is decided: today it is the organiser's expected
 * attendance; a dedicated registration limit would be read here instead.
 * Null when there is no usable number (older events), meaning no cap.
 */
export function attendeeCapacity(details: Record<string, unknown>): number | null {
  const value = Number(details.expectedAttendance);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The organiser's display name for attendees, from the `organiser:organiser_id(name)`
 * embed. Name only: nothing else about the organiser is read or returned.
 */
export function attendeeOrganiserName(organiser: unknown): string | null {
  const record = (Array.isArray(organiser) ? organiser[0] : organiser) as { name?: unknown } | null | undefined;
  const name = record?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

const MAX_ATTENDEE_INFO_IDS = 100;

interface RegistrationRowFields {
  status: string;
  registration_open_date?: unknown;
  registration_override?: unknown;
}

/**
 * The registration period as attendees need it: the state (NOT_OPEN, OPEN or
 * CLOSED — registration-service turns OPEN into FULL when no places are left,
 * since it owns the count), whether the event is listed, and `open` (state is
 * OPEN). Lives here, with the event data, so registration-service doesn't
 * re-derive it. Times are Singapore time (lib/eventTiming.ts); the rules are
 * in lib/registrationPeriod.ts.
 */
export function registrationInfo(row: RegistrationRowFields, details: Record<string, unknown>, now: Date = new Date()) {
  const inputs = {
    status: row.status,
    details,
    openDate: row.registration_open_date,
    override: row.registration_override,
  };
  const registrationState = getRegistrationState(inputs, now);
  return {
    registrationState,
    listed: isListed(inputs, now),
    open: registrationState === REGISTRATION_STATE.Open,
  };
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
    .select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)")
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
      ...registrationInfo(row, details),
      accessibility: attendeeAccessibility(details.accessibility),
      capacity: attendeeCapacity(details),
      organiserName: attendeeOrganiserName(row.organiser),
      // E6-4: an attendee may withdraw until the event starts.
      hasStarted: hasEventStarted(details),
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
    .select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)")
    .eq("status", "Confirmed");

  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  const events = (data ?? [])
    .map((row) => ({ row, details: (row.submitted_details ?? {}) as Record<string, unknown> }))
    .filter(({ row, details }) => registrationInfo(row, details).listed)
    .map(({ row, details }) => {
      const info: Record<string, unknown> = {
        id: row.id,
        registrationNeeded: true,
        ...registrationInfo(row, details),
        accessibility: attendeeAccessibility(details.accessibility),
        capacity: attendeeCapacity(details),
        organiserName: attendeeOrganiserName(row.organiser),
      };
      for (const field of ATTENDEE_INFO_FIELDS) info[field] = details[field] ?? null;
      return info;
    });

  res.json({ events });
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
  // Drafts sit outside the process (AGENTS.md §3): only their organiser sees them.
  const isCoordinator = user.role === "coordinator" && data?.status !== EVENT_STATUS.Draft;
  const isLead = user.role === COORDINATOR_LEAD_ROLE && data?.status !== EVENT_STATUS.Draft;
  // E3-14: read-only, for events the Safety Officer reviews — ones that
  // have been submitted for safety review. venue-service and
  // equipment-service defer to this check, which is how the officer can
  // see the bookings and equipment they may flag.
  const isSafetyOfficer = user.role === "safety_officer" && !!data && (await hasSafetySubmission(supabase, data.id));

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
  // a separate path from the organiser one below, with its own status gate.
  // All fields are editable (team decision: the organiser can already
  // change any field directly in Planning, so restricting the coordinator
  // added no protection, and event history already covers the audit trail).
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

    if (scheduleChanged(oldDetails, result.value as unknown as Record<string, unknown>)) {
      await announceReschedule(supabase, {
        id: existing.id,
        actorId: user.id,
        eventName: eventDisplayName(data as unknown as AssignmentEventRow),
        coordinatorId: existing.coordinator_id ?? null,
        details: result.value as unknown as Record<string, unknown>,
      });
    }
    if (attendanceChanged(oldDetails, result.value as unknown as Record<string, unknown>)) {
      await announceAttendanceChange(supabase, {
        id: existing.id,
        actorId: user.id,
        eventName: eventDisplayName(data as unknown as AssignmentEventRow),
        coordinatorId: existing.coordinator_id ?? null,
        details: result.value as unknown as Record<string, unknown>,
      });
    }

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
  // responding to an outstanding clarification. Anything past that is
  // blocked. E3-9 AC2: once Confirmed, that block points at the change
  // request endpoint (POST /:id/change-requests) rather than telling the
  // organiser to contact their coordinator — that's now a dead end, since
  // the change request flow exists. Safety Review, Completed, Rejected and
  // Cancelled have no edit path at all (Safety Review has no direct-edit
  // or change-request route; the other three are terminal).
  const isClarificationResponse = existing.status === "Clarification Requested";
  const isDirectEdit = ORGANISER_DIRECT_EDIT_STATUSES.has(existing.status);
  // E2-4 AC3: editing a draft here means submitting it — same E2-1
  // validation as a fresh request, and the same E2-14 handling as POST /.
  const isDraftSubmit = existing.status === "Draft";

  if (!isClarificationResponse && !isDirectEdit && !isDraftSubmit) {
    res.status(409).json({
      error:
        existing.status === EVENT_STATUS.Confirmed || existing.status === EVENT_STATUS.NeedsReview
          ? "This event is past Planning and can no longer be edited directly. Raise a change request instead."
          : "This request can no longer be edited or changed at this stage.",
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

  // Equipment and venues can only be booked from Planning on, so an earlier edit has nothing to move or re-check.
  if (!isDraftSubmit && !PRE_PLANNING_STATUSES.has(existing.status)) {
    const newDetails = result.value as unknown as Record<string, unknown>;
    const announced = {
      id: existing.id,
      actorId: user.id,
      eventName: eventDisplayName(data as unknown as AssignmentEventRow),
      coordinatorId: existing.coordinator_id ?? null,
      details: newDetails,
    };
    if (scheduleChanged(oldDetails, newDetails)) await announceReschedule(supabase, announced);
    if (attendanceChanged(oldDetails, newDetails)) await announceAttendanceChange(supabase, announced);
  }

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

    // #104 row 6: the organiser's response goes to whoever is currently
    // assigned — read fresh from `existing`, not cached from when the
    // clarification was first requested, so a reassignment in between is
    // respected.
    if (existing.coordinator_id) {
      await getPublisher().publish({
        type: "clarification.answered",
        eventId: data.id,
        actorId: user.id,
        recipients: { userIds: [existing.coordinator_id], roles: [] },
        data: { eventName: eventDisplayName(data as unknown as AssignmentEventRow) },
      });
    }
  }

  if (isDraftSubmit) {
    await notifyCoordinatorLeads(data.id, eventDisplayName(data as unknown as AssignmentEventRow), user.id);
  }

  if (isDirectEdit) {
    // #104 row 2 / AC4: the assigned coordinator, or every Lead if the
    // event is still Unassigned (no coordinator to address).
    const eventName = eventDisplayName(data as unknown as AssignmentEventRow);
    if (existing.coordinator_id) {
      await getPublisher().publish({
        type: "request.edited",
        eventId: data.id,
        actorId: user.id,
        recipients: { userIds: [existing.coordinator_id], roles: [] },
        data: { eventName },
      });
    } else {
      // No REST lookup — notification-service resolves the Lead ids itself.
      await getPublisher().publish({
        type: "request.edited",
        eventId: data.id,
        actorId: user.id,
        recipients: { userIds: [], roles: ["coordinator_lead"] },
        data: { eventName },
      });
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
/** Before Planning nothing is reserved yet, so a reschedule has no equipment to move. */
const PRE_PLANNING_STATUSES = new Set<string>([EVENT_STATUS.Draft, EVENT_STATUS.Unassigned, EVENT_STATUS.Requested]);

const ORGANISER_DIRECT_EDIT_STATUSES = new Set<string>([
  EVENT_STATUS.Unassigned,
  EVENT_STATUS.Requested,
  EVENT_STATUS.Planning,
]);

/**
 * Registration period (coordinator). Only the assigned coordinator, via
 * authorizeCoordinatorReview. Writes the stored intent (open date, manual
 * open/close); whether registration is open right now is derived on read
 * (lib/registrationPeriod.ts), so nothing here opens or closes anything on a
 * timer. Each change goes into the event history.
 */
async function loadRegistrationRow(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  eventId: number,
): Promise<{
  submitted_details: Record<string, unknown> | null;
  registration_open_date: string | null;
  registration_override: string | null;
} | null> {
  const { data } = await supabase
    .from("events")
    .select("submitted_details, registration_open_date, registration_override")
    .eq("id", eventId)
    .maybeSingle();
  return data ?? null;
}

eventsRouter.put("/:id/registration", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (!REGISTRATION_DATE_EDITABLE_STATUSES.includes(event.status)) {
    res.status(409).json({ error: "The registration open date can only be set once the event is in Planning, and before it ends" });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const row = await loadRegistrationRow(supabase, event.id);
  if (!row) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }
  const details = row.submitted_details ?? {};
  if (details.registrationNeeded !== true) {
    res.status(409).json({ error: "This event doesn't need registration" });
    return;
  }

  const openDate = (req.body ?? {}).openDate;
  if (localDateStart(openDate) === null) {
    res.status(400).json({ error: "openDate must be a date in YYYY-MM-DD format" });
    return;
  }
  const startsAt = eventStartsAt(details);
  if (startsAt !== null) {
    const cutoff = startsAt.getTime() - REGISTRATION_CUTOFF_DAYS * 24 * 60 * 60 * 1000;
    if ((localDateStart(openDate) as Date).getTime() >= cutoff) {
      res.status(400).json({
        error: `Registration closes ${REGISTRATION_CUTOFF_DAYS} days before the event, so the open date must be earlier than that`,
      });
      return;
    }
  }

  const { data, error } = await supabase
    .from("events")
    .update({ registration_open_date: openDate })
    .eq("id", event.id)
    .eq("coordinator_id", user.id)
    .in("status", REGISTRATION_DATE_EDITABLE_STATUSES)
    .select(EVENT_COLUMNS)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "Failed to save the registration open date" });
    return;
  }
  if (!data) {
    res.status(409).json({ error: "This event changed or is no longer assigned to you" });
    return;
  }

  await recordEventHistory(
    supabase,
    event.id,
    [{ field: "Registration open date", oldValue: row.registration_open_date, newValue: openDate as string }],
    user.id,
  );

  res.json({ event: data });
});

/** open / close / auto: the manual override on registration (Confirmed events only). */
function registrationOverrideRoute(action: string, override: RegistrationOverride) {
  eventsRouter.post(`/:id/registration/${action}`, async (req: AuthedRequest, res) => {
    const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const event = await authorizeCoordinatorReview(req, res, eventId);
    if (!event) return;

    if (event.status !== EVENT_STATUS.Confirmed) {
      res.status(409).json({ error: "Registration can only be opened or closed for a Confirmed event" });
      return;
    }

    const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
    const row = await loadRegistrationRow(supabase, event.id);
    if (!row) {
      res.status(500).json({ error: "Failed to load event" });
      return;
    }
    if ((row.submitted_details ?? {}).registrationNeeded !== true) {
      res.status(409).json({ error: "This event doesn't need registration" });
      return;
    }
    const startsAt = eventStartsAt(row.submitted_details ?? {});
    if (override === REGISTRATION_OVERRIDE.ForceOpen && startsAt !== null && startsAt.getTime() <= Date.now()) {
      res.status(409).json({ error: "This event has already started, so registration can't be opened" });
      return;
    }

    const { data, error } = await supabase
      .from("events")
      .update({ registration_override: override })
      .eq("id", event.id)
      .eq("status", EVENT_STATUS.Confirmed)
      .eq("coordinator_id", user.id)
      .select(EVENT_COLUMNS)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "Failed to update registration" });
      return;
    }
    if (!data) {
      res.status(409).json({ error: "This event is no longer Confirmed or no longer assigned to you" });
      return;
    }

    await recordEventHistory(
      supabase,
      event.id,
      [{ field: "Registration override", oldValue: row.registration_override ?? REGISTRATION_OVERRIDE.None, newValue: override }],
      user.id,
    );

    res.json({ event: data });
  });
}

registrationOverrideRoute("open", REGISTRATION_OVERRIDE.ForceOpen);
registrationOverrideRoute("close", REGISTRATION_OVERRIDE.ForceClosed);
registrationOverrideRoute("auto", REGISTRATION_OVERRIDE.None);
