import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { EVENT_STATUS } from "../../lib/eventStatus.js";
import { CHANGE_REQUEST_STATUS } from "../../lib/changeRequestStatus.js";
import { getPublisher } from "../../lib/rabbitPublisher.js";
import { fetchEventEquipmentRequests, fetchEventVenueBookings } from "../../lib/arrangementsClient.js";
import {
  describeOutstanding,
  findOutstandingArrangements,
  hasOutstanding,
  MAX_SAFETY_DECISION_REASON_LENGTH,
  parseSafetyNotes,
} from "../../lib/safetyReview.js";
import {
  arrangementOptions,
  combinedReason,
  currentArrangements,
  hasChanged,
  parseChangeRequest,
  resolveFlags,
  type StoredFlag,
} from "../../lib/safetyChanges.js";
import {
  routeParam,
  COORDINATOR_LEAD_ROLE,
  recordAccessDenial,
  EVENT_COLUMNS,
  authorizeCoordinatorReview,
  loadEventForClarification,
  type AssignmentEventRow,
  eventDisplayName,
} from "./shared.js";
import { clock } from "../../lib/clock.js";

/**
 * Safety review controller (Week 7 change 6): the assigned coordinator submits
 * the event with safety notes (E3-4), and the Safety Officer approves, rejects or
 * asks for changes (E3-12/13/14).
 */

export const safetyReviewRouter = Router();

/**
 * E1-10: the Safety Officer's queue — every event awaiting an Operational
 * Safety Check, with the coordinator's safety notes from their latest
 * submission (E3-4), so the Safety Officer can assess without a second
 * request. Any Safety Officer sees every event in Safety Review — there's
 * no per-officer assignment. Declared before GET /:id so
 * "safety-review-queue" isn't read as an event id.
 */
safetyReviewRouter.get("/safety-review-queue", async (req: AuthedRequest, res) => {
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

  // E3-14: each event's venue bookings and equipment, so the Safety Officer
  // can pick which ones must change (AC1), and — for an event resubmitted
  // after a change request — which of those flags were addressed (AC3).
  // Read with the officer's own token; null when a service couldn't answer,
  // so the rest of the queue still loads.
  const authorization = req.headers.authorization!;
  const extras = await Promise.all(
    (events ?? []).map(async (event) => {
      try {
        const [bookings, equipment, changeRequest] = await Promise.all([
          fetchEventVenueBookings(event.id, authorization),
          fetchEventEquipmentRequests(event.id, authorization),
          loadChangeRequest(supabase, event.id, authorization),
        ]);
        return {
          arrangements:
            bookings.status === "ok" && equipment.status === "ok"
              ? arrangementOptions(bookings.value, equipment.value)
              : null,
          changeRequest: changeRequest.status === "ok" ? changeRequest.value : null,
        };
      } catch {
        // One event's extras failing must not take the whole queue down.
        return { arrangements: null, changeRequest: null };
      }
    }),
  );

  const result = (events ?? []).map((event, index) => {
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
      ...extras[index],
    };
  });

  res.json({ events: result });
});

/**
 * E3-12/13/14: every Operational Safety Check decision on this event,
 * oldest first — outcome, reason, the Safety Officer and when. Lets the
 * coordinator see why an event came back to Planning without relying on
 * the notification. Same visibility as the edit history.
 */
