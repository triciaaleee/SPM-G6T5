import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { validateEventRequest } from "../lib/validateEventRequest.js";
import type { ValidatedEventRequest } from "../lib/validateEventRequest.js";
import { isPositiveInteger } from "../lib/validation.js";
import { diffSubmittedDetails, diffSubmittedDetailsStructured } from "../lib/diffSubmittedDetails.js";
import { EVENT_STATUS } from "../lib/eventStatus.js";
import { committedFieldValue, validateChangeRequestFields, withHeldValues } from "../lib/changeRequestFields.js";
import { AUTO_APPLIED_REASON_PREFIX, CHANGE_REQUEST_STATUS } from "../lib/changeRequestStatus.js";
import {
  announceAttendanceChange,
  announceReschedule,
  attendanceChanged,
  scheduleChanged,
  SCHEDULE_FIELDS,
} from "../lib/reschedule.js";
import { getPublisher } from "../lib/rabbitPublisher.js";
import {
  checkBookingAvailability,
  fetchEventEquipmentRequests,
  fetchEventVenueBookings,
  flagBookingForRebooking,
  flagEquipmentForReassessment,
} from "../lib/arrangementsClient.js";
import type { ArrangementEquipmentItem } from "../lib/arrangementsClient.js";
import { fetchEventRegistrations } from "../lib/registrationsClient.js";
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
 * E3-9: the only edit path once an event is Confirmed — PATCH /:id above
 * already blocks direct edits past Planning. E3-8: critical fields
 * (schedule, attendance, venue, equipment, accessibility) are held as a
 * `change_requests`/`change_request_fields` row for the assigned
 * coordinator to decide (E3-11, not built here); everything else is
 * written straight to submitted_details.
 *
 * Deciding a held request — approving/rejecting, applying its values,
 * returning the event to Planning — belongs to E3-11 (#36) and has no
 * route yet. Assessing impact (affected bookings/reservations/
 * registrations, capacity conflicts) is E3-10 (#35), also not built here.
 */
eventsRouter.post("/:id/change-requests", async (req: AuthedRequest, res) => {
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
    .select("id, status, organiser_id, coordinator_id, submitted_details")
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
  if (existing.organiser_id !== user.id) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // E3-9 AC3: Completed/Cancelled block outright. Every other non-Confirmed
  // status (Draft, Unassigned, Requested, Clarification Requested,
  // Planning, Safety Review) already has a direct-edit or other path, so a
  // change request only ever makes sense from Confirmed.
  if (existing.status !== EVENT_STATUS.Confirmed && existing.status !== EVENT_STATUS.NeedsReview) {
    res.status(409).json({
      error: "Change requests can only be raised once the event is Confirmed.",
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const current = (existing.submitted_details ?? {}) as Partial<ValidatedEventRequest>;

  // Merge with whatever's already open (at most one Pending request per
  // event — enforced by a unique index too, migration 0037) so a second
  // submission updates it instead of piling up a parallel one.
  const { data: openRequest, error: openRequestError } = await supabase
    .from("change_requests")
    .select("id")
    .eq("event_id", existing.id)
    .eq("status", CHANGE_REQUEST_STATUS.Pending)
    .maybeSingle();

  if (openRequestError) {
    res.status(500).json({ error: "Failed to load the event's open change request" });
    return;
  }

  let openFields: { id: number; field: string; old_value: string | null; new_value: string; is_critical: boolean }[] = [];
  if (openRequest) {
    const { data, error } = await supabase
      .from("change_request_fields")
      .select("id, field, old_value, new_value, is_critical")
      .eq("request_id", openRequest.id);
    if (error) {
      res.status(500).json({ error: "Failed to load the event's open change request" });
      return;
    }
    openFields = data ?? [];
  }
  const heldCritical = openFields.filter((field) => field.is_critical);

  // Diff against "what the organiser would see if they reopened the
  // form" — the committed baseline with any already-held values overlaid
  // — so resubmitting an untouched held field is a true no-op, not a
  // spurious re-hold every time.
  const effectiveBaseline = withHeldValues(
    current,
    heldCritical.map((field) => ({ field: field.field, newValue: field.new_value })),
  );
  const result = validateChangeRequestFields(body, effectiveBaseline);

  if (!result.valid) {
    res.status(400).json({ error: "Validation failed", fields: result.fields });
    return;
  }

  if (result.changes.length === 0) {
    res.status(400).json({ error: "No field changes were submitted." });
    return;
  }

  const nonCriticalChanges = result.changes.filter((change) => !change.isCritical);

  // A critical change against the held value is either a revert — the
  // organiser took it back to what's actually committed, so it's un-held
  // — or a genuine overwrite/fresh hold.
  const revertedFields: string[] = [];
  const upsertedCritical: { field: string; oldValue: string | null; newValue: string }[] = [];
  for (const change of result.changes.filter((c) => c.isCritical)) {
    const trueBaseline = committedFieldValue(current, change.field);
    const wasHeld = heldCritical.some((field) => field.field === change.field);
    if (wasHeld && change.newValue === (trueBaseline ?? "")) {
      revertedFields.push(change.field);
    } else {
      upsertedCritical.push({ field: change.field, oldValue: trueBaseline, newValue: change.newValue });
    }
  }

  const willHoldSomething = upsertedCritical.length > 0 || heldCritical.some((f) => !revertedFields.includes(f.field));

  // Create a row only if nothing's open yet and this submission needs
  // one — a Pending request if it's holding anything, else an already-
  // resolved Approved one for a purely non-critical/pure-revert touch.
  let targetRequestId = openRequest?.id ?? null;
  if (!targetRequestId && (upsertedCritical.length > 0 || nonCriticalChanges.length > 0)) {
    const isAutoApplied = upsertedCritical.length === 0;
    const { data: created, error: createError } = await supabase
      .from("change_requests")
      .insert({
        event_id: existing.id,
        organiser_id: user.id,
        status: isAutoApplied ? CHANGE_REQUEST_STATUS.Approved : CHANGE_REQUEST_STATUS.Pending,
        decided_at: isAutoApplied ? new Date().toISOString() : null,
        // E3-8 AC3: nothing critical was touched, so there's nothing for a
        // coordinator to review — flagged as automatic (not a coordinator's
        // decision) so both sides can tell it apart from a real approval.
        decision_reason: isAutoApplied
          ? `${AUTO_APPLIED_REASON_PREFIX}${nonCriticalChanges.map((c) => c.field).join(", ")}`
          : null,
      })
      .select("id")
      .single();

    if (createError || !created) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }
    targetRequestId = created.id;
  }

  if (revertedFields.length > 0 && targetRequestId) {
    const { error: deleteError } = await supabase
      .from("change_request_fields")
      .delete()
      .eq("request_id", targetRequestId)
      .in("field", revertedFields);
    if (deleteError) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }
  }

  const rowsToUpsert = [
    ...upsertedCritical.map((change) => ({ ...change, isCritical: true })),
    ...nonCriticalChanges.map((change) => ({ field: change.field, oldValue: change.oldValue, newValue: change.newValue, isCritical: false })),
  ];
  if (rowsToUpsert.length > 0 && targetRequestId) {
    const { error: upsertError } = await supabase.from("change_request_fields").upsert(
      rowsToUpsert.map((change) => ({
        request_id: targetRequestId,
        field: change.field,
        old_value: change.oldValue,
        new_value: change.newValue,
        is_critical: change.isCritical,
      })),
      { onConflict: "request_id,field" },
    );
    if (upsertError) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }
  }

  // Non-critical fields apply immediately (E3-8 AC3) — written straight to
  // submitted_details, same as any other direct edit.
  if (nonCriticalChanges.length > 0) {
    const updatedDetails: Record<string, unknown> = { ...current };
    for (const change of nonCriticalChanges) {
      updatedDetails[change.field] =
        change.field === "registrationNeeded" ? body.registrationNeeded === true || body.registrationNeeded === "true" : String(body[change.field]).trim();
    }

    const { error: updateError } = await supabase
      .from("events")
      .update({ submitted_details: updatedDetails })
      .eq("id", existing.id);

    if (updateError) {
      res.status(500).json({ error: "Failed to apply change request" });
      return;
    }

    await recordEventHistory(
      supabase,
      existing.id,
      nonCriticalChanges.map((change) => ({ field: change.field, oldValue: change.oldValue, newValue: change.newValue })),
      user.id,
    );
  }

  // Critical fields are held, not applied (E3-8 AC1) — already recorded
  // above in change_request_fields; just the pending-review event_history
  // entry is left to do here. E3-11 is what later writes decided_by/
  // decided_at/decision_reason and applies these values.
  if (upsertedCritical.length > 0) {
    // Logged as a pending request, not a value change — nothing has been
    // applied yet, so the old value hasn't moved. Covers both a fresh
    // hold and an overwrite of an already-held value — same wording,
    // since either way the committed value is unchanged until decided.
    await recordEventHistory(
      supabase,
      existing.id,
      upsertedCritical.map((change) => ({
        field: change.field,
        oldValue: change.oldValue,
        newValue: `requested: ${change.newValue} (pending coordinator review)`,
      })),
      user.id,
    );
  }

  if (revertedFields.length > 0) {
    await recordEventHistory(
      supabase,
      existing.id,
      revertedFields.map((field) => {
        const discarded = heldCritical.find((f) => f.field === field)!;
        return {
          field,
          oldValue: discarded.new_value,
          newValue: `reverted to ${committedFieldValue(current, field) ?? "—"} (no longer pending)`,
        };
      }),
      user.id,
    );
  }

  const eventName = eventDisplayName(existing as unknown as AssignmentEventRow);
  let notificationsFailed = false;
  let autoResolved = false;

  // A held critical field puts a Confirmed event into Needs Review until the
  // coordinator decides it (AGENTS.md section 3). The status filter makes it
  // a no-op if the event already moved on; an event already in Needs Review
  // stays there.
  if (upsertedCritical.length > 0 && existing.status === EVENT_STATUS.Confirmed) {
    const { error: reviewError } = await supabase
      .from("events")
      .update({ status: EVENT_STATUS.NeedsReview })
      .eq("id", existing.id)
      .eq("status", EVENT_STATUS.Confirmed);
    if (reviewError) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }
    await recordEventHistory(
      supabase,
      existing.id,
      [{ field: "Status", oldValue: EVENT_STATUS.Confirmed, newValue: EVENT_STATUS.NeedsReview }],
      user.id,
    );
  }

  if (targetRequestId && upsertedCritical.length === 0 && !willHoldSomething && revertedFields.length > 0) {
    // Every held field just got reverted — nothing left to decide. Close
    // the request out rather than leaving it "Pending" with no fields,
    // and tell both sides it resolved itself rather than staying silent.
    autoResolved = true;
    // Its own status (migration 0038) — nothing was actually approved,
    // the request just evaporated, so Approved would be the wrong word.
    // decision_reason is still set as the human-readable explanation.
    const { error: resolveError } = await supabase
      .from("change_requests")
      .update({
        status: CHANGE_REQUEST_STATUS.AutoWithdrawn,
        decided_at: new Date().toISOString(),
        decided_by: null,
        decision_reason: `The requested change to ${revertedFields.join(", ")} was reverted before it was reviewed.`,
      })
      .eq("id", targetRequestId);
    if (resolveError) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }

    const recipients = existing.coordinator_id ? [user.id, existing.coordinator_id] : [user.id];
    const published = await getPublisher().publish({
      type: "change.withdrawn",
      eventId: existing.id,
      actorId: user.id,
      recipients: { userIds: recipients, roles: [] },
      data: { eventName, changeRequestId: targetRequestId, fields: revertedFields },
    });
    notificationsFailed = !published;
  } else if (existing.coordinator_id) {
    const published = await getPublisher().publish({
      type: "change.requested",
      eventId: existing.id,
      actorId: user.id,
      recipients: { userIds: [existing.coordinator_id], roles: [] },
      data: {
        eventName,
        changeRequestId: targetRequestId,
        fields: result.changes.map((change) => change.field),
      },
    });
    notificationsFailed = !published;
  }

  res.status(201).json({
    changeRequestId: targetRequestId,
    applied: nonCriticalChanges.map((change) => change.field),
    held: upsertedCritical.map((change) => change.field),
    reverted: revertedFields,
    autoResolved,
    notificationsFailed,
  });
});

