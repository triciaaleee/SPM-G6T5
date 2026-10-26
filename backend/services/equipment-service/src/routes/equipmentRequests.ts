import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchEvent, fetchEventBookingInfo, toSupportEventInfo, type EquipmentBookingInfo } from "../lib/eventsClient.js";
import { fetchUserNames } from "../lib/usersClient.js";
import { claimUnits } from "../lib/equipmentConflicts.js";
import { getPublisher } from "../lib/rabbitPublisher.js";
import { computeReservationFlags, type ReservationFlag } from "../lib/reservationFlags.js";
import { releaseEquipmentForEvent } from "../lib/eventCancellation.js";
import { occupiedWindow, type OccupiedWindow } from "../lib/scheduleWindow.js";
import {
  validateAmendedItems,
  validateEquipmentItems,
  validateStatusUpdate,
  type StatusUpdateItem,
  type ValidatedAmendedItem,
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
  equipment_catalog_id?: number | null;
}

const ITEM_COLUMNS = "id, request_id, equipment_type, quantity, quantity_fulfilled, equipment_catalog_id";

/** E5-2: a request the coordinator cancelled — kept as history, never Technical Support's to act on. */
const CANCELLED = "Cancelled";

const NO_FLAG: ReservationFlag = { flagged: false, reason: null };

/** A physical unit's display identity — just enough to show "which one" in the UI. */
export interface UnitLabel {
  id: number;
  label: string | null;
}

function toItem(row: ItemRow, flag: ReservationFlag = NO_FLAG, reservedUnits: UnitLabel[] = []) {
  return {
    id: row.id,
    // The catalog entry the item draws stock from; the coordinator's amend form pre-selects it.
    equipmentCatalogId: row.equipment_catalog_id ?? null,
    equipmentType: row.equipment_type,
    quantity: row.quantity,
    // E5-3: how much of this item has actually been taken off the shelf
    // under the request's current status (migration 0022).
    quantityFulfilled: row.quantity_fulfilled ?? 0,
    // E5-6 AC3: whether this item's claimed units no longer hold, given
    // every involved event's current schedule.
    reservationFlag: flag,
    // Which physical units are currently Reserved for this item, if any —
    // so Technical Support can see what "Arranged"/"Partially Fulfilled"
    // actually claimed, not just a quantity.
    reservedUnits,
  };
}

function toRequest(
  row: RequestRow,
  items: ItemRow[],
  flagsByItemId?: Map<number, ReservationFlag>,
  reservedUnitsByItemId?: Map<number, UnitLabel[]>,
) {
  return {
    id: row.id,
    eventId: row.event_id,
    status: row.status,
    // E5-3 AC2: what remains outstanding, set alongside "Partially Fulfilled".
    fulfillmentNote: row.fulfillment_note ?? null,
    createdAt: row.created_at,
    items: items
      .filter((item) => item.request_id === row.id)
      .map((item) => toItem(item, flagsByItemId?.get(item.id), reservedUnitsByItemId?.get(item.id))),
  };
}

/** Every item's currently-Reserved units, labelled, for display (not used by any claim/reserve logic). */
async function fetchReservedUnitsByItemId(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  itemIds: number[],
): Promise<Map<number, UnitLabel[]>> {
  const byItemId = new Map<number, UnitLabel[]>();
  if (itemIds.length === 0) return byItemId;

  const { data: bookings, error: bookingsError } = await supabase
    .from("equipment_booking")
    .select("equipment_id, request_item_id")
    .eq("status", "Reserved")
    .in("request_item_id", itemIds);
  if (bookingsError || !bookings || bookings.length === 0) return byItemId;

  const unitIds = [...new Set(bookings.map((b) => b.equipment_id as number))];
  const { data: units, error: unitsError } = await supabase.from("equipment").select("id, label").in("id", unitIds);
  if (unitsError) return byItemId;

  const labelById = new Map((units ?? []).map((u) => [u.id as number, (u.label as string | null) ?? null]));
  for (const booking of bookings as { equipment_id: number; request_item_id: number | null }[]) {
    if (booking.request_item_id == null) continue;
    const list = byItemId.get(booking.request_item_id) ?? [];
    list.push({ id: booking.equipment_id, label: labelById.get(booking.equipment_id) ?? null });
    byItemId.set(booking.request_item_id, list);
  }
  return byItemId;
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
  if (event.status !== "Planning" && event.status !== "Needs Review") {
    res.status(409).json({ error: "Equipment requirements can only be recorded while the event is in Planning or Needs Review." });
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

  // E5-2: a cancelled request is no longer Technical Support's to act on (the status
  // update refuses it), but it stays in the list so they can look back at it: the
  // queue's Cancelled / Past tab shows those, whether the coordinator cancelled the
  // request or the event was cancelled.
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
      // Whitelisted: only the event's name, date, time and venue reach the browser.
      event: eventsById.has(r.event_id) ? toSupportEventInfo(eventsById.get(r.event_id)!) : null,
    })),
  });
});

