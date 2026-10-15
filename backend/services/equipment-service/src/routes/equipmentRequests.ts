import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchEvent, fetchEventBookingInfo, type EquipmentBookingInfo } from "../lib/eventsClient.js";
import { claimUnits, recordClaims, releaseUnitsForItem } from "../lib/equipmentConflicts.js";
import { getPublisher } from "../lib/rabbitPublisher.js";
import { computeReservationFlags, type ReservationFlag } from "../lib/reservationFlags.js";
import { releaseEquipmentForEvent } from "../lib/eventCancellation.js";
import { occupiedWindow, type OccupiedWindow } from "../lib/scheduleWindow.js";
import {
  validateEquipmentItems,
  validateStatusUpdate,
  type StatusUpdateItem,
  type ValidatedEquipmentItem,
} from "../lib/validateEquipmentRequest.js";

/**
 * E5-1: an Event Coordinator records what equipment an event needs so
 * Technical Support Staff know what to arrange. equipment-service owns the
 * equipment_requests/equipment_request_items tables (AGENTS.md §1 names
 * "equipment" as the example new entity); the event itself is read through
 * events-service's REST API, never queried directly.
 *
 * E5-6: this file's PATCH handler is also where equipment actually gets
 * reserved — see its own docstring below.
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
  quantity_fulfilled?: number;
}

const ITEM_COLUMNS = "id, request_id, equipment_type, quantity, quantity_fulfilled";

const NO_FLAG: ReservationFlag = { flagged: false, reason: null };

function toItem(row: ItemRow, flag: ReservationFlag = NO_FLAG) {
  return {
    id: row.id,
    equipmentType: row.equipment_type,
    quantity: row.quantity,
    // E5-3: how much of this item has actually been taken off the shelf
    // under the request's current status (migration 0022).
    quantityFulfilled: row.quantity_fulfilled ?? 0,
    // E5-6 AC3: whether this item's claimed units no longer hold, given
    // every involved event's current schedule.
    reservationFlag: flag,
  };
}

function toRequest(row: RequestRow, items: ItemRow[], flagsByItemId?: Map<number, ReservationFlag>) {
  return {
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    // E5-3 AC2: what remains outstanding, set alongside "Partially Fulfilled".
    fulfillmentNote: row.fulfillment_note ?? null,
    createdAt: row.created_at,
    items: items
      .filter((item) => item.request_id === row.id)
      .map((item) => toItem(item, flagsByItemId?.get(item.id))),
  };
}

/** The window of an events-service record shaped like `EquipmentBookingInfo`. */
function windowOf(event: EquipmentBookingInfo | undefined): OccupiedWindow | null {
  return event ? occupiedWindow(event) : null;
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

  // Resolve each item's catalog id to the stock row it'll draw from
  // (migration 0022) — equipment_type is stored denormalised from the
  // catalog's name at submission time, same as event name snapshots
  // elsewhere, so a later rename doesn't rewrite history.
  const catalogIds = [...new Set(items.map((item) => item.equipmentCatalogId))];
  const { data: catalogRows, error: catalogError } = await supabase
    .from("equipment_catalog")
    .select("id, name")
    .in("id", catalogIds);

  if (catalogError) {
    res.status(500).json({ error: "Failed to validate the equipment items" });
    return;
  }
  const catalogNameById = new Map((catalogRows ?? []).map((row) => [row.id as number, row.name as string]));
  const catalogFields: Record<string, string> = {};
  items.forEach((item, index) => {
    if (!catalogNameById.has(item.equipmentCatalogId)) {
      catalogFields[`items[${index}].equipmentCatalogId`] = "Select a valid equipment type.";
    }
  });
  if (Object.keys(catalogFields).length > 0) {
    res.status(400).json({ error: "Validation failed", fields: catalogFields });
    return;
  }

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
        equipment_catalog_id: item.equipmentCatalogId,
        equipment_type: catalogNameById.get(item.equipmentCatalogId)!,
        quantity: item.quantity,
      })),
    )
    .select(ITEM_COLUMNS);

  if (itemsError || !itemRows) {
    // Best-effort cleanup so a failed item insert doesn't leave an empty,
    // orphaned request behind.
    await supabase.from("equipment_requests").delete().eq("id", requestRow.id);
    res.status(500).json({ error: "Failed to record the equipment items" });
    return;
  }

  // #107 row 4 ("raised"), RabbitMQ.md #26 `equipment.requested`. Lets
  // notification-service resolve technical_support itself (recipients.roles)
  // instead of equipment-service reading user-service's table directly.
  const eventName = (event.submitted_details?.name as string | undefined) || `Event #${eventId}`;
  const notified = await getPublisher().publish({
    type: "equipment.requested",
    eventId,
    actorId: user.id,
    recipients: { userIds: [], roles: ["technical_support"] },
    data: { eventName, itemCount: items.length },
  });

  res.status(201).json({ equipmentRequest: toRequest(requestRow as RequestRow, itemRows as ItemRow[]), notified });
});