/**
 * E3-8 AC2/AC4: what a held critical change would affect — the event's
 * current venue bookings, equipment reservations and registrations, plus
 * whether the requested attendance would exceed a booked venue's capacity.
 * Pure read: nothing here writes anything, matching AC4's "the booking is
 * not released automatically". Not E3-10's own assessment screen (that
 * story still owns its own workflow) — just enough to satisfy E3-8's two
 * ACs for the assigned coordinator reviewing a Pending request.
 */
interface ChangeRequestImpact {
  bookings: { id: number; status: string; venue: { id: number; name: string } | null }[];
  equipmentReservations: { id: number; status: string; items: ArrangementEquipmentItem[] }[];
  registrations: {
    registeredCount: number;
    total: number;
    // E3-10 AC1: "listed", not just counted.
    registrations: { registrationId: number; userId: string; name: string | null; status: string }[];
  };
  capacityConflict: { bookingId: number; venueName: string; capacity: number; requestedAttendance: number } | null;
  // E3-10 AC2's "availability" half — a held schedule change checked
  // against the booked venue's block-out periods and other bookings.
  // null when nothing to check (no schedule held) or nothing clashed.
  availabilityConflict:
    | { bookingId: number; unavailabilityConflict: { reason: string; description: string } | null; bookingConflict: { bookingId: number; status: string; window: string } | null }
    | null;
}