/**
 * E5-1 AC1/AC2: Technical Support open one event's equipment requests. They
 * see the requested equipment, quantities and the organiser's technical
 * requirements, plus the event's name, date, time and venue, and — a
 * deliberate, narrow exception to otherwise showing nothing about the
 * event's people — which coordinator raised each request (`requestedBy`,
 * resolved via user-service's /api/users/names; best-effort, so a lookup
 * failure still returns the id). An event with no equipment request is
 * refused the same way an unknown one is, so this route can't be used to
 * look at events that have nothing to do with Technical Support. Declared
 * before PATCH /:id only for readability; the paths don't overlap.
 */
equipmentRequestsRouter.get("/event/:eventId", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (user.role !== "technical_support") {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const rawEventId = Array.isArray(req.params.eventId) ? req.params.eventId[0] : req.params.eventId;
  if (!isPositiveInteger(rawEventId)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  const eventId = Number(rawEventId);

  const { data: requests, error: requestsError } = await supabase
    .from("equipment_requests")
    .select("id, event_id, coordinator_id, status, fulfillment_note, created_at")
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (requestsError || !requests) {
    res.status(500).json({ error: "Failed to load equipment requests" });
    return;
  }

  // AC2: nothing requested for this event, so there is nothing for Technical Support to open.
  if (requests.length === 0) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const requestIds = (requests as RequestRow[]).map((r) => r.id);
  const { data: itemRows, error: itemRowsError } = await supabase
    .from("equipment_request_items")
    .select(ITEM_COLUMNS)
    .in("request_id", requestIds);

  if (itemRowsError) {
    res.status(500).json({ error: "Failed to load equipment items" });
    return;
  }

  const infoResult = await fetchEventBookingInfo([eventId], req.headers.authorization!);
  if (infoResult.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }
  const info = infoResult.events.find((event) => event.id === eventId);
  if (!info) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // AC3: same re-check as the other GET handlers above.
  const eventWindow = windowOf(info);
  const allEventItems = (itemRows ?? []) as ItemRow[];
  const itemEventIds = new Map(allEventItems.map((item) => [item.id, eventId]));
  const knownWindows = eventWindow ? new Map([[eventId, eventWindow]]) : new Map<number, OccupiedWindow>();
  const flagsByItemId = await computeReservationFlags(supabase, itemEventIds, knownWindows, req.headers.authorization!);
  const reservedUnitsByItemId = await fetchReservedUnitsByItemId(
    supabase,
    allEventItems.map((item) => item.id),
  );

  const typedRequests = requests as RequestRow[];
  const coordinatorIds = [...new Set(typedRequests.map((r) => r.coordinator_id).filter((id): id is string => !!id))];
  const namesByCoordinatorId = await fetchUserNames(coordinatorIds, req.headers.authorization!);

  res.json({
    event: toSupportEventInfo(info),
    // The organiser's own words on what technical support the event needs (AC1).
    technicalRequirements: info.technicalSupport?.trim() ? info.technicalSupport.trim() : null,
    equipmentRequests: typedRequests.map((r) => ({
      ...toRequest(r, allEventItems, flagsByItemId, reservedUnitsByItemId),
      requestedBy: r.coordinator_id
        ? { id: r.coordinator_id, name: namesByCoordinatorId.get(r.coordinator_id) ?? null }
        : null,
    })),
  });
});

/**
 * Read-only preview of which physical units a claim would pick right now,
 * for `quantity` of one item — same selection rules as the real reservation
 * (`claimUnits`, shared with PATCH /:id above), but nothing is written. Lets
 * Technical Support see what a status/quantity pick would actually reserve,
 * and how many are free for the event's own date, before hitting Save.
 * Same "preview, nothing is saved" shape as E5-5's GET /equipment-units/impact.
 *
 * Only previews the units *beyond* what the item already holds (same delta
 * PATCH /:id computes) — otherwise an item's own already-Reserved units
 * would count as blocking a fresh claim for itself.
 */
equipmentRequestsRouter.get("/items/:itemId/unit-preview", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (user.role !== "technical_support") {
    res.status(403).json({ error: "Only Technical Support can preview equipment units" });
    return;
  }

  if (!isPositiveInteger(req.params.itemId)) {
    res.status(400).json({ error: "A valid item id is required" });
    return;
  }
  const itemId = Number(req.params.itemId);

  const rawQuantity = typeof req.query.quantity === "string" ? req.query.quantity : "";
  if (!isPositiveInteger(rawQuantity) && rawQuantity !== "0") {
    res.status(400).json({ error: "A valid quantity is required" });
    return;
  }
  const quantity = Number(rawQuantity);

  const { data: itemRow, error: itemError } = await supabase
    .from("equipment_request_items")
    .select("id, request_id, equipment_type, equipment_catalog_id, quantity_fulfilled")
    .eq("id", itemId)
    .maybeSingle();
  if (itemError) {
    res.status(500).json({ error: "Failed to load the equipment item" });
    return;
  }
  if (!itemRow) {
    res.status(404).json({ error: "Equipment item not found" });
    return;
  }
  if (itemRow.equipment_catalog_id == null) {
    res.status(409).json({ error: `${itemRow.equipment_type} isn't linked to an equipment catalog item, so it can't be previewed.` });
    return;
  }

  const { data: requestRow, error: requestError } = await supabase
    .from("equipment_requests")
    .select("id, event_id")
    .eq("id", itemRow.request_id)
    .maybeSingle();
  if (requestError || !requestRow) {
    res.status(404).json({ error: "Equipment request not found" });
    return;
  }

  // Only the units beyond what this item already holds need to be claimed —
  // otherwise its own existing Reserved bookings would count as "blocking"
  // against itself (claimUnits treats every Reserved booking on this event
  // as taken, see lib/equipmentConflicts.ts's treatOwnEventClaimsAsBlocking).
  const delta = Math.max(0, quantity - ((itemRow.quantity_fulfilled as number | null) ?? 0));
  if (delta === 0) {
    res.json({ claimedIds: [], units: [], availableCount: 0, shortfall: 0 });
    return;
  }

  const infoResult = await fetchEventBookingInfo([requestRow.event_id as number], req.headers.authorization!);
  if (infoResult.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }
  const event = infoResult.events[0];
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  const targetWindow = occupiedWindow(event);
  if (!targetWindow) {
    res.status(409).json({ error: "This event has no date or time set yet, so availability can't be checked." });
    return;
  }

  let claim;
  try {
    claim = await claimUnits(
      supabase,
      itemRow.equipment_catalog_id as number,
      delta,
      requestRow.event_id as number,
      targetWindow,
      req.headers.authorization!,
    );
  } catch {
    res.status(500).json({ error: "Failed to check equipment availability" });
    return;
  }

  let units: UnitLabel[] = [];
  if (claim.claimedIds.length > 0) {
    const { data: unitRows, error: unitsError } = await supabase.from("equipment").select("id, label").in("id", claim.claimedIds);
    if (unitsError) {
      res.status(500).json({ error: "Failed to load equipment units" });
      return;
    }
    units = (unitRows ?? []).map((u) => ({ id: u.id as number, label: (u.label as string | null) ?? null }));
  }

  res.json({ claimedIds: claim.claimedIds, units, availableCount: claim.availableCount, shortfall: claim.shortfall });
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
 * Which units are free has to be decided here in the application layer —
 * unlike the flat catalog math, it needs every *other* booking's owning
 * event's current schedule, which only events-service knows, over HTTP. So
 * this route: (1) works out the free units for AC2 before touching anything,
 * then (2) hands the chosen units to reserve_equipment_request (migration
 * 0049), which moves the stock, sets the status and writes or releases the
 * bookings in one transaction. It re-checks only what the database knows
 * (the unit's type, that it is still Available, that it isn't reserved for this
 * event already) and, from migration 0050, the event's window the application
 * passes in: a unit with an overlapping booking or unavailability period is
 * refused after the unit is locked, so two reservations for overlapping dates
 * picking the same unit at the same instant can't both succeed. Bookings made
 * before 0050 have no stored window; they are checked here against
 * events-service, which also fills their windows in.
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
  if (existingRequest.status === CANCELLED) {
    res.status(409).json({ error: "This request was cancelled, so its status can't be updated." });
    return;
  }

  // Needed up front: Partially Fulfilled validates a fulfilled quantity
  // per item (0..its requested quantity), and a request with no items
  // never exists (POST always inserts at least one alongside it).
  const { data: existingItems, error: existingItemsError } = await supabase
    .from("equipment_request_items")
    .select("id, quantity, quantity_fulfilled, equipment_type, equipment_catalog_id")
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
  // Units belong to a catalog item by id (migration 0048), so an item with no
  // link can't be reserved. Migration 0048 links every item it can; only an
  // item whose name matched nothing in the catalog is still unlinked.
  const unlinked = deltas.find(({ item, delta }) => delta > 0 && item.equipment_catalog_id == null);
  if (unlinked) {
    res.status(409).json({ error: `${unlinked.item.equipment_type} isn't linked to an equipment catalog item, so it can't be reserved.` });
    return;
  }

  const claimsByItemId = new Map<number, number[]>();
  const shortfalls: Record<string, { equipmentType: string; availableCount: number; shortfall: number }> = {};
  const provisionallyClaimed = new Set<number>();
  for (const { item, delta } of deltas) {
    if (delta <= 0) continue;
    const result = await claimUnits(
      supabase,
      item.equipment_catalog_id as number,
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

  // One database function (migration 0049) moves the stock counters, sets the
  // status and writes or removes the equipment_booking rows together, so a
  // failure anywhere leaves nothing changed.
  const claims = [...claimsByItemId].map(([itemId, unitIds]) => ({ itemId, unitIds }));
  const { error: reserveError } = await supabase.rpc("reserve_equipment_request", {
    p_request_id: requestId,
    p_status: status,
    p_note: note,
    p_fulfillments: fulfillments,
    p_claims: claims,
    // Stored on each new booking and checked against overlapping ones (migration 0050).
    // Null when nothing is being reserved, which the function does not need.
    p_window_start_ms: eventWindow?.startMs ?? null,
    p_window_end_ms: eventWindow?.endMs ?? null,
  });

  if (reserveError) {
    const message = reserveError.message ?? "";
    if (message.includes("Not enough stock")) {
      res.status(409).json({ error: "Not enough stock available to make this change." });
      return;
    }
    // A unit was marked unusable, or taken for this event, after it was picked.
    if (
      message.includes("no longer available") ||
      message.includes("already reserved") ||
      message.includes("not the requested") ||
      message.includes("overlapping dates") ||
      message.includes("unavailable during")
    ) {
      res.status(409).json({ error: "Some of that equipment was just taken or changed. Check availability and try again." });
      return;
    }
    res.status(500).json({ error: "Failed to update the equipment request" });
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
  // So the caller sees what was just reserved/released without a second GET.
  const reservedUnitsByItemId = await fetchReservedUnitsByItemId(
    supabase,
    allItems.map((item) => item.id),
  );

  res.json({
    equipmentRequest: toRequest(requestRow as RequestRow, allItems, flagsByItemId, reservedUnitsByItemId),
    notified,
  });
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

/**
 * E3-11 AC3: the coordinator approved a held change request whose
 * `equipment` field was touched — the organiser's stated requirements
 * changed, so every equipment request already recorded for the event is
 * flagged for Technical Support to reassess. Nothing about the actual
 * reservation (quantity_fulfilled, item rows) is touched automatically
 * (no automatic process, per the clarification behind this story); the
 * flag is purely informational until a human acts on it.
 */
equipmentRequestsRouter.post("/flag-for-event/:eventId", async (req: AuthedRequest, res) => {
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

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "A reason is required" });
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
  if (eventResult.event.coordinator_id !== user.id) {
    res.status(403).json({ error: "Only the event's assigned coordinator can flag its equipment requests" });
    return;
  }

  const flaggedAt = new Date().toISOString();
  const { data: flagged, error: flagError } = await supabase
    .from("equipment_requests")
    .update({ flagged_for_reassessment: true, flag_reason: reason, flagged_at: flaggedAt })
    .eq("event_id", eventId)
    .select("id");
  if (flagError) {
    res.status(500).json({ error: "Failed to flag the event's equipment requests" });
    return;
  }

  const eventName = (eventResult.event.submitted_details?.name as string | undefined) || `Event #${eventId}`;
  let notified = false;
  if ((flagged ?? []).length > 0) {
    notified = await getPublisher().publish({
      type: "equipment.flagged_for_reassessment",
      eventId,
      actorId: user.id,
      recipients: { userIds: [], roles: ["technical_support"] },
      data: { eventName, reason },
    });
  }

  res.json({ flaggedRequestIds: (flagged ?? []).map((r) => r.id), notified });
});

/** What the amend and cancel routes need to know about the request and its event before changing anything. */
type EditableRequest =
  | { ok: true; request: { id: number; event_id: number; status: string }; eventName: string }
  | { ok: false };

/**
 * E5-2: loads the request and checks the caller may change it — the event's
 * assigned coordinator (same rule as raising one, E5-1), only while the event
 * is in Planning (after that, equipment changes go through a change request,
 * E3-11). Writes the error response itself and returns `{ ok: false }`.
 */
async function loadEditableRequest(req: AuthedRequest, res: import("express").Response): Promise<EditableRequest> {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return { ok: false };
  }
  if (user.role !== "coordinator") {
    res.status(403).json({ error: "Only the assigned coordinator can change an equipment request" });
    return { ok: false };
  }
  if (!isPositiveInteger(req.params.id)) {
    res.status(400).json({ error: "A valid request id is required" });
    return { ok: false };
  }

  const { data: request, error } = await supabase
    .from("equipment_requests")
    .select("id, event_id, status")
    .eq("id", Number(req.params.id))
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "Failed to load the equipment request" });
    return { ok: false };
  }
  if (!request) {
    res.status(404).json({ error: "Equipment request not found" });
    return { ok: false };
  }

  const eventResult = await fetchEvent(request.event_id as number, req.headers.authorization!);
  if (eventResult.status === "not_found") {
    res.status(404).json({ error: "Event not found" });
    return { ok: false };
  }
  if (eventResult.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return { ok: false };
  }
  const { event } = eventResult;

  if (event.coordinator_id !== user.id) {
    res.status(403).json({ error: "Only the assigned coordinator can change an equipment request" });
    return { ok: false };
  }
  if (event.status !== "Planning" && event.status !== "Needs Review") {
    res.status(409).json({ error: "Equipment requests can only be changed while the event is in Planning or Needs Review." });
    return { ok: false };
  }
  if (request.status === CANCELLED) {
    res.status(409).json({ error: "This equipment request has been cancelled." });
    return { ok: false };
  }

  const eventName = (event.submitted_details?.name as string | undefined) || `Event #${request.event_id}`;
  return { ok: true, request: request as { id: number; event_id: number; status: string }, eventName };
}

