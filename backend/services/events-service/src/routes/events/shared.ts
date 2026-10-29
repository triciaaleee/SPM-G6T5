import type { Response } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { EVENT_STATUS } from "../../lib/eventStatus.js";

/**
 * Helpers every events controller shares: the event column list, the
 * audit writers (event history, access denials) and the checks that load an
 * event for a caller who is allowed to act on it.
 */

/**
 * Week 7 change 5: the Event Coordinator Lead oversees incoming requests,
 * assigns them (E2-13) and reassigns them (E2-12). Read-only on the event
 * itself: the Lead never edits, approves or rejects (E1-8 AC2).
 */
export const COORDINATOR_LEAD_ROLE = "coordinator_lead";

/** A route parameter as a single string (Express types a repeated one as an array). */
export function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

export async function recordAccessDenial(
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
export async function recordEventHistory(
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
export const EVENT_COLUMNS =
  "id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override";

export interface ReviewEventRow {
  id: number;
  status: string;
  coordinator_id: string | null;
  organiser_id: string | null;
  submitted_details?: Record<string, unknown> | null;
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
export async function authorizeCoordinatorReview(
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
    .select("id, status, coordinator_id, organiser_id, submitted_details")
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

/** Whether the event has ever been submitted for safety review (E3-4). */
export async function hasSafetySubmission(supabase: NonNullable<AuthedRequest["supabase"]>, eventId: number): Promise<boolean> {
  const { data } = await supabase
    .from("event_safety_submissions")
    .select("id")
    .eq("event_id", eventId)
    .limit(1)
    .maybeSingle();
  return data !== null;
}

/**
 * Shared visibility check for the clarification thread and history routes:
 * same rule as GET /:id (owning organiser, any coordinator, or the Event
 * Coordinator Lead for a submitted event — E2-12 AC2 has the Lead read a
 * reassignment back from the history), but returns the fields those routes
 * need (organiser_id/coordinator_id/status) rather than the full event
 * payload. Write routes apply their own, narrower check on top.
 */
export async function loadEventForClarification(
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
  // Drafts sit outside the process (AGENTS.md §3): only their organiser sees them.
  const isCoordinator = user.role === "coordinator" && data?.status !== EVENT_STATUS.Draft;
  const isLead = user.role === COORDINATOR_LEAD_ROLE && data?.status !== EVENT_STATUS.Draft;

  if (!data || (!isOwner && !isCoordinator && !isLead)) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return null;
  }

  return data;
}

export interface AssignmentEventRow {
  id: number;
  status: string;
  organiser_id: string;
  coordinator_id: string | null;
  coordinator: { name: string } | null;
  submitted_details: Record<string, unknown> | null;
}

export function eventDisplayName(event: AssignmentEventRow): string {
  const name = event.submitted_details?.name;
  return typeof name === "string" && name.trim() ? name.trim() : `Event #${event.id}`;
}