/**
 * What to actually check, from a request's held fields: the requested
 * attendance (for the capacity check) and the proposed schedule (for the
 * availability check) — a partial schedule change (e.g. just endTime)
 * still needs a complete window, so the other two pieces fall back to
 * what's already committed. Shared by the GET route's per-request impact
 * loop and the approve route below, which needs the exact same inputs to
 * decide whether this specific approval actually invalidates a booking.
 */
function deriveImpactInputs(
  fields: { field: string; new_value: string }[],
  committedDetails: Record<string, unknown>,
): {
  requestedAttendance: number | null;
  proposedSchedule: { proposedDate: string; startTime: string | null; endTime: string | null } | null;
} {
  const attendanceField = fields.find((field) => field.field === "expectedAttendance");
  const requestedAttendanceRaw = attendanceField ? Number(attendanceField.new_value) : null;
  const requestedAttendance = requestedAttendanceRaw !== null && Number.isFinite(requestedAttendanceRaw) ? requestedAttendanceRaw : null;

  const heldScheduleField = (field: string) => fields.find((f) => f.field === field)?.new_value;
  const hasScheduleChange = ["proposedDate", "startTime", "endTime"].some((field) =>
    fields.some((f) => f.field === field),
  );
  const proposedSchedule = hasScheduleChange
    ? {
        proposedDate: heldScheduleField("proposedDate") ?? (committedDetails.proposedDate as string),
        startTime: heldScheduleField("startTime") ?? (committedDetails.startTime as string | null) ?? null,
        endTime: heldScheduleField("endTime") ?? (committedDetails.endTime as string | null) ?? null,
      }
    : null;

  return { requestedAttendance, proposedSchedule };
}

