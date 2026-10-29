import { Router } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { EVENT_STATUS } from "../../lib/eventStatus.js";
import { publishDurably } from "../../lib/outbox.js";
import { eventEndsAt, hasEventEnded } from "../../lib/eventTiming.js";
import {
  routeParam,
  recordAccessDenial,
  recordEventHistory,
  EVENT_COLUMNS,
  authorizeCoordinatorReview,
  type AssignmentEventRow,
  eventDisplayName,
} from "./shared.js";
import { clock } from "../../lib/clock.js";

/**
 * Lifecycle controller: the organiser cancels an event with a reason (E3-6),
 * and the assigned coordinator marks a Confirmed event Completed once it has
 * ended.
 */

export const lifecycleRouter = Router();

/**
 * E3-6 / AGENTS.md §3 transitions table: every active stage the owning
 * Organiser may cancel from — everything except `Draft` (delete it
 * instead) and the three terminal statuses, which are already excluded by
 * this being an allowlist.
 */
const CANCELLABLE_STATUSES = new Set<string>([
  EVENT_STATUS.Unassigned,
  EVENT_STATUS.Requested,
  EVENT_STATUS.ClarificationRequested,
  EVENT_STATUS.Planning,
  EVENT_STATUS.SafetyReview,
  EVENT_STATUS.Confirmed,
  EVENT_STATUS.NeedsReview,
]);

/**
 * E3-6: the owning Organiser cancels their own event with a required
 * reason. AC1: automatic — no coordinator approval (the customer's answer
 * to PRD Q2) — the assigned coordinator is just notified with the reason,
 * or every Event Coordinator Lead if the event is still Unassigned (AC1,
 * AGENTS.md §3). AC2-AC5 (releasing venue bookings and equipment,
 * notifying attendees) are each handled in the service that owns that
 * data: this route only flips the status and publishes `event.cancelled`
 * (RabbitMQ.md #14); venue-service, equipment-service and
 * registration-service each consume that same message and publish their
 * own follow-up (RabbitMQ.md section 3.3-3.5, #33/#34/#35). AC6: nothing
 * here deletes anything, so the cancelled event's record and history stay
 * viewable exactly like every other closed event.
 *
 * The update only matches while the event is still in the status just
 * checked, so a concurrent decision (e.g. a Safety Officer rejecting it)
 * between the checks and the write loses the race cleanly with a 409
 * instead of cancelling a status that no longer applies.
 */
lifecycleRouter.post("/:id/cancel", async (req: AuthedRequest, res) => {
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
    .select("id, status, organiser_id, coordinator_id")
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

  if (!CANCELLABLE_STATUSES.has(existing.status)) {
    res.status(409).json({
      error:
        existing.status === EVENT_STATUS.Draft
          ? "This is still a draft — delete it instead of cancelling it."
          : `This event is ${existing.status} and can no longer be cancelled.`,
    });
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "A reason is required to cancel an event" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .update({
      status: EVENT_STATUS.Cancelled,
      review_outcome: reason,
      decided_at: clock.now().toISOString(),
      decided_by: user.id,
    })
    .eq("id", existing.id)
    .eq("status", existing.status)
    .select(EVENT_COLUMNS)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to cancel this event" });
    return;
  }
  if (!data) {
    res.status(409).json({ error: "This event changed while you were cancelling it. Refresh and try again." });
    return;
  }

  await recordEventHistory(
    supabase,
    existing.id,
    [
      { field: "Status", oldValue: existing.status, newValue: EVENT_STATUS.Cancelled },
      { field: "Cancellation reason", oldValue: null, newValue: reason },
    ],
    user.id,
  );

  const eventName = eventDisplayName(data as unknown as AssignmentEventRow);

  // RabbitMQ.md #14: the organiser's own confirmation, and whoever is
  // notified with the reason — the assigned coordinator, or every Lead if
  // nobody is assigned yet.
  // Other services act on this message (they release the event's bookings,
  // reservations and registrations), so it goes through the outbox and is
  // retried until the broker confirms it.
  const published = await publishDurably(supabase, {
    type: "event.cancelled",
    eventId: existing.id,
    actorId: user.id,
    recipients: existing.coordinator_id
      ? { userIds: [user.id, existing.coordinator_id], roles: [] }
      : { userIds: [user.id], roles: ["coordinator_lead"] },
    data: { eventName, reason },
  });

  res.json({ event: data, notificationsFailed: !published });
});

/**
 * E3-5: the assigned coordinator marks an event completed once it has run
 * (Confirmed -> Completed, AGENTS.md §3). AC1: only from Confirmed, which
 * every event reaches through the Safety Officer's approval. AC2: blocked
 * until the event's end time has passed (Singapore time, lib/eventTiming.ts).
 * AC3: nothing is deleted or released — the event's details, history,
 * venue bookings, equipment reservations and registrations all stay as
 * they are, so its full record remains viewable. decided_at/decided_by are
 * left alone (they hold the coordinator's original review decision); who
 * completed it and when goes into the event history instead.
 *
 * The update only matches while the event is still Confirmed and still
 * assigned to the caller, so a concurrent reassignment, cancellation or
 * re-review between the checks and the write makes it a 409 instead.
 */
lifecycleRouter.post("/:id/complete", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (event.status !== EVENT_STATUS.Confirmed) {
    res.status(409).json({ error: "Only a Confirmed event can be marked completed" });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const { data: detailsRow, error: detailsError } = await supabase
    .from("events")
    .select("submitted_details")
    .eq("id", event.id)
    .single();
  if (detailsError) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }

  const details = (detailsRow?.submitted_details ?? {}) as Record<string, unknown>;
  if (!hasEventEnded(details)) {
    const endsAt = eventEndsAt(details);
    res.status(409).json({
      error: endsAt
        ? `This event hasn't finished yet. It can be marked completed after it ends (${details.proposedDate} ${details.endTime ?? "end of day"}).`
        : "This event has no valid date and end time, so it can't be marked completed.",
    });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .update({ status: EVENT_STATUS.Completed })
    .eq("id", event.id)
    .eq("status", EVENT_STATUS.Confirmed)
    .eq("coordinator_id", user.id)
    .select(EVENT_COLUMNS)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to mark the event completed" });
    return;
  }
  if (!data) {
    res.status(409).json({ error: "This event is no longer Confirmed or no longer assigned to you" });
    return;
  }

  await recordEventHistory(
    supabase,
    event.id,
    [{ field: "Status", oldValue: EVENT_STATUS.Confirmed, newValue: EVENT_STATUS.Completed }],
    user.id,
  );

  res.json({ event: data });
});