safetyReviewRouter.get("/:id/safety-reviews", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
  const event = await loadEventForClarification(req, res, eventId);
  if (!event) return;

  const { supabase } = req as Required<Pick<AuthedRequest, "supabase">>;
  const { data, error } = await supabase
    .from("event_safety_reviews")
    .select("id, outcome, reason, submission_id, officer:officer_id(name), created_at")
    .eq("event_id", event.id)
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: "Failed to load safety reviews" });
    return;
  }

  res.json({ safetyReviews: data ?? [] });
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
 * AC9: every Safety Officer and the Organiser are notified (#105 row 1).
 */
safetyReviewRouter.post("/:id/submit-safety-review", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (event.status !== EVENT_STATUS.Planning && event.status !== EVENT_STATUS.NeedsReview) {
    res.status(409).json({ error: "Only an event in Planning or Needs Review can be submitted for safety review" });
    return;
  }

  // Needs Review is settled only once every change request is decided.
  if (event.status === EVENT_STATUS.NeedsReview) {
    const { count } = await (req as Required<Pick<AuthedRequest, "supabase">>).supabase
      .from("change_requests")
      .select("id", { count: "exact", head: true })
      .eq("event_id", event.id)
      .eq("status", CHANGE_REQUEST_STATUS.Pending);
    if ((count ?? 0) > 0) {
      res.status(409).json({ error: "Decide the open change request before submitting for safety review" });
      return;
    }
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

  const equipmentRequirements = event.submitted_details?.equipment;
  const outstanding = findOutstandingArrangements(
    bookings.value,
    equipment.value,
    typeof equipmentRequirements === "string" ? equipmentRequirements : null,
  );
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
    res.status(409).json({ error: "This event is no longer in Planning or Needs Review, or no longer assigned to you" });
    return;
  }

  const { data, error } = await supabase.from("events").select(EVENT_COLUMNS).eq("id", event.id).single();
  if (error) {
    res.status(500).json({ error: "Submitted for safety review, but failed to reload the event" });
    return;
  }

  // #105 row 1 (E7-2b): every Safety Officer and the organiser, closing the
  // gap this route's own AC9 comment used to defer to E7.
  if (event.organiser_id) {
    await getPublisher().publish({
      type: "safety.submitted",
      eventId: event.id,
      actorId: user.id,
      recipients: { userIds: [event.organiser_id], roles: ["safety_officer"] },
      data: { eventName: eventDisplayName(data as unknown as AssignmentEventRow) },
    });
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
safetyReviewRouter.post("/:id/safety-review/approve", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
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

  const recipients = [event.coordinator_id, event.organiser_id].filter(
    (id): id is string => typeof id === "string",
  );
  const eventName = ((data.submitted_details ?? {}) as Record<string, unknown>).name;

  // Migrated to RabbitMQ (ARD section 1.1, RabbitMQ.md #9 "safety.decided").
  await getPublisher().publish({
    type: "safety.decided",
    eventId: event.id,
    actorId: user.id,
    recipients: { userIds: recipients, roles: [] },
    data: { outcome: "approved", eventName: typeof eventName === "string" ? eventName : null },
  });

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
safetyReviewRouter.post("/:id/safety-review/reject", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
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
    // Migrated to RabbitMQ (ARD section 1.1, RabbitMQ.md #9 "safety.decided"),
    // same type the approve route already publishes.
    await getPublisher().publish({
      type: "safety.decided",
      eventId: event.id,
      actorId: user.id,
      recipients: { userIds: [event.coordinator_id], roles: [] },
      data: { outcome: "rejected", reason, eventName: typeof eventName === "string" ? eventName : null },
    });
  }

  res.json({ event: data, reviewId });
});

/**
 * E3-14: the Safety Officer requests specific changes, short of rejecting
 * (Safety Review -> Planning, AGENTS.md §3). At least one venue booking or
 * equipment reservation must be picked, each with what must change about it,
 * plus an optional general note (AC1, AC2). The picked arrangements are read from the services that own
 * them — so only this event's live ones can be flagged — and snapshotted,
 * so each flag can clear once its arrangement changes (AC3). The status
 * change, decision and flags land together in request_event_safety_changes
 * (migration 0035). Only the assigned coordinator is notified (AC1); a
 * failure to notify never blocks the already-committed decision.
 */
safetyReviewRouter.post("/:id/safety-review/request-changes", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
  const event = await authorizeSafetyOfficerReview(req, res, eventId);
  if (!event) return;

  if (event.status !== EVENT_STATUS.SafetyReview) {
    res.status(409).json({ error: "Changes can only be requested for an event in Safety Review" });
    return;
  }

  const parsed = parseChangeRequest(req.body);
  if (!parsed.valid) {
    res.status(400).json({ error: "Pick what must change and say what for each", fields: parsed.fields });
    return;
  }

  const authorization = req.headers.authorization!;
  const [bookings, equipment] = await Promise.all([
    fetchEventVenueBookings(event.id, authorization),
    fetchEventEquipmentRequests(event.id, authorization),
  ]);
  if (bookings.status === "error" || equipment.status === "error") {
    res.status(502).json({ error: "Couldn't load this event's venue bookings and equipment. Try again." });
    return;
  }

  const resolved = resolveFlags(parsed.request.arrangements, bookings.value, equipment.value);
  if (!resolved.ok) {
    res.status(400).json({
      error: "Some of the selected arrangements aren't this event's current venue bookings or equipment",
      fields: { arrangements: "Pick from this event's current venue bookings and equipment." },
      unknown: resolved.unknown,
    });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const reason = combinedReason(resolved.flags, parsed.request.generalNote);
  const { data: reviewId, error: requestError } = await supabase.rpc("request_event_safety_changes", {
    p_event_id: event.id,
    p_officer_id: user.id,
    p_reason: reason,
    p_general_note: parsed.request.generalNote,
    p_flags: resolved.flags,
  });
  if (requestError) {
    res.status(500).json({ error: "Failed to request changes" });
    return;
  }
  if (reviewId === null) {
    res.status(409).json({ error: "This event is no longer in Safety Review" });
    return;
  }

  const { data, error } = await supabase.from("events").select(EVENT_COLUMNS).eq("id", event.id).single();
  if (error) {
    res.status(500).json({ error: "Changes requested, but failed to reload the event" });
    return;
  }

  if (event.coordinator_id) {
    const eventName = ((data.submitted_details ?? {}) as Record<string, unknown>).name;
    // Migrated to RabbitMQ (ARD section 1.1, RabbitMQ.md #9 "safety.decided"),
    // same type the approve/reject routes already publish.
    await getPublisher().publish({
      type: "safety.decided",
      eventId: event.id,
      actorId: user.id,
      recipients: { userIds: [event.coordinator_id], roles: [] },
      data: { outcome: "changes_requested", reason, eventName: typeof eventName === "string" ? eventName : null },
    });
  }

  res.json({ event: data, reviewId });
});

interface SafetyChangeRequestView {
  reviewId: number;
  officerName: string | null;
  requestedAt: string;
  /** Every note combined, as recorded on the decision. */
  reason: string;
  generalNote: string | null;
  flags: { type: string; id: number; label: string; note: string; clearedAt: string | null }[];
  /** false when the arrangements couldn't be read, so changes weren't checked this time. */
  arrangementsChecked: boolean;
}

/**
 * E3-14 AC3: the event's open change request — only while the latest
 * safety decision is "Changes Requested" (a later approval or rejection
 * supersedes it). Each flag is compared with its arrangement's current
 * state, read with the caller's token from the owning service; a flag
 * whose arrangement changed is cleared for good. If the arrangements
 * can't be read, the flags are returned as stored.
 */
async function loadChangeRequest(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  eventId: number,
  authorization: string,
): Promise<{ status: "ok"; value: SafetyChangeRequestView | null } | { status: "error" }> {
  const { data: latest, error: latestError } = await supabase
    .from("event_safety_reviews")
    .select("id, outcome, reason, general_note, created_at, officer:officer_id(name)")
    .eq("event_id", eventId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) return { status: "error" };
  if (!latest || latest.outcome !== "Changes Requested") return { status: "ok", value: null };

  const { data: flagRows, error: flagsError } = await supabase
    .from("event_safety_review_flags")
    .select("id, arrangement_type, arrangement_id, label, note, snapshot, cleared_at")
    .eq("review_id", latest.id)
    .order("id");
  if (flagsError) return { status: "error" };
  const flags = (flagRows ?? []) as (StoredFlag & { id: number; label: string; note: string; cleared_at: string | null })[];

  const [bookings, equipment] = await Promise.all([
    fetchEventVenueBookings(eventId, authorization),
    fetchEventEquipmentRequests(eventId, authorization),
  ]);
  const arrangementsChecked = bookings.status === "ok" && equipment.status === "ok";
  if (bookings.status === "ok" && equipment.status === "ok") {
    const states = currentArrangements(bookings.value, equipment.value);
    const changed = flags.filter((flag) => !flag.cleared_at && hasChanged(flag, states));
    if (changed.length > 0) {
      const clearedAt = clock.now().toISOString();
      const { error: clearError } = await supabase
        .from("event_safety_review_flags")
        .update({ cleared_at: clearedAt })
        .in("id", changed.map((flag) => flag.id))
        .is("cleared_at", null);
      // A failed write only means the flags show as open until the next look.
      if (!clearError) for (const flag of changed) flag.cleared_at = clearedAt;
    }
  }

  const officer = latest.officer as { name?: string } | { name?: string }[] | null;
  return {
    status: "ok",
    value: {
      reviewId: latest.id,
      officerName: (Array.isArray(officer) ? officer[0]?.name : officer?.name) ?? null,
      requestedAt: latest.created_at,
      reason: latest.reason ?? "",
      generalNote: latest.general_note ?? null,
      flags: flags.map((flag) => ({
        type: flag.arrangement_type,
        id: Number(flag.arrangement_id),
        label: flag.label,
        note: flag.note,
        clearedAt: flag.cleared_at,
      })),
      arrangementsChecked,
    },
  };
}

/**
 * E3-14 AC3: the coordinator sees the flagged arrangements and the Safety
 * Officer's notes when they open the event; the Safety Officer and the
 * Coordinator Lead may read it too. `changeRequest` is null when there's
 * no open change request.
 */
safetyReviewRouter.get("/:id/safety-changes", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (!["coordinator", COORDINATOR_LEAD_ROLE, "safety_officer"].includes(user.role)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const eventId = routeParam(req.params.id);
  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { data: event, error } = await supabase.from("events").select("id").eq("id", Number(eventId)).maybeSingle();
  if (error) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const result = await loadChangeRequest(supabase, event.id, req.headers.authorization!);
  if (result.status === "error") {
    res.status(500).json({ error: "Failed to load the requested safety changes" });
    return;
  }
  res.json({ changeRequest: result.value });
});
