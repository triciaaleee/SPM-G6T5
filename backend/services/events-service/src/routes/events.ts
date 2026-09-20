import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { validateEventRequest } from "../lib/validateEventRequest.js";
import { isPositiveInteger } from "../lib/validation.js";
import { assignCoordinator } from "../lib/coordinatorAssignment.js";
import { diffSubmittedDetails } from "../lib/diffSubmittedDetails.js";

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
 * and stays visible to all coordinators (they already see every event
 * regardless of assignment, per E1-4.1) until one self-assigns by acting
 * on it.
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
 * List events. Coordinators get full pipeline visibility (all events);
 * everyone else sees only events they organised. Since the service-role
 * client bypasses RLS, this filter is the actual enforcement, not just
 * defense-in-depth.
 */
eventsRouter.get("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  let query = supabase.from("events").select(EVENT_COLUMNS);

  if (user.role !== "coordinator") {
    query = query.eq("organiser_id", user.id);
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

  if (!data || (!isOwner && !isCoordinator)) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { organiser_id, ...event } = data;
  res.json({ event });
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
    .select("id, status, organiser_id, submitted_details, status_before_clarification")
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

  if (existing.status !== "Clarification Requested") {
    res.status(409).json({ error: "This request isn't awaiting clarification" });
    return;
  }

  const result = validateEventRequest(req.body ?? {});
  if (!result.valid) {
    res.status(400).json({ error: "Validation failed", fields: result.fields });
    return;
  }

  // Restores whatever status the event was in before this clarification
  // was requested — "Requested" for the normal pre-approval case, but
  // "Planning" if a coordinator asked a follow-up after already approving.
  const restoredStatus = existing.status_before_clarification || "Requested";

  const { data, error } = await supabase
    .from("events")
    .update({
      submitted_details: result.value,
      status: restoredStatus,
      status_before_clarification: null,
    })
    .eq("id", existing.id)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to save your response" });
    return;
  }

  const diff = diffSubmittedDetails(
    (existing.submitted_details ?? {}) as Record<string, unknown>,
    result.value!,
  );

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

  res.json({ event: data });
});

/**
 * "Unassigned" (E2-6: no coordinator existed at submission time) is
 * treated everywhere below as equivalent to "Requested" — the event is
 * still pending review, just without an owner yet; whoever acts on it
 * self-assigns via authorizeCoordinatorReview's existing null-coordinator
 * branch.
 */
const PENDING_REVIEW_STATUSES = new Set(["Requested", "Unassigned"]);
const REJECTABLE_STATUSES = new Set(["Requested", "Unassigned", "Clarification Requested"]);

interface ReviewEventRow {
  id: number;
  status: string;
  coordinator_id: string | null;
}

/**
 * Shared entry checks for every coordinator decision route (approve/
 * reject/request-clarification): role, id format, existence, the AC5
 * "Rejected is terminal" rule, and the assign-on-first-action ownership
 * rule — any coordinator may act on an unassigned event; once assigned,
 * only that coordinator may act on it again. Sends the appropriate error
 * response and returns null if any check fails, otherwise returns the
 * event row for the caller to apply its own status-transition check to.
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

  if (data.coordinator_id && data.coordinator_id !== user.id) {
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
 * authorizeCoordinatorReview). Sets status to "Planning", self-assigning
 * the caller as coordinator if the event had none yet.
 */
eventsRouter.post("/:id/approve", async (req: AuthedRequest, res) => {
  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (!PENDING_REVIEW_STATUSES.has(event.status)) {
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
      coordinator_id: user.id,
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
      coordinator_id: user.id,
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
 * Statuses a coordinator can request clarification from: the normal
 * pending-review states, plus "Planning" — a coordinator may realise they
 * need more information after already approving an event. Either way the
 * event's current status is captured into status_before_clarification so
 * the organiser's response (PATCH /:id) knows whether to restore it to
 * "Requested" or back to "Planning".
 */
const CLARIFICATION_REQUESTABLE_STATUSES = new Set([...PENDING_REVIEW_STATUSES, "Planning"]);

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
      coordinator_id: user.id,
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
 * Shared visibility check for the clarification thread routes: same rule
 * as GET /:id (owning organiser, or any coordinator), but returns the
 * fields those routes need (organiser_id/coordinator_id/status) rather
 * than the full event payload.
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

  if (!data || (!isOwner && !isCoordinator)) {
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
    user.role === "coordinator" && (event.coordinator_id === null || event.coordinator_id === user.id);

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
