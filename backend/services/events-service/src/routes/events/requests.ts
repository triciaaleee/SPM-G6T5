import { Router } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import { validateEventRequest } from "../../lib/validateEventRequest.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { diffSubmittedDetails, diffSubmittedDetailsStructured } from "../../lib/diffSubmittedDetails.js";
import { EVENT_STATUS } from "../../lib/eventStatus.js";
import {
  announceAttendanceChange,
  announceReschedule,
  attendanceChanged,
  scheduleChanged,
} from "../../lib/reschedule.js";
import { getPublisher } from "../../lib/rabbitPublisher.js";
import {
  routeParam,
  COORDINATOR_LEAD_ROLE,
  recordAccessDenial,
  recordEventHistory,
  EVENT_COLUMNS,
  hasSafetySubmission,
  loadEventForClarification,
  type AssignmentEventRow,
  eventDisplayName,
} from "./shared.js";

/**
 * Requests controller: organisers submit and edit event requests (E2), and
 * each role lists and views the events it is allowed to see. Edits stop after
 * Planning, and every edit is recorded in event history.
 */

export const requestsRouter = Router();

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
// Stryker disable next-line StringLiteral: equivalent - the router treats the path "" exactly like "/"
requestsRouter.post("/", async (req: AuthedRequest, res) => {
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
// Stryker disable next-line StringLiteral: equivalent - the router treats the path "" exactly like "/"
requestsRouter.get("/", async (req: AuthedRequest, res) => {
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
    // "My events": a coordinator asks for only what is assigned to them, instead of downloading
    // everyone's and filtering in the browser. Only the value "me", only for a coordinator; the
    // default call (All events, the Lead) is unchanged.
    if (user.role === "coordinator" && req.query.assignedTo === "me") {
      query = query.eq("coordinator_id", user.id);
    }
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  res.json({ events: data });
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
requestsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = routeParam(req.params.id);

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
requestsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = routeParam(req.params.id);

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
        coordinatorId: existing.coordinator_id, // the assigned coordinator: checked equal to the caller above
        details: result.value as unknown as Record<string, unknown>,
      });
    }
    if (attendanceChanged(oldDetails, result.value as unknown as Record<string, unknown>)) {
      await announceAttendanceChange(supabase, {
        id: existing.id,
        actorId: user.id,
        eventName: eventDisplayName(data as unknown as AssignmentEventRow),
        coordinatorId: existing.coordinator_id, // the assigned coordinator: checked equal to the caller above
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
requestsRouter.get("/:id/history", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
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
