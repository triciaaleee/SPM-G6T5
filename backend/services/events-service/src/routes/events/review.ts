import { Router } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { EVENT_STATUS } from "../../lib/eventStatus.js";
import { getPublisher } from "../../lib/rabbitPublisher.js";
import {
  routeParam,
  EVENT_COLUMNS,
  authorizeCoordinatorReview,
  loadEventForClarification,
  type AssignmentEventRow,
  eventDisplayName,
} from "./shared.js";
import { clock } from "../../lib/clock.js";

/**
 * Review controller: the assigned coordinator asks the organiser questions
 * (clarifications, E2-9/E2-10), then approves the request into Planning or
 * rejects it with a reason.
 */

export const reviewRouter = Router();

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
 * E1-4.2 AC1 / E2-3: approve — from "Requested", or from "Clarification
 * Requested" once every top-level question raised on this event has been
 * marked resolved (an event already decided is blocked upstream in
 * authorizeCoordinatorReview). Sets status to "Planning".
 */
reviewRouter.post("/:id/approve", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
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
      decided_at: clock.now().toISOString(),
      decided_by: user.id,
    })
    .eq("id", event.id)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to approve event request" });
    return;
  }

  // #104 row 7: the organiser is the only recipient of the decision.
  if (event.organiser_id) {
    await getPublisher().publish({
      type: "request.decided",
      eventId: event.id,
      actorId: user.id,
      recipients: { userIds: [event.organiser_id], roles: [] },
      data: { eventName: eventDisplayName(data as unknown as AssignmentEventRow), decision: "approved" },
    });
  }

  res.json({ event: data });
});

/**
 * E1-4.2 AC2/AC3/AC5: reject — requires a reason, allowed from "Requested"
 * or "Clarification Requested" (an event already in Planning is out of
 * this story's scope; already-Rejected is blocked upstream in
 * authorizeCoordinatorReview per AC5).
 */
reviewRouter.post("/:id/reject", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
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
      decided_at: clock.now().toISOString(),
      decided_by: user.id,
    })
    .eq("id", event.id)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to reject event request" });
    return;
  }

  // #104 row 7: the organiser is the only recipient of the decision.
  if (event.organiser_id) {
    await getPublisher().publish({
      type: "request.decided",
      eventId: event.id,
      actorId: user.id,
      recipients: { userIds: [event.organiser_id], roles: [] },
      data: { eventName: eventDisplayName(data as unknown as AssignmentEventRow), decision: "rejected", reason },
    });
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
reviewRouter.post("/:id/request-clarification", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
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
      decided_at: clock.now().toISOString(),
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

  // #104 row 5: the organiser is the only recipient — there's always one,
  // since only an organiser can submit a request in the first place.
  if (event.organiser_id) {
    await getPublisher().publish({
      type: "clarification.requested",
      eventId: event.id,
      actorId: user.id,
      recipients: { userIds: [event.organiser_id], roles: [] },
      data: { eventName: eventDisplayName(data as unknown as AssignmentEventRow), message },
    });
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

/** AC3: the full exchange, chronological, for anyone with access to the event. */
reviewRouter.get("/:id/clarifications", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
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
reviewRouter.post("/:id/clarifications", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
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
reviewRouter.post("/:id/clarifications/:questionId/replies", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
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

  const questionId = routeParam(req.params.questionId);
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
reviewRouter.post("/:id/clarifications/:questionId/resolve", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (event.status !== "Clarification Requested") {
    res.status(409).json({ error: "Questions can only be resolved while clarification is outstanding" });
    return;
  }

  const questionId = routeParam(req.params.questionId);
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