async function loadChangeRequestImpact(
  eventId: number,
  requestedAttendance: number | null,
  proposedSchedule: { proposedDate: string; startTime: string | null; endTime: string | null } | null,
  authorization: string,
): Promise<ChangeRequestImpact | null> {
  const [bookingsResult, equipmentResult, registrationsResult] = await Promise.all([
    fetchEventVenueBookings(eventId, authorization),
    fetchEventEquipmentRequests(eventId, authorization),
    fetchEventRegistrations(eventId, authorization),
  ]);

  if (bookingsResult.status !== "ok" || equipmentResult.status !== "ok" || registrationsResult.status !== "ok") {
    return null;
  }

  const bookings = bookingsResult.value;
  const registrations = registrationsResult.value;

  // E3-8 AC4 / E3-10 AC2: only a booking that's actually locked in the
  // venue is worth checking against — a Withdrawn/Rejected/Expired one
  // doesn't hold anything real, so flagging a conflict against it would
  // name a venue the event no longer has. By the time an event reaches
  // Confirmed its bookings should all be Approved anyway (On Hold/
  // Requested never survive to here), so this is the simplest correct
  // filter without needing hold-expiry data this client doesn't carry.
  const activeBookings = bookings.filter((booking) => booking.status === "Approved");

  let capacityConflict: ChangeRequestImpact["capacityConflict"] = null;
  if (requestedAttendance !== null) {
    const overCapacity = activeBookings.find(
      (booking) => typeof booking.venue?.capacity === "number" && booking.venue.capacity < requestedAttendance,
    );
    if (overCapacity?.venue) {
      capacityConflict = {
        bookingId: overCapacity.id,
        venueName: overCapacity.venue.name,
        capacity: overCapacity.venue.capacity as number,
        requestedAttendance,
      };
    }
  }

  // Checked against the first active booking with a venue — same
  // simplicity as the capacity check above, and in practice an event's
  // main booking.
  let availabilityConflict: ChangeRequestImpact["availabilityConflict"] = null;
  const bookingToCheck = activeBookings.find((booking) => booking.venue);
  if (proposedSchedule && bookingToCheck) {
    const availabilityResult = await checkBookingAvailability(bookingToCheck.id, proposedSchedule, authorization);
    if (availabilityResult.status === "ok" && !availabilityResult.value.available) {
      availabilityConflict = {
        bookingId: bookingToCheck.id,
        unavailabilityConflict: availabilityResult.value.unavailabilityConflict,
        bookingConflict: availabilityResult.value.bookingConflict,
      };
    }
  }

  return {
    bookings: bookings.map((booking) => ({
      id: booking.id,
      status: booking.status,
      venue: booking.venue ? { id: booking.venue.id, name: booking.venue.name } : null,
    })),
    equipmentReservations: equipmentResult.value.map((request) => ({
      id: request.id,
      status: request.status,
      items: request.items,
    })),
    registrations: {
      registeredCount: registrations.filter((r) => r.status === "Registered").length,
      total: registrations.length,
      registrations: registrations.map((r) => ({
        registrationId: r.registrationId,
        userId: r.userId,
        name: r.name,
        status: r.status,
      })),
    },
    capacityConflict,
    availabilityConflict,
  };
}