/**
 * AC1: Technical Support Staff view incoming requests; a coordinator or the
 * owning organiser views the requests already recorded for one event (the
 * organiser has no form to submit one, but still needs to see arrangement
 * status — E3-1 AC3's "Outstanding Arrangements" line reads this). `?eventId=`
 * scopes to one event (used by the event detail page); without it, only
 * Technical Support may list every outstanding request.
 */
equipmentRequestsRouter.get("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const rawEventId = typeof req.query.eventId === "string" ? req.query.eventId : undefined;

  // E3-14: the Safety Officer reads an event's equipment to flag what must
  // change — read-only, and events-service decides which events (those
  // submitted for safety review).
  if (user.role === "coordinator" || user.role === "organiser" || user.role === "safety_officer") {
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
            .select(ITEM_COLUMNS)
            .in("request_id", requestIds);

    if (itemRowsError) {
      res.status(500).json({ error: "Failed to load equipment items" });
      return;
    }

    // AC3: re-check every item's claimed units against this event's current
    // schedule (fetchEvent's submitted_details carries the same proposedDate/
    // startTime/endTime fields the venue-booking-info batch lookup returns).
    const details = (eventResult.event.submitted_details ?? {}) as Record<string, unknown>;
    const eventWindow = occupiedWindow({
      proposedDate: details.proposedDate as string | undefined,
      startTime: details.startTime as string | undefined,
      endTime: details.endTime as string | undefined,
    });
    const allItems = (itemRows ?? []) as ItemRow[];
    const itemEventIds = new Map(allItems.map((item) => [item.id, eventId]));
    const knownWindows = eventWindow ? new Map([[eventId, eventWindow]]) : new Map<number, OccupiedWindow>();
    const flagsByItemId = await computeReservationFlags(supabase, itemEventIds, knownWindows, req.headers.authorization!);

    res.json({
      equipmentRequests: (requests as RequestRow[]).map((r) => toRequest(r, allItems, flagsByItemId)),
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
          .select(ITEM_COLUMNS)
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

  // AC3: same re-check as the per-event branch above, batched across every
  // request Technical Support can see in one go.
  const allItems = (itemRows ?? []) as ItemRow[];
  const requestEventById = new Map((requests as RequestRow[]).map((r) => [r.id, r.event_id]));
  const itemEventIds = new Map(allItems.map((item) => [item.id, requestEventById.get(item.request_id)!]));
  const knownWindows = new Map<number, OccupiedWindow>();
  for (const [id, event] of eventsById) {
    const window = windowOf(event);
    if (window) knownWindows.set(id, window);
  }
  const flagsByItemId = await computeReservationFlags(supabase, itemEventIds, knownWindows, req.headers.authorization!);

  res.json({
    equipmentRequests: (requests as RequestRow[]).map((r) => ({
      ...toRequest(r, allItems, flagsByItemId),
      event: eventsById.get(r.event_id) ?? null,
    })),
  });
});

/** The real values quantity_fulfilled can move between, to size a claim/release delta. */
function targetFulfilledByItem(
  status: "Requested" | "Arranged" | "Partially Fulfilled",
  items: { id: number; quantity: number }[],
  fulfillments: { itemId: number; fulfilledQuantity: number }[],
): Map<number, number> {
  const map = new Map<number, number>();
  if (status === "Requested") {
    for (const item of items) map.set(item.id, 0);
  } else if (status === "Arranged") {
    for (const item of items) map.set(item.id, item.quantity);
  } else {
    for (const f of fulfillments) map.set(f.itemId, f.fulfilledQuantity);
  }
  return map;
}

/**
 * E5-3: Technical Support update a request's status as arrangements are
 * made (AC1) — including recording it as only partially fulfilled, with a
 * note on what remains outstanding (AC2). The assigned coordinator (stored
 * on the row since it was created, E5-1) is notified either way; the new
 * status is visible to them via the GET endpoints above.
 *
 * E5-6: moving an item's quantity_fulfilled up is also the moment it's
 * actually reserved (AC1) — specific equipment_booking rows get claimed for
 * the event's own date/time window, not just a flat catalog count. Moving
 * it down (reverting a status, or lowering a partial fulfilment) releases
 * that many of the item's claimed units back.
 *
 * The per-unit claim has to happen here in the application layer rather
 * than inside apply_equipment_request_status (migration 0022) — unlike the
 * flat catalog math, it needs every *other* booking's owning event's
 * current schedule, which only events-service knows, over HTTP. So this
 * route: (1) pre-checks claimability for AC2 before touching anything, (2)
 * runs the existing atomic stock move, then (3) records the claims/releases
 * the stock move just paid for. If (3) fails after (2) already committed,
 * it's rolled back with a corrective call to the same RPC — best-effort,
 * same stance as POST's own cleanup above, not a true distributed
 * transaction (same documented limitation as venue-service's booking
 * decisions, AGENTS.md §3a).
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

  const { data: existingRequest, error: existingRequestError } = await supabase
    .from("equipment_requests")
    .select("id, event_id, status, fulfillment_note")
    .eq("id", requestId)
    .maybeSingle();

  if (existingRequestError) {
    res.status(500).json({ error: "Failed to load the equipment request" });
    return;
  }
  if (!existingRequest) {
    res.status(404).json({ error: "Equipment request not found" });
    return;
  }

  // Needed up front: Partially Fulfilled validates a fulfilled quantity
  // per item (0..its requested quantity), and a request with no items
  // never exists (POST always inserts at least one alongside it).
  const { data: existingItems, error: existingItemsError } = await supabase
    .from("equipment_request_items")
    .select("id, quantity, quantity_fulfilled, equipment_type")
    .eq("request_id", requestId);

  if (existingItemsError) {
    res.status(500).json({ error: "Failed to load equipment items" });
    return;
  }
  if (!existingItems || existingItems.length === 0) {
    res.status(404).json({ error: "Equipment request not found" });
    return;
  }

  const statusResult = validateStatusUpdate(
    (req.body ?? {}) as { status?: unknown; note?: unknown; fulfillments?: unknown },
    existingItems as StatusUpdateItem[],
  );
  if (!statusResult.valid) {
    res.status(400).json({ error: "Validation failed", fields: statusResult.fields });
    return;
  }
  const { status, note, fulfillments } = statusResult.value!;

  const items = existingItems as (ItemRow & { quantity_fulfilled: number })[];
  const targetByItem = targetFulfilledByItem(status, items, fulfillments);
  const deltas = items.map((item) => ({
    item,
    delta: (targetByItem.get(item.id) ?? 0) - (item.quantity_fulfilled ?? 0),
  }));

  // AC1/AC2: only items growing their claim (delta > 0) need the event's
  // own window — reverting a status only releases, which needs no check.
  let eventWindow: OccupiedWindow | null = null;
  if (deltas.some((d) => d.delta > 0)) {
    const infoResult = await fetchEventBookingInfo([existingRequest.event_id], req.headers.authorization!);
    if (infoResult.status === "error") {
      res.status(502).json({ error: "Failed to load the event" });
      return;
    }
    const event = infoResult.events[0];
    if (!event) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    eventWindow = occupiedWindow(event);
    if (!eventWindow) {
      res.status(409).json({ error: "This event has no date or time set yet, so equipment can't be reserved." });
      return;
    }
  }

  // AC2: pre-check every growing item's claimability before writing
  // anything, so a shortfall on one item never partially commits others.
  // `provisionallyClaimed` tracks units already picked by an earlier item
  // in this same loop — nothing is written yet, so without it two items
  // needing the same type could otherwise pick the same free unit twice.
  const claimsByItemId = new Map<number, number[]>();
  const shortfalls: Record<string, { equipmentType: string; availableCount: number; shortfall: number }> = {};
  const provisionallyClaimed = new Set<number>();
  for (const { item, delta } of deltas) {
    if (delta <= 0) continue;
    const result = await claimUnits(
      supabase,
      item.equipment_type,
      delta,
      existingRequest.event_id,
      eventWindow!,
      req.headers.authorization!,
      provisionallyClaimed,
    );
    if (result.claimedIds.length < delta) {
      shortfalls[item.id] = { equipmentType: item.equipment_type, availableCount: result.availableCount, shortfall: delta - result.claimedIds.length };
    } else {
      claimsByItemId.set(item.id, result.claimedIds);
      for (const id of result.claimedIds) provisionallyClaimed.add(id);
    }
  }
  if (Object.keys(shortfalls).length > 0) {
    res.status(409).json({ error: "Not enough equipment available for this change.", shortfalls });
    return;
  }

  // Atomic: recomputes every item's quantity_fulfilled for the target
  // status and applies only the delta to equipment_catalog.available_stock
  // (migration 0022) — a single DB round trip so a request's status and
  // the stock it holds can never drift apart.
  const { error: applyError } = await supabase.rpc("apply_equipment_request_status", {
    p_request_id: requestId,
    p_status: status,
    p_note: note,
    p_fulfillments: fulfillments,
  });

  if (applyError) {
    if ((applyError.message ?? "").includes("Not enough stock")) {
      res.status(409).json({ error: "Not enough stock available to make this change." });
      return;
    }
    res.status(500).json({ error: "Failed to update the equipment request" });
    return;
  }

  // The stock move committed — now spend it on the actual per-unit
  // claim/release it was for.
  try {
    for (const { item, delta } of deltas) {
      if (delta > 0) {
        await recordClaims(supabase, item.id, existingRequest.event_id, claimsByItemId.get(item.id) ?? []);
      } else if (delta < 0) {
        await releaseUnitsForItem(supabase, item.id, -delta);
      }
    }
  } catch {
    // Best-effort rollback of the stock move above, mirroring POST's own
    // orphan cleanup — this is a known gap (no single transaction spans
    // both the RPC and these per-unit writes), documented in this
    // handler's docstring.
    const previousFulfillments = items.map((item) => ({ itemId: item.id, fulfilledQuantity: item.quantity_fulfilled ?? 0 }));
    try {
      await supabase.rpc("apply_equipment_request_status", {
        p_request_id: requestId,
        p_status: existingRequest.status,
        p_note: existingRequest.fulfillment_note,
        p_fulfillments: existingRequest.status === "Partially Fulfilled" ? previousFulfillments : [],
      });
    } catch {
      // Nothing more to do — see the handler's docstring.
    }
    res.status(500).json({ error: "Failed to reserve the equipment for this change. Please try again." });
    return;
  }

  const { data: requestRow, error: requestError } = await supabase
    .from("equipment_requests")
    .select("id, event_id, coordinator_id, status, fulfillment_note, created_at")
    .eq("id", requestId)
    .maybeSingle();

  if (requestError || !requestRow) {
    res.status(500).json({ error: "Failed to load the updated equipment request" });
    return;
  }

  const { data: itemRows, error: itemsError } = await supabase
    .from("equipment_request_items")
    .select(ITEM_COLUMNS)
    .eq("request_id", requestId);

  if (itemsError) {
    res.status(500).json({ error: "Failed to load equipment items" });
    return;
  }

  // Best-effort, same stance as E5-1's submission notice: a friendlier
  // event name if events-service answers, "Event #n" if it doesn't.
  const infoResult = await fetchEventBookingInfo([requestRow.event_id], req.headers.authorization!);
  const eventInfo = infoResult.status === "ok" ? infoResult.events[0] : undefined;
  const eventName = eventInfo?.name || `Event #${requestRow.event_id}`;
  // E2-12: the event's current coordinator, who takes over its pending
  // requests on a reassignment; the coordinator recorded on the request is
  // only the fallback when events-service doesn't answer.
  const recipientId = eventInfo?.coordinatorId || (requestRow.coordinator_id as string);

  // #107 row 5, RabbitMQ.md #28 `equipment.status_changed`.
  const notified = await getPublisher().publish({
    type: "equipment.status_changed",
    eventId: requestRow.event_id as number,
    actorId: user.id,
    recipients: { userIds: [recipientId], roles: [] },
    data: { status, note, eventName },
  });

  // AC3: fresh immediately after a write too, not just on the next GET.
  const allItems = (itemRows ?? []) as ItemRow[];
  const itemEventIds = new Map(allItems.map((i) => [i.id, requestRow.event_id as number]));
  const knownWindows = eventWindow ? new Map([[requestRow.event_id as number, eventWindow]]) : new Map<number, OccupiedWindow>();
  const flagsByItemId = await computeReservationFlags(supabase, itemEventIds, knownWindows, req.headers.authorization!);

  res.json({ equipmentRequest: toRequest(requestRow as RequestRow, allItems, flagsByItemId), notified });
});

/**
 * E5-6 AC4: "Given an event is cancelled, when cancellation completes, then
 * its reservations are released and inventory returns to available."
 * E3-6 landed as a RabbitMQ flow (RabbitMQ.md section 3.4, #34): events-
 * service publishes `event.cancelled` and the consumer in
 * lib/eventCancelledHandler.ts releases reservations the same way this
 * route does, via the shared releaseEquipmentForEvent helper — so this
 * manual route is a direct-call fallback, not the primary path. Gated the
 * same way E3-6 itself is specified: the owning Organiser, and only once
 * the event is actually Cancelled.
 */
equipmentRequestsRouter.post("/events/:eventId/release", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  if (!isPositiveInteger(req.params.eventId)) {
    res.status(400).json({ error: "A valid eventId is required" });
    return;
  }
  const eventId = Number(req.params.eventId);

  const eventResult = await fetchEvent(eventId, req.headers.authorization!);
  if (eventResult.status === "not_found") {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  if (eventResult.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }

  if (user.role !== "organiser") {
    res.status(403).json({ error: "Only the organiser can release an event's equipment reservations" });
    return;
  }
  if (eventResult.event.status !== "Cancelled") {
    res.status(409).json({ error: "Equipment reservations can only be released once the event is cancelled." });
    return;
  }

  try {
    await releaseEquipmentForEvent(supabase, eventId);
  } catch {
    res.status(500).json({ error: "Failed to release the event's equipment reservations" });
    return;
  }

  res.json({ released: true });
});