/** The request and its items as the coordinator's panel shows them. */
async function loadRequestView(supabase: NonNullable<AuthedRequest["supabase"]>, requestId: number) {
  const { data: requestRow, error: requestError } = await supabase
    .from("equipment_requests")
    .select("id, event_id, coordinator_id, status, fulfillment_note, created_at")
    .eq("id", requestId)
    .maybeSingle();
  if (requestError || !requestRow) return null;

  const { data: itemRows, error: itemsError } = await supabase
    .from("equipment_request_items")
    .select(ITEM_COLUMNS)
    .eq("request_id", requestId);
  if (itemsError) return null;

  return toRequest(requestRow as RequestRow, (itemRows ?? []) as ItemRow[]);
}

/** One change the amend function reports (migration 0042). */
interface AmendmentChange {
  kind: "quantity" | "type" | "added" | "removed";
  equipmentType: string;
  fromType?: string;
  from?: number;
  to?: number;
  quantity?: number;
  released: number;
}

/**
 * E5-2 AC1/AC2: the assigned coordinator amends a request's types or
 * quantities while it isn't fully arranged yet (Requested or Partially
 * Fulfilled) and the event is in Planning. Lowering a quantity below what is
 * already reserved releases the surplus back to inventory (AC2), and Technical
 * Support are notified of exactly what changed (AC1, `equipment.amended`).
 * Raising a quantity or adding an item reserves nothing — Technical Support
 * arrange it. All the item, stock and reservation changes happen in one
 * database function (amend_equipment_request, migration 0042).
 */