/**
 * E3-9: the organiser's own view of every change request they've raised on
 * this event. E3-8 AC2/AC4: the assigned coordinator gets the same list,
 * plus an `impact` assessment attached to each `Pending` request. Owner or
 * assigned coordinator only, read-only, most recent first.
 */
eventsRouter.get("/:id/change-requests", async (req: AuthedRequest, res) => {
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

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, organiser_id, coordinator_id, submitted_details")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (eventError) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const isOwner = event.organiser_id === user.id;
  const isAssignedCoordinator = user.role === "coordinator" && event.coordinator_id === user.id;
  if (!isOwner && !isAssignedCoordinator) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data: requests, error: requestsError } = await supabase
    .from("change_requests")
    .select("id, status, decided_at, decision_reason, created_at")
    .eq("event_id", event.id)
    .order("created_at", { ascending: false });

  if (requestsError) {
    res.status(500).json({ error: "Failed to load change requests" });
    return;
  }

  const requestIds = (requests ?? []).map((request) => request.id);
  const { data: fieldRows, error: fieldsError } = await supabase
    .from("change_request_fields")
    .select("request_id, field, old_value, new_value, is_critical, applied_at")
    .in("request_id", requestIds.length > 0 ? requestIds : [-1]);

  if (fieldsError) {
    res.status(500).json({ error: "Failed to load change requests" });
    return;
  }

  const fieldsByRequest = new Map<number, typeof fieldRows>();
  for (const field of fieldRows ?? []) {
    const list = fieldsByRequest.get(field.request_id) ?? [];
    list.push(field);
    fieldsByRequest.set(field.request_id, list);
  }

  const authorization = req.headers.authorization!;
  const committedDetails = (event.submitted_details ?? {}) as Record<string, unknown>;
  const impactByRequest = new Map<number, ChangeRequestImpact | null>();
  for (const request of requests ?? []) {
    if (request.status !== CHANGE_REQUEST_STATUS.Pending) continue;
    // Only the still-open fields count as "requested" for the impact
    // check — one already applied in an earlier partial decision is
    // already reflected in committedDetails itself.
    const fields = (fieldsByRequest.get(request.id) ?? []).filter((f) => !f.applied_at);
    const { requestedAttendance, proposedSchedule } = deriveImpactInputs(fields, committedDetails);

    impactByRequest.set(
      request.id,
      await loadChangeRequestImpact(
        event.id,
        requestedAttendance,
        proposedSchedule,
        authorization,
      ),
    );
  }

  res.json({
    changeRequests: (requests ?? []).map((request) => ({
      id: request.id,
      status: request.status,
      decidedAt: request.decided_at,
      decisionReason: request.decision_reason,
      createdAt: request.created_at,
      fields: (fieldsByRequest.get(request.id) ?? []).map((field) => ({
        field: field.field,
        oldValue: field.old_value,
        newValue: field.new_value,
        isCritical: field.is_critical,
        outcome: fieldOutcome(request.status, field.is_critical, !!field.applied_at),
      })),
      impact: impactByRequest.has(request.id) ? impactByRequest.get(request.id) : null,
    })),
  });
});

/**
 * E3-11: what happened to one field — a critical field can be applied
 * (stamped `applied_at`, migration 0041) while its request is still
 * Pending, from an earlier partial approval that left other fields open.
 */
function fieldOutcome(
  requestStatus: string,
  isCritical: boolean,
  alreadyApplied: boolean,
): "pending" | "applied" | "rejected" | "withdrawn" {
  if (!isCritical || alreadyApplied) return "applied";
  if (requestStatus === CHANGE_REQUEST_STATUS.AutoWithdrawn) return "withdrawn";
  if (requestStatus === CHANGE_REQUEST_STATUS.Rejected) return "rejected";
  // Pending, or Approved without the field ever being stamped applied: it
  // has not been confirmed as applied, so don't say it was.
  return "pending";
}

/**
 * Loads a Pending change request that belongs to this event, with its
 * fields — shared by approve and reject below. Returns null (after
 * writing the response itself) for every failure case, so callers can
 * just `if (!loaded) return;`.
 */
