import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchEvent, fetchEventBookingInfo } from "../lib/eventsClient.js";
import { sendNotifications } from "../lib/notificationsClient.js";
import {
  validateEquipmentItems,
  validateStatusUpdate,
  type ValidatedEquipmentItem,
} from "../lib/validateEquipmentRequest.js";

/**
 * E5-1: an Event Coordinator records what equipment an event needs so
 * Technical Support Staff know what to arrange. equipment-service owns the
 * equipment_requests/equipment_request_items tables (AGENTS.md §1 names
 * "equipment" as the example new entity); the event itself is read through
 * events-service's REST API, never queried directly.
 */
export const equipmentRequestsRouter = Router();

equipmentRequestsRouter.use(requireAuth);

interface RequestRow {
  id: number;
  event_id: number;
  coordinator_id?: string;
  status: string;
  fulfillment_note?: string | null;
  created_at: string;
}

interface ItemRow {
  id: number;
  request_id: number;
  equipment_type: string;
  quantity: number;
  technical_requirements: string | null;
}

function toItem(row: ItemRow) {
  return {
    id: row.id,
    equipmentType: row.equipment_type,
    quantity: row.quantity,
    technicalRequirements: row.technical_requirements ?? "",
  };
}

function toRequest(row: RequestRow, items: ItemRow[]) {
  return {
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    // E5-3 AC2: what remains outstanding, set alongside "Partially Fulfilled".
    fulfillmentNote: row.fulfillment_note ?? null,
    createdAt: row.created_at,
    items: items.filter((item) => item.request_id === row.id).map(toItem),
  };
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

/**
 * AC1/AC3: the assigned coordinator submits a structured equipment request
 * for an event in Planning. Technical Support Staff are notified (best
 * effort — a failure here doesn't undo the request, same stance as venue
 * block-out notifications) and can view it via GET below.
 */
equipmentRequestsRouter.post("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  if (user.role !== "coordinator") {
    res.status(403).json({ error: "Only coordinators can record equipment requirements" });
    return;
  }

  const body = (req.body ?? {}) as { eventId?: unknown; items?: unknown };
  const rawEventId = typeof body.eventId === "number" ? String(body.eventId) : String(body.eventId ?? "");
  if (!isPositiveInteger(rawEventId)) {
    res.status(400).json({ error: "A valid eventId is required" });
    return;
  }
  const eventId = Number(rawEventId);

  const itemsResult = validateEquipmentItems(body.items);
  if (!itemsResult.valid) {
    res.status(400).json({ error: "Validation failed", fields: itemsResult.fields });
    return;
  }
  const items = itemsResult.value as ValidatedEquipmentItem[];

  const eventResult = await fetchEvent(eventId, req.headers.authorization!);
  if (eventResult.status === "not_found") {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  if (eventResult.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }
  const { event } = eventResult;

  // AC1: "Given an event in Planning". The story is the assigned
  // coordinator's — same ownership rule E3-7 already applies to editing
  // event details during Planning.
  if (event.coordinator_id !== user.id) {
    res.status(403).json({ error: "Only the assigned coordinator can record equipment requirements" });
    return;
  }
  if (event.status !== "Planning") {
    res.status(409).json({ error: "Equipment requirements can only be recorded while the event is in Planning." });
    return;
  }

  const { data: requestRow, error: requestError } = await supabase
    .from("equipment_requests")
    .insert({ event_id: eventId, coordinator_id: user.id })
    .select("id, event_id, status, fulfillment_note, created_at")
    .single();

  if (requestError || !requestRow) {
    res.status(500).json({ error: "Failed to record the equipment request" });
    return;
  }

  const { data: itemRows, error: itemsError } = await supabase
    .from("equipment_request_items")
    .insert(
      items.map((item) => ({
        request_id: requestRow.id,
        equipment_type: item.equipmentType,
        quantity: item.quantity,
        technical_requirements: item.technicalRequirements || null,
      })),
    )
    .select("id, request_id, equipment_type, quantity, technical_requirements");

  if (itemsError || !itemRows) {
    // Best-effort cleanup so a failed item insert doesn't leave an empty,
    // orphaned request behind.
    await supabase.from("equipment_requests").delete().eq("id", requestRow.id);
    res.status(500).json({ error: "Failed to record the equipment items" });
    return;
  }

  const { data: technicalSupportStaff } = await supabase.from("users").select("id").eq("role", "technical_support");

  const eventName = (event.submitted_details?.name as string | undefined) || `Event #${eventId}`;
  const notified =
    technicalSupportStaff && technicalSupportStaff.length > 0
      ? await sendNotifications(
          technicalSupportStaff.map((staff) => ({
            recipientId: staff.id as string,
            type: "equipment_request_submitted",
            title: "New equipment request",
            body: `${eventName} needs ${items.length} equipment item${items.length === 1 ? "" : "s"} arranged.`,
            link: `/events/${eventId}`,
          })),
          req.headers.authorization!,
        )
      : true;

  res.status(201).json({ equipmentRequest: toRequest(requestRow as RequestRow, itemRows as ItemRow[]), notified });
});

/**
 * AC1: Technical Support Staff view incoming requests; a coordinator views
 * the requests they've already recorded for one event. `?eventId=` scopes
 * to one event (used by the event detail page); without it, only
 * Technical Support may list every outstanding request.
 */