equipmentRequestsRouter.put("/:id/items", async (req: AuthedRequest, res) => {
  const editable = await loadEditableRequest(req, res);
  if (!editable.ok) return;
  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">> & AuthedRequest;
  const { request, eventName } = editable;

  if (request.status === "Arranged") {
    res.status(409).json({
      error: "A fully arranged request can't be amended. Cancel it and raise a new one.",
    });
    return;
  }

  const body = (req.body ?? {}) as { items?: unknown };
  const itemsResult = validateAmendedItems(body.items);
  if (!itemsResult.valid) {
    res.status(400).json({ error: "Validation failed", fields: itemsResult.fields });
    return;
  }
  const items = itemsResult.value as ValidatedAmendedItem[];

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

  const { data: outcome, error: amendError } = await supabase.rpc("amend_equipment_request", {
    p_request_id: request.id,
    p_items: items.map((item) => ({
      itemId: item.itemId ?? null,
      equipmentCatalogId: item.equipmentCatalogId,
      equipmentType: catalogNameById.get(item.equipmentCatalogId)!,
      quantity: item.quantity,
    })),
  });
  if (amendError) {
    const message = amendError.message ?? "";
    if (message.includes("cannot be amended")) {
      res.status(409).json({ error: "This request can no longer be amended." });
    } else if (message.includes("Unknown item")) {
      res.status(400).json({ error: "Validation failed", fields: { items: "One of these items isn't on this request." } });
    } else {
      res.status(500).json({ error: "Failed to amend the equipment request" });
    }
    return;
  }

  const changes = ((outcome as { changes?: AmendmentChange[] } | null)?.changes ?? []) as AmendmentChange[];
  const released = changes.reduce((sum, change) => sum + (change.released ?? 0), 0);

  // Nothing actually changed: nothing to tell Technical Support.
  let notified = false;
  if (changes.length > 0) {
    notified = await getPublisher().publish({
      type: "equipment.amended",
      eventId: request.event_id,
      actorId: user.id,
      recipients: { userIds: [], roles: ["technical_support"] },
      data: { eventName, changes, released },
    });
  }

  const equipmentRequest = await loadRequestView(supabase, request.id);
  if (!equipmentRequest) {
    res.status(500).json({ error: "Failed to load the updated equipment request" });
    return;
  }
  res.json({ equipmentRequest, changes, released, notified });
});