async function loadPendingChangeRequest(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  res: Response,
  eventId: number,
  requestId: string,
): Promise<{ id: number; fields: { field: string; old_value: string | null; new_value: string; is_critical: boolean }[] } | null> {
  if (!isPositiveInteger(requestId)) {
    res.status(404).json({ error: "Change request not found" });
    return null;
  }

  const { data: changeRequest, error: requestError } = await supabase
    .from("change_requests")
    .select("id, status")
    .eq("id", Number(requestId))
    .eq("event_id", eventId)
    .maybeSingle();
  if (requestError) {
    res.status(500).json({ error: "Failed to load the change request" });
    return null;
  }
  if (!changeRequest) {
    res.status(404).json({ error: "Change request not found" });
    return null;
  }
  if (changeRequest.status !== CHANGE_REQUEST_STATUS.Pending) {
    res.status(409).json({ error: "This change request has already been decided." });
    return null;
  }

  // Only the fields still open — one already approved in an earlier
  // partial decision (applied_at set, see migration 0041) is resolved and
  // out of scope for a further approve or reject call on this request.
  const { data: fieldRows, error: fieldsError } = await supabase
    .from("change_request_fields")
    .select("field, old_value, new_value, is_critical")
    .eq("request_id", changeRequest.id)
    .is("applied_at", null);
  if (fieldsError) {
    res.status(500).json({ error: "Failed to load the change request" });
    return null;
  }

  return { id: changeRequest.id, fields: fieldRows ?? [] };
}

/**
 * Loads the event and checks the caller is its assigned coordinator — the
 * same gate both approve and reject below share. Returns null (after
 * writing the response) on any failure.
 */
async function loadEventForDecision(
  req: AuthedRequest,
  res: Response,
  eventId: string,
): Promise<{
  id: number;
  status: string;
  safety_approval_stale?: boolean;
  coordinator_id: string | null;
  submitted_details: Record<string, unknown>;
} | null> {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, status, safety_approval_stale, coordinator_id, submitted_details")
    .eq("id", Number(eventId))
    .maybeSingle();
  if (eventError) {
    res.status(500).json({ error: "Failed to load event" });
    return null;
  }
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }
  if (user.role !== "coordinator" || event.coordinator_id !== user.id) {
    res.status(403).json({ error: "Only the event's assigned coordinator can decide this change request" });
    return null;
  }

  return event as {
    id: number;
    status: string;
    safety_approval_stale?: boolean;
    coordinator_id: string | null;
    submitted_details: Record<string, unknown>;
  };
}

/**
 * E3-11 AC1/AC2/AC3/AC5: the coordinator approves a held change request.
 * Every held field's value is applied, written to event history (AC1),
 * and the event returns to Planning — AGENTS.md §3's re-review rule,
 * broadened (with the team's sign-off) from "only venue/equipment-
 * affecting approvals" to any held critical field, since a safety
 * approval no longer applies once anything held on it changes.
 *
 * AC2/AC3: only a field that actually invalidates something gets flagged
 * — reusing E3-10's own capacity/availability check (deriveImpactInputs +
 * loadChangeRequestImpact) rather than flagging every venue/schedule/
 * attendance approval regardless of whether it's a real problem. Flagging
 * itself is delegated to venue-service/equipment-service (AGENTS.md §1:
 * each service writes only its own tables); this route just calls them.
 * Neither call blocks the approval itself from succeeding (AC5: no
 * separate re-approval needed for the decision to stand) — a flagging
 * failure is reported back, not retried or rolled back into.
 */