equipmentRequestsRouter.get("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const rawEventId = typeof req.query.eventId === "string" ? req.query.eventId : undefined;

  if (user.role === "coordinator") {
    if (!rawEventId || !isPositiveInteger(rawEventId)) {
      res.status(400).json({ error: "A valid eventId is required" });
      return;
    }
    const eventId = Number(rawEventId);

    // Reuses events-service's own access check (owning organiser or any
    // coordinator may view) rather than re-deriving it here.
    const eventResult = await fetchEvent(eventId, req.headers.authorization!);
    if (eventResult.status === "not_found") {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    if (eventResult.status === "error") {
      res.status(502).json({ error: "Failed to load the event" });
      return;
    }

    const { data: requests, error: requestsError } = await supabase
      .from("equipment_requests")
      .select("id, event_id, status, fulfillment_note, created_at")
      .eq("event_id", eventId);

    if (requestsError || !requests) {
      res.status(500).json({ error: "Failed to load equipment requests" });
      return;
    }

    const requestIds = requests.map((r) => r.id);
    const { data: itemRows, error: itemRowsError } =
      requestIds.length === 0
        ? { data: [] as ItemRow[], error: null }
        : await supabase
            .from("equipment_request_items")
            .select("id, request_id, equipment_type, quantity, technical_requirements")
            .in("request_id", requestIds);

    if (itemRowsError) {
      res.status(500).json({ error: "Failed to load equipment items" });
      return;
    }

    res.json({
      equipmentRequests: (requests as RequestRow[]).map((r) => toRequest(r, (itemRows ?? []) as ItemRow[])),
    });
    return;
  }

  if (user.role !== "technical_support") {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data: requests, error: requestsError } = await supabase
    .from("equipment_requests")
    .select("id, event_id, status, fulfillment_note, created_at")
    .order("created_at", { ascending: false });

  if (requestsError || !requests) {
    res.status(500).json({ error: "Failed to load equipment requests" });
    return;
  }

  const requestIds = (requests as RequestRow[]).map((r) => r.id);
  const { data: itemRows, error: itemRowsError } =
    requestIds.length === 0
      ? { data: [] as ItemRow[], error: null }
      : await supabase
          .from("equipment_request_items")
          .select("id, request_id, equipment_type, quantity, technical_requirements")
          .in("request_id", requestIds);

  if (itemRowsError) {
    res.status(500).json({ error: "Failed to load equipment items" });
    return;
  }

  const eventIds = [...new Set((requests as RequestRow[]).map((r) => r.event_id))];
  const infoResult = await fetchEventBookingInfo(eventIds, req.headers.authorization!);
  const eventsById = new Map(
    infoResult.status === "ok" ? infoResult.events.map((event) => [event.id, event]) : [],
  );

  res.json({
    equipmentRequests: (requests as RequestRow[]).map((r) => ({
      ...toRequest(r, (itemRows ?? []) as ItemRow[]),
      event: eventsById.get(r.event_id) ?? null,
    })),
  });
});

function statusNotificationBody(status: string, note: string | null, eventName: string): string {
  if (status === "Partially Fulfilled") {
    return `${eventName}'s equipment request is only partially fulfilled: ${note}`;
  }
  return `${eventName}'s equipment request is now ${status}.`;
}

/**
 * E5-3: Technical Support update a request's status as arrangements are
 * made (AC1) — including recording it as only partially fulfilled, with a
 * note on what remains outstanding (AC2). The assigned coordinator (stored
 * on the row since it was created, E5-1) is notified either way; the new
 * status is visible to them via the GET endpoints above.
 */
equipmentRequestsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  if (user.role !== "technical_support") {
    res.status(403).json({ error: "Only Technical Support can update a request's status" });
    return;
  }

  if (!isPositiveInteger(req.params.id)) {
    res.status(400).json({ error: "A valid request id is required" });
    return;
  }
  const requestId = Number(req.params.id);

  const statusResult = validateStatusUpdate((req.body ?? {}) as { status?: unknown; note?: unknown });
  if (!statusResult.valid) {
    res.status(400).json({ error: "Validation failed", fields: statusResult.fields });
    return;
  }
  const { status, note } = statusResult.value!;

  const { data: requestRow, error: requestError } = await supabase
    .from("equipment_requests")
    .update({ status, fulfillment_note: note })
    .eq("id", requestId)
    .select("id, event_id, coordinator_id, status, fulfillment_note, created_at")
    .maybeSingle();

  if (requestError) {
    res.status(500).json({ error: "Failed to update the equipment request" });
    return;
  }
  if (!requestRow) {
    res.status(404).json({ error: "Equipment request not found" });
    return;
  }

  const { data: itemRows, error: itemsError } = await supabase
    .from("equipment_request_items")
    .select("id, request_id, equipment_type, quantity, technical_requirements")
    .eq("request_id", requestId);

  if (itemsError) {
    res.status(500).json({ error: "Failed to load equipment items" });
    return;
  }

  // Best-effort, same stance as E5-1's submission notice: a friendlier
  // event name if events-service answers, "Event #n" if it doesn't.
  const infoResult = await fetchEventBookingInfo([requestRow.event_id], req.headers.authorization!);
  const eventName =
    (infoResult.status === "ok" && infoResult.events[0]?.name) || `Event #${requestRow.event_id}`;

  const notified = await sendNotifications(
    [
      {
        recipientId: requestRow.coordinator_id as string,
        type: "equipment_request_status_updated",
        title: `Equipment request ${status.toLowerCase()}`,
        body: statusNotificationBody(status, note, eventName),
        link: `/events/${requestRow.event_id}`,
      },
    ],
    req.headers.authorization!,
  );

  res.json({ equipmentRequest: toRequest(requestRow as RequestRow, itemRows as ItemRow[]), notified });
});