/**
 * E5-2 AC3: the assigned coordinator cancels a request entirely (while the
 * event is in Planning). Everything reserved against it is released back to
 * inventory in one database function (release_equipment_for_request,
 * migration 0042), the request is kept as history with status "Cancelled",
 * and Technical Support are notified (`equipment.released`,
 * reason `coordinator_cancelled`). Any status can be cancelled, including a
 * fully arranged one.
 */
equipmentRequestsRouter.post("/:id/cancel", async (req: AuthedRequest, res) => {
  const editable = await loadEditableRequest(req, res);
  if (!editable.ok) return;
  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">> & AuthedRequest;
  const { request, eventName } = editable;

  const { data: outcome, error: cancelError } = await supabase.rpc("release_equipment_for_request", {
    p_request_id: request.id,
  });
  if (cancelError) {
    if ((cancelError.message ?? "").includes("already cancelled")) {
      res.status(409).json({ error: "This equipment request has been cancelled." });
    } else {
      res.status(500).json({ error: "Failed to cancel the equipment request" });
    }
    return;
  }

  const released = ((outcome as { released?: { equipmentType: string; quantity: number }[] } | null)?.released ??
    []) as { equipmentType: string; quantity: number }[];

  const notified = await getPublisher().publish({
    type: "equipment.released",
    eventId: request.event_id,
    actorId: user.id,
    recipients: { userIds: [], roles: ["technical_support"] },
    data: { eventName, reason: "coordinator_cancelled", released },
  });

  const equipmentRequest = await loadRequestView(supabase, request.id);
  if (!equipmentRequest) {
    res.status(500).json({ error: "Failed to load the updated equipment request" });
    return;
  }
  res.json({ equipmentRequest, released, notified });
});