eventsRouter.post("/:id/change-requests/:requestId/approve", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await loadEventForDecision(req, res, eventId);
  if (!event) return;

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const requestId = Array.isArray(req.params.requestId) ? req.params.requestId[0] : req.params.requestId;
  const changeRequest = await loadPendingChangeRequest(supabase, res, event.id, requestId);
  if (!changeRequest) return;

  const allCriticalFields = changeRequest.fields.filter((f) => f.is_critical);
  const heldFieldNames = allCriticalFields.map((f) => f.field);

  // E3-11: by default every held field is approved (unchanged behavior).
  // Passing `fields` approves just that subset — the rest are simply left
  // held, not rejected: the coordinator didn't decide on them yet, so the
  // request stays Pending with just those remaining fields, open for a
  // later decision (another partial approve, or an eventual reject of
  // what's left).
  const requestedApproveFields = Array.isArray(req.body?.fields)
    ? (req.body.fields as unknown[]).filter((f): f is string => typeof f === "string")
    : null;

  let fieldsToApproveNames: string[];
  if (requestedApproveFields === null) {
    fieldsToApproveNames = heldFieldNames;
  } else {
    const unique = [...new Set(requestedApproveFields)];
    const unknown = unique.filter((f) => !heldFieldNames.includes(f));
    if (unknown.length > 0) {
      res.status(400).json({ error: `These fields aren't held on this request: ${unknown.join(", ")}` });
      return;
    }
    fieldsToApproveNames = unique;
  }

  if (fieldsToApproveNames.length === 0) {
    res.status(400).json({ error: "Approve at least one field, or use reject to decline the whole request." });
    return;
  }

  const remainingFieldNames = heldFieldNames.filter((f) => !fieldsToApproveNames.includes(f));
  const criticalFields = allCriticalFields.filter((f) => fieldsToApproveNames.includes(f.field));
  const current = event.submitted_details;
  const updatedDetails: Record<string, unknown> = { ...current };
  for (const field of criticalFields) {
    updatedDetails[field.field] = field.field === "expectedAttendance" ? Number(field.new_value) : field.new_value;
  }

  const { data: updatedEvent, error: updateError } = await supabase
    .from("events")
    .update({ submitted_details: updatedDetails, status: statusAfterApproval(event.status), safety_approval_stale: true })
    .eq("id", event.id)
    .select(`${EVENT_COLUMNS}, organiser_id`)
    .single();
  if (updateError) {
    res.status(500).json({ error: "Failed to apply the change request" });
    return;
  }

  // Undo the event write if a later step fails, so a field is never left
  // changed on the event but not recorded as applied (or the reverse).
  const rollback = async (): Promise<void> => {
    await supabase
      .from("events")
      .update({
        submitted_details: current,
        status: event.status,
        safety_approval_stale: event.safety_approval_stale ?? false,
      })
      .eq("id", event.id);
    if (criticalFields.length > 0) {
      await supabase
        .from("change_request_fields")
        .update({ applied_at: null })
        .eq("request_id", changeRequest.id)
        .in(
          "field",
          criticalFields.map((f) => f.field),
        );
    }
  };

  // A field only counts as applied once the stored event actually holds the
  // approved value: read it back from the row the update returned.
  const stored = ((updatedEvent as { submitted_details?: Record<string, unknown> } | null)?.submitted_details ?? {}) as Record<
    string,
    unknown
  >;
  const notStored = criticalFields.filter((f) => String(stored[f.field] ?? "") !== String(updatedDetails[f.field] ?? ""));
  if (notStored.length > 0) {
    await rollback();
    res.status(500).json({
      error: `Couldn't apply the change to ${notStored.map((f) => f.field).join(", ")}. Nothing was changed; please try again.`,
    });
    return;
  }

  // The approved fields are resolved — stamp them applied (migration 0041)
  // so they stop showing as held but the row (and its old/new value) stays
  // for the request's own history, instead of being deleted. Whatever's
  // left unstamped stays open, so the status update below only ever
  // closes the request out when nothing remains.
  if (criticalFields.length > 0) {
    const { error: applyError } = await supabase
      .from("change_request_fields")
      .update({ applied_at: new Date().toISOString() })
      .eq("request_id", changeRequest.id)
      .in(
        "field",
        criticalFields.map((f) => f.field),
      );
    if (applyError) {
      await rollback();
      res.status(500).json({ error: "Failed to record the decision" });
      return;
    }
  }

  if (remainingFieldNames.length === 0) {
    const { error: decideError } = await supabase
      .from("change_requests")
      .update({ status: CHANGE_REQUEST_STATUS.Approved, decided_by: user.id, decided_at: new Date().toISOString() })
      .eq("id", changeRequest.id);
    if (decideError) {
      await rollback();
      res.status(500).json({ error: "Failed to record the decision" });
      return;
    }
  }

  await recordEventHistory(
    supabase,
    event.id,
    criticalFields.map((field) => ({ field: field.field, oldValue: field.old_value, newValue: field.new_value })),
    user.id,
  );

  const authorization = req.headers.authorization!;
  const { requestedAttendance, proposedSchedule } = deriveImpactInputs(criticalFields, current);
  const impact = await loadChangeRequestImpact(event.id, requestedAttendance, proposedSchedule, authorization);

  const bookingIdsToFlag = new Set<number>();
  if (impact?.capacityConflict) bookingIdsToFlag.add(impact.capacityConflict.bookingId);
  if (impact?.availabilityConflict) bookingIdsToFlag.add(impact.availabilityConflict.bookingId);

  const bookingsFlagged: { bookingId: number; staffNotified: boolean }[] = [];
  const fieldNames = criticalFields.map((f) => f.field).join(", ");
  for (const bookingId of bookingIdsToFlag) {
    const result = await flagBookingForRebooking(
      bookingId,
      `An approved change to ${fieldNames} invalidated this booking.`,
      authorization,
    );
    if (result.status === "ok") bookingsFlagged.push({ bookingId, staffNotified: result.value.staffNotified });
  }

  let equipmentFlagged = false;
  if (criticalFields.some((f) => f.field === "equipment")) {
    const result = await flagEquipmentForReassessment(
      event.id,
      `An approved change to equipment requirements may affect the existing reservation.`,
      authorization,
    );
    equipmentFlagged = result.status === "ok" && result.value.flaggedRequestIds.length > 0;
  }

  const eventName = eventDisplayName(updatedEvent as unknown as AssignmentEventRow);
  const approvedEvent = { id: event.id, actorId: user.id, eventName, coordinatorId: event.coordinator_id, details: stored };
  if (criticalFields.some((f) => (SCHEDULE_FIELDS as readonly string[]).includes(f.field))) {
    await announceReschedule(supabase, approvedEvent);
  }
  if (criticalFields.some((f) => f.field === "expectedAttendance")) {
    await announceAttendanceChange(supabase, approvedEvent);
  }
  const published = await getPublisher().publish({
    type: "change.decided",
    eventId: event.id,
    actorId: user.id,
    recipients: { userIds: [(updatedEvent as { organiser_id?: string }).organiser_id ?? ""].filter(Boolean), roles: [] },
    data:
      remainingFieldNames.length > 0
        ? {
            eventName,
            outcome: "partially_approved",
            approvedFields: criticalFields.map((f) => f.field),
            remainingFields: remainingFieldNames,
          }
        : { eventName, outcome: "approved" },
  });

  res.json({
    event: updatedEvent,
    approvedFields: criticalFields.map((f) => f.field),
    remainingFields: remainingFieldNames,
    bookingsFlagged,
    equipmentFlagged,
    notificationsFailed: !published,
  });
});

