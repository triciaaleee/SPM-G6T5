import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { CLOSED_EVENT_STATUSES, EVENT_STATUS } from "../../lib/eventStatus.js";
import { getPublisher } from "../../lib/rabbitPublisher.js";
import { fetchCoordinators } from "../../lib/usersClient.js";
import {
  COORDINATOR_LEAD_ROLE,
  recordAccessDenial,
  recordEventHistory,
  EVENT_COLUMNS,
  type AssignmentEventRow,
  eventDisplayName,
} from "./shared.js";

/**
 * Assignment controller: the Event Coordinator Lead sees the unassigned queue
 * and assigns (E2-13) or reassigns (E2-12) a coordinator.
 */

export const assignmentRouter = Router();

/**
 * E1-8 AC1/AC3: the Event Coordinator Lead's unassigned queue — every
 * submitted request still waiting for a coordinator, oldest submission
 * first so the longest-waiting request is allocated first. Lead only; any
 * other role is denied and the attempt recorded, same as a direct-URL
 * attempt on someone else's event. Declared before GET /:id so
 * "unassigned" isn't read as an event id.
 */
assignmentRouter.get("/unassigned", async (req: AuthedRequest, res) => {
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
assignmentRouter.post("/:id/assign", async (req: AuthedRequest, res) => {
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

  // Migrated to RabbitMQ (ARD section 1.1): notification-service's
  // existing consumer renders this into the coordinator's and organiser's
  // notifications (notification-service/src/lib/messageTemplates.ts).
  const published = await getPublisher().publish({
    type: "coordinator.assigned",
    eventId: event.id,
    actorId: user.id,
    recipients: { userIds: [coordinator.id, event.organiser_id], roles: [] },
    data: {
      eventName,
      coordinatorId: coordinator.id,
      coordinatorName: coordinator.name,
      organiserId: event.organiser_id,
    },
  });

  res.json({ event: data, notificationsFailed: !published });
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
assignmentRouter.post("/:id/reassign", async (req: AuthedRequest, res) => {
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

  // Migrated to RabbitMQ (ARD section 1.1, RabbitMQ.md #4 "coordinator.reassigned").
  const published = await getPublisher().publish({
    type: "coordinator.reassigned",
    eventId: event.id,
    actorId: user.id,
    recipients: { userIds: [event.organiser_id, previousCoordinatorId, coordinator.id], roles: [] },
    data: {
      eventName,
      organiserId: event.organiser_id,
      newCoordinatorId: coordinator.id,
      newCoordinatorName: coordinator.name,
      previousCoordinatorId,
      previousCoordinatorName,
    },
  });

  res.json({ event: data, notificationsFailed: !published });
});