/**
 * E3-11 AC4: the coordinator rejects a held change request with a
 * required reason. Nothing is applied — the held fields stay recorded on
 * the now-terminal Rejected row as a historical record, event untouched.
 */
eventsRouter.post("/:id/change-requests/:requestId/reject", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await loadEventForDecision(req, res, eventId);
  if (!event) return;

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const requestId = Array.isArray(req.params.requestId) ? req.params.requestId[0] : req.params.requestId;
  const changeRequest = await loadPendingChangeRequest(supabase, res, event.id, requestId);
  if (!changeRequest) return;

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "A reason is required" });
    return;
  }

  const { data: updated, error: decideError } = await supabase
    .from("change_requests")
    .update({
      status: CHANGE_REQUEST_STATUS.Rejected,
      decision_reason: reason,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
    })
    .eq("id", changeRequest.id)
    .select("id, status, decided_at, decision_reason")
    .single();
  if (decideError) {
    res.status(500).json({ error: "Failed to record the decision" });
    return;
  }

  // Rejecting the last open request on a Needs Review event whose approved
  // arrangements never changed (safety_approval_stale is still false) settles
  // it: the event returns straight to Confirmed, no new safety review.
  let returnedToConfirmed = false;
  if (event.status === EVENT_STATUS.NeedsReview) {
    const { count } = await supabase
      .from("change_requests")
      .select("id", { count: "exact", head: true })
      .eq("event_id", event.id)
      .eq("status", CHANGE_REQUEST_STATUS.Pending);
    if ((count ?? 0) === 0) {
      const { data: reverted } = await supabase
        .from("events")
        .update({ status: EVENT_STATUS.Confirmed })
        .eq("id", event.id)
        .eq("status", EVENT_STATUS.NeedsReview)
        .eq("safety_approval_stale", false)
        .select("id");
      returnedToConfirmed = (reverted ?? []).length > 0;
      if (returnedToConfirmed) {
        await recordEventHistory(
          supabase,
          event.id,
          [{ field: "Status", oldValue: EVENT_STATUS.NeedsReview, newValue: EVENT_STATUS.Confirmed }],
          user.id,
        );
      }
    }
  }

  const { data: eventRow } = await supabase
    .from("events")
    .select(`${EVENT_COLUMNS}, organiser_id`)
    .eq("id", event.id)
    .maybeSingle();
  const eventName = eventRow ? eventDisplayName(eventRow as unknown as AssignmentEventRow) : `Event #${event.id}`;
  const organiserId = (eventRow as { organiser_id?: string } | null)?.organiser_id;

  let notificationsFailed = false;
  if (organiserId) {
    const published = await getPublisher().publish({
      type: "change.decided",
      eventId: event.id,
      actorId: user.id,
      recipients: { userIds: [organiserId], roles: [] },
      data: { eventName, outcome: "rejected", reason },
    });
    notificationsFailed = !published;
  }

  res.json({ changeRequest: updated, returnedToConfirmed, notificationsFailed });
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

/**
 * Where an event goes when its coordinator approves a held change: a
 * Confirmed or Needs Review event stays in Needs Review to be re-arranged
 * and re-checked; a Safety Review event returns to Planning (AGENTS.md
 * section 3); Planning stays in Planning.
 */
function statusAfterApproval(current: string): string {
  if (current === EVENT_STATUS.Confirmed || current === EVENT_STATUS.NeedsReview) return EVENT_STATUS.NeedsReview;
  return EVENT_STATUS.Planning;
}
