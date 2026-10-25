import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

/** E5-6 AC3: whether this item's claimed units no longer hold, re-checked on every view. */
export interface ReservationFlag {
  flagged: boolean;
  reason: string | null;
}

/** A physical unit's display identity — just enough to show "which one" in the UI. */
export interface UnitLabel {
  id: number;
  label: string | null;
}

/** E5-1: one line item on an equipment request — type and quantity. */
export interface EquipmentItem {
  id: number;
  /** The catalog entry the item draws stock from; null for a request recorded before the catalog existed. */
  equipmentCatalogId?: number | null;
  equipmentType: string;
  quantity: number;
  /** E5-3: how much of this item is currently taken off the shelf for this request. */
  quantityFulfilled: number;
  /** E5-6 AC1/AC3: set once this item has been Arranged/Partially Fulfilled. */
  reservationFlag: ReservationFlag;
  /** Which physical units are currently Reserved for this item, if any; absent from responses that don't carry it. */
  reservedUnits?: UnitLabel[];
}

/** E5-2: the coordinator cancelled the whole request — kept as history, nothing is reserved against it. */
export const CANCELLED_REQUEST_STATUS = "Cancelled";

/** E5-3: the real values status can take on, fixed by that story. */
export const EQUIPMENT_REQUEST_STATUSES = ["Requested", "Arranged", "Partially Fulfilled"] as const;
export type EquipmentRequestStatus = (typeof EQUIPMENT_REQUEST_STATUSES)[number];

/** What one item amounts to, from its numbers alone: none, some or all of it arranged. */
export function itemFulfilmentState(fulfilled: number, quantity: number): "Not arranged" | "Partially fulfilled" | "Arranged" {
  if (fulfilled <= 0) return "Not arranged";
  return fulfilled >= quantity ? "Arranged" : "Partially fulfilled";
}

/** Same colour convention as the request badge: Arranged reads as resolved, partial as a warning. */
export function itemFulfilmentBadgeClass(fulfilled: number, quantity: number, notArrangedClass = "status-open"): string {
  const state = itemFulfilmentState(fulfilled, quantity);
  if (state === "Arranged") return "status-success";
  if (state === "Partially fulfilled") return "status-warning";
  return notArrangedClass;
}

export interface EquipmentRequest {
  id: number;
  eventId: number;
  status: string;
  /** E5-3 AC2: what remains outstanding, set alongside "Partially Fulfilled". */
  fulfillmentNote: string | null;
  createdAt: string;
  items: EquipmentItem[];
}

/**
 * What Technical Support may see about an event (E5-1 AC1): which event it is
 * and when and where it happens. Nothing about its people or purpose.
 */
export interface SupportEventInfo {
  id: number;
  name: string | null;
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  venue: string | null;
}

/** Only present on Technical Support's list (GET with no eventId). */
export interface EquipmentRequestWithEvent extends EquipmentRequest {
  event: SupportEventInfo | null;
}

/** E5-1 AC1: one event's equipment requests with its timing and the organiser's technical requirements. */
export interface EventEquipmentView {
  event: SupportEventInfo;
  /** The organiser's own words on what technical support the event needs; null when none were given. */
  technicalRequirements: string | null;
  equipmentRequests: EquipmentRequest[];
}

/** The fixed catalog Coordinators pick from and Technical Support's stock table reads (migration 0022). */
export interface EquipmentCatalogItem {
  id: number;
  name: string;
  totalStock: number;
  /** Stock not held by requests, minus the units out of use today (they return when their period ends). */
  availableStock: number;
  /** How many units are out of use on the day shown and so already taken off `availableStock`; absent from older responses. */
  unusableNow?: number;
  /** How many usable units events hold on the day shown, so total = available + booked + out of use; absent from older responses. */
  bookedCount?: number;
}

export interface EquipmentItemInput {
  equipmentCatalogId: number | string;
  quantity: number | string;
}

/** E5-3: what Technical Support records per item when marking a request "Partially Fulfilled". */
export interface FulfillmentInput {
  itemId: number;
  fulfilledQuantity: number | string;
}

/** E5-4: whether enough suitable equipment is free for an item's event, before committing to it. */
export interface EquipmentAvailability {
  event: { id: number; name: string | null };
  type: string;
  requestedQuantity: number;
  totalUnits: number;
  /** AC2: damaged/under-maintenance units. */
  unusableCount: number;
  /** AC1: usable units already booked to another, overlapping event. */
  reservedElsewhereCount: number;
  availableCount: number;
  /** AC3: how many short of the requested quantity, if any. */
  shortfall: number;
}

const apiBase =
  (import.meta.env.VITE_EQUIPMENT_API_URL as string | undefined) ?? "http://localhost:4005/api/equipment-requests";
const catalogApiBase =
  (import.meta.env.VITE_EQUIPMENT_CATALOG_API_URL as string | undefined) ?? "http://localhost:4005/api/equipment-catalog";
const unitsApiBase =
  (import.meta.env.VITE_EQUIPMENT_UNITS_API_URL as string | undefined) ?? "http://localhost:4005/api/equipment-units";
const availabilityApiBase =
  (import.meta.env.VITE_EQUIPMENT_AVAILABILITY_API_URL as string | undefined) ??
  "http://localhost:4005/api/equipment-availability";

export class EquipmentValidationError extends Error {
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super("Validation failed");
    this.fields = fields;
  }
}

export class EquipmentRequestError extends Error {}

/** E5-1 AC2: the event has no equipment request (or isn't Technical Support's to open). */
export class EquipmentAccessDeniedError extends Error {}

/** E5-6 AC2: the PATCH was rejected because not enough equipment is free for the event's window. */
export interface ReservationShortfall {
  equipmentType: string;
  availableCount: number;
  shortfall: number;
}

export class EquipmentReservationShortfallError extends Error {
  shortfalls: Record<string, ReservationShortfall>;
  constructor(message: string, shortfalls: Record<string, ReservationShortfall>) {
    super(message);
    this.shortfalls = shortfalls;
  }
}

/**
 * The equipment catalog, for the request form's dropdown and Technical Support's stock table.
 * `date` (YYYY-MM-DD) shows the stock for that day instead of today.
 */
export async function fetchEquipmentCatalog(date?: string): Promise<EquipmentCatalogItem[]> {
  const res = await fetch(date ? `${catalogApiBase}?date=${encodeURIComponent(date)}` : catalogApiBase, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load the equipment catalog");
  const body = await res.json();
  return body.equipmentCatalog as EquipmentCatalogItem[];
}

/** AC1/AC3: the assigned coordinator submits a structured equipment request for an event in Planning. */
export async function submitEquipmentRequest(
  eventId: number,
  items: EquipmentItemInput[],
): Promise<{ equipmentRequest: EquipmentRequest; notified: boolean }> {
  const res = await fetch(apiBase, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ eventId, items }),
  });

  await redirectIfUnauthenticated(res);
  const body = await res.json();

  if (res.status === 400) {
    throw new EquipmentValidationError((body.fields as Record<string, string> | undefined) ?? {});
  }
  if (!res.ok) {
    throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to record the equipment request");
  }
  return body as { equipmentRequest: EquipmentRequest; notified: boolean };
}

/** One row of an amended request: an existing item (`itemId`) or a new one (no `itemId`). */
export interface AmendedItemInput extends EquipmentItemInput {
  itemId?: number;
}

/** What one amendment changed, as the backend reports it (migration 0042). */
export interface AmendmentChange {
  kind: "quantity" | "type" | "added" | "removed";
  equipmentType: string;
  fromType?: string;
  from?: number;
  to?: number;
  quantity?: number;
  /** How many reserved units this change released back to inventory. */
  released: number;
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * E5-2 AC1/AC2: the assigned coordinator amends a request's types and
 * quantities. Lowering a quantity below what is reserved releases the
 * surplus back to inventory (`released` says how many); Technical Support are
 * notified of what changed unless nothing did (`changes` is empty).
 */
export async function amendEquipmentRequest(
  requestId: number,
  items: AmendedItemInput[],
): Promise<{ equipmentRequest: EquipmentRequest; changes: AmendmentChange[]; released: number; notified: boolean }> {
  const res = await fetch(`${apiBase}/${requestId}/items`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ items }),
  });

  await redirectIfUnauthenticated(res);
  const body = await readBody(res);

  if (res.status === 400) {
    throw new EquipmentValidationError((body.fields as Record<string, string> | undefined) ?? {});
  }
  if (!res.ok) {
    throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to amend the equipment request");
  }
  return body as { equipmentRequest: EquipmentRequest; changes: AmendmentChange[]; released: number; notified: boolean };
}

/**
 * E5-2 AC3: the assigned coordinator cancels a request entirely. Everything
 * reserved against it is released (`released` lists what went back) and
 * Technical Support are notified.
 */
export async function cancelEquipmentRequest(
  requestId: number,
): Promise<{ equipmentRequest: EquipmentRequest; released: { equipmentType: string; quantity: number }[]; notified: boolean }> {
  const res = await fetch(`${apiBase}/${requestId}/cancel`, { method: "POST", headers: authHeader() });

  await redirectIfUnauthenticated(res);
  const body = await readBody(res);

  if (!res.ok) {
    throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to cancel the equipment request");
  }
  return body as {
    equipmentRequest: EquipmentRequest;
    released: { equipmentType: string; quantity: number }[];
    notified: boolean;
  };
}

/** E5-5: why a unit is out of use. */
export const UNIT_UNAVAILABILITY_REASONS = ["Damaged", "Under Maintenance"] as const;
export type UnitUnavailabilityReason = (typeof UNIT_UNAVAILABILITY_REASONS)[number];

/** E5-5: one period a unit is unusable. `endDate` null means until it is marked usable again. */
export interface UnitUnavailabilityPeriod {
  id: number;
  reason: UnitUnavailabilityReason;
  /** YYYY-MM-DD, inclusive. */
  startDate: string;
  endDate: string | null;
  note: string | null;
}

/** E5-5: one physical unit. `status` is its own condition (Available, or Damaged/Under Maintenance with no dates). */
export interface EquipmentUnit {
  id: number;
  type: string;
  status: string;
  /** Optional tag for the physical unit, e.g. the sticker number on it. */
  label: string | null;
  /** Periods running now or still to come. */
  periods: UnitUnavailabilityPeriod[];
}

/** What marking a type's units unusable for a period would do to one unit. */
export type UnitImpactState = "free" | "reserved" | "unavailable";

export interface UnitImpactEvent {
  eventId: number;
  eventName: string;
  proposedDate: string | null;
  startTime: string | null;
}

export interface UnitImpact {
  id: number;
  label: string | null;
  /** free: nothing reserved then. reserved: held for the events listed. unavailable: already out of use (`reason`). */
  state: UnitImpactState;
  reason: string | null;
  events: UnitImpactEvent[];
}

export interface UnitImpactPreview {
  type: string;
  units: UnitImpact[];
  /** How many units could be marked (not already out of use). */
  pickable: number;
  /** The units the system would take for `quantity`: free ones first, then those reserved for the events furthest away. */
  suggested: number[];
}

export interface MarkUnitsInput {
  type: string;
  unitIds: number[];
  reason: UnitUnavailabilityReason;
  startDate: string;
  endDate?: string;
  note?: string;
}

export interface MarkUnitsResult {
  periods: { unitId: number; label: string | null; period: UnitUnavailabilityPeriod }[];
  /** Events holding one of the marked units in the period, whose coordinators are notified. */
  affectedEvents: { eventId: number; eventName: string; units: number }[];
  notified: boolean;
}

/** Technical Support: every unit with its running and upcoming unusable periods (E5-5). */
export async function fetchEquipmentUnits(): Promise<EquipmentUnit[]> {
  const res = await fetch(unitsApiBase, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load equipment units");
  return ((await res.json()) as { units: EquipmentUnit[] }).units;
}

/**
 * E5-5: the preview before marking units unusable — every unit of `type` with
 * its state for the period (free, reserved for which events, or already out of
 * use), and the units suggested for `quantity`. Nothing is saved.
 */
export async function fetchUnitImpact(
  type: string,
  period: { startDate: string; endDate?: string; quantity?: number },
): Promise<UnitImpactPreview> {
  const query = new URLSearchParams({ type, startDate: period.startDate });
  if (period.endDate) query.set("endDate", period.endDate);
  if (period.quantity !== undefined) query.set("quantity", String(period.quantity));

  const res = await fetch(`${unitsApiBase}/impact?${query}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await readBody(res);

  if (res.status === 400) throw new EquipmentValidationError((body.fields as Record<string, string> | undefined) ?? {});
  if (!res.ok) throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to check the impact");
  return body as unknown as UnitImpactPreview;
}

/**
 * E5-5 AC1/AC2: mark the chosen units unusable for a period. `affectedEvents`
 * lists the events holding one of them in that period, whose coordinators are
 * notified (`notified` is false when any notice couldn't be sent).
 */
export async function markUnitsUnusable(input: MarkUnitsInput): Promise<MarkUnitsResult> {
  const res = await fetch(`${unitsApiBase}/mark`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(input),
  });

  await redirectIfUnauthenticated(res);
  const body = await readBody(res);

  if (res.status === 400) throw new EquipmentValidationError((body.fields as Record<string, string> | undefined) ?? {});
  if (!res.ok) throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to mark the equipment unusable");
  return body as unknown as MarkUnitsResult;
}

/** Mark units usable again by removing the given unusable periods (typically a group marked together). */
export async function clearUnavailability(periodIds: number[]): Promise<number> {
  const res = await fetch(`${unitsApiBase}/unavailability/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ periodIds }),
  });

  await redirectIfUnauthenticated(res);
  const body = await readBody(res);
  if (!res.ok) throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to mark the equipment usable again");
  return (body as { removed: number }).removed;
}

/** Set or clear a unit's label (blank clears it). */
export async function setUnitLabel(unitId: number, label: string): Promise<{ id: number; label: string | null }> {
  const res = await fetch(`${unitsApiBase}/${unitId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ label }),
  });

  await redirectIfUnauthenticated(res);
  const body = await readBody(res);

  if (res.status === 400) throw new EquipmentValidationError((body.fields as Record<string, string> | undefined) ?? {});
  if (!res.ok) throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to save the label");
  return (body as { unit: { id: number; label: string | null } }).unit;
}

/** Mark a unit usable again by removing one of its unusable periods. */
export async function markUnitUsable(unitId: number, periodId: number): Promise<void> {
  const res = await fetch(`${unitsApiBase}/${unitId}/unavailability/${periodId}`, {
    method: "DELETE",
    headers: authHeader(),
  });

  await redirectIfUnauthenticated(res);
  if (!res.ok) {
    const body = await readBody(res);
    throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to mark the equipment usable again");
  }
}

/** The equipment requests already recorded for one event (coordinator view). */
export async function fetchEquipmentRequestsForEvent(eventId: number): Promise<EquipmentRequest[]> {
  const res = await fetch(`${apiBase}?eventId=${eventId}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load equipment requests");
  const body = await res.json();
  return body.equipmentRequests as EquipmentRequest[];
}

/** AC1: every outstanding equipment request, for Technical Support Staff. */
export async function fetchAllEquipmentRequests(): Promise<EquipmentRequestWithEvent[]> {
  const res = await fetch(apiBase, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load equipment requests");
  const body = await res.json();
  return body.equipmentRequests as EquipmentRequestWithEvent[];
}

/**
 * E5-3 AC1/AC2: Technical Support update a request's status as arrangements
 * are made, with a note on what remains outstanding when only partly
 * fulfilled, and (for a partial fulfilment) how much of each item was
 * actually handed out — that's what moves stock in equipment_catalog
 * (migration 0022). The assigned coordinator is notified by the backend.
 */
export async function updateEquipmentRequestStatus(
  requestId: number,
  status: EquipmentRequestStatus,
  note?: string,
  fulfillments?: FulfillmentInput[],
): Promise<{ equipmentRequest: EquipmentRequest; notified: boolean }> {
  const res = await fetch(`${apiBase}/${requestId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ status, note, fulfillments }),
  });

  await redirectIfUnauthenticated(res);
  const body = await res.json();

  if (res.status === 400) {
    throw new EquipmentValidationError((body.fields as Record<string, string> | undefined) ?? {});
  }
  if (res.status === 409 && body.shortfalls) {
    throw new EquipmentReservationShortfallError((body.error as string | undefined) ?? "Not enough equipment available for this change.", body.shortfalls);
  }
  if (!res.ok) {
    throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to update the equipment request");
  }
  return body as { equipmentRequest: EquipmentRequest; notified: boolean };
}

/**
 * E5-4: Technical Support check whether enough suitable equipment is free
 * for an item's event before deciding how to arrange it (AC1-3).
 */
export async function checkEquipmentAvailability(
  eventId: number,
  type: string,
  quantity: number,
): Promise<EquipmentAvailability> {
  const query = new URLSearchParams({ eventId: String(eventId), type, quantity: String(quantity) });
  const res = await fetch(`${availabilityApiBase}?${query}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) {
    throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to check equipment availability");
  }
  return body as EquipmentAvailability;
}

/** A read-only preview of which units a claim would pick right now — nothing is saved. */
export interface UnitPreview {
  claimedIds: number[];
  units: UnitLabel[];
  availableCount: number;
  shortfall: number;
}

/**
 * Preview which physical units arranging `quantity` of this item would
 * claim, for the item's own event date — the same selection the backend
 * actually makes on Save, computed without writing anything.
 */
export async function previewUnitsForItem(itemId: number, quantity: number): Promise<UnitPreview> {
  const res = await fetch(`${apiBase}/items/${itemId}/unit-preview?quantity=${quantity}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await readBody(res);
  if (!res.ok) {
    throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to preview equipment units");
  }
  return body as unknown as UnitPreview;
}

/**
 * E5-1 AC1/AC2: open one event's equipment requests. Throws
 * `EquipmentAccessDeniedError` when the backend refuses it, which includes an
 * event that has no equipment request.
 */
export async function fetchEquipmentRequestsForSupport(eventId: number | string): Promise<EventEquipmentView> {
  const res = await fetch(`${apiBase}/event/${encodeURIComponent(String(eventId))}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (res.status === 403) throw new EquipmentAccessDeniedError("You don't have access to this event");
  if (!res.ok) throw new Error("Failed to load the equipment request");
  return (await res.json()) as EventEquipmentView;
}

async function writeCatalog(url: string, method: "POST" | "PATCH", payload: object, failure: string): Promise<EquipmentCatalogItem> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(payload),
  });
  await redirectIfUnauthenticated(res);

  let body: { equipment?: EquipmentCatalogItem; error?: string; fields?: Record<string, string> } = {};
  try {
    body = await res.json();
  } catch {
    // No JSON body: fall back to the generic message below.
  }

  // 400 (bad numbers) and 409 (duplicate name) both carry per-field messages.
  if ((res.status === 400 || res.status === 409) && body.fields) throw new EquipmentValidationError(body.fields);
  if (!res.ok || !body.equipment) throw new EquipmentRequestError(body.error ?? failure);
  return body.equipment;
}

/** E5-1 AC3: add an item to the inventory. New stock starts fully available. */
export function createCatalogItem(name: string, totalStock: number): Promise<EquipmentCatalogItem> {
  return writeCatalog(catalogApiBase, "POST", { name, totalStock }, "Failed to add the equipment item");
}

/** One recorded change to an item's total stock. */
export interface StockChange {
  id: number;
  changeType: "Added" | "Removed";
  quantity: number;
  totalBefore: number;
  totalAfter: number;
  reason: string;
  /** The user id of whoever made the change. */
  changedBy: string | null;
  createdAt: string;
}

export interface StockChangeInput {
  direction: "add" | "remove";
  quantity: number | string;
  reason: string;
}

/**
 * Add or remove stock of an item, with a reason. The unit rows are created or
 * removed to match, and only free units (not reserved, not out of use) can be
 * removed — the error says how many can go when too many were asked for.
 * Available stock is derived and is never set directly.
 */
export async function changeStock(id: number, change: StockChangeInput): Promise<EquipmentCatalogItem> {
  const res = await fetch(`${catalogApiBase}/${id}/stock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(change),
  });

  await redirectIfUnauthenticated(res);
  const body = await readBody(res);

  if (res.status === 400 && body.fields) throw new EquipmentValidationError(body.fields as Record<string, string>);
  if (!res.ok || !body.equipment) throw new EquipmentRequestError((body.error as string | undefined) ?? "Failed to change the stock");
  return body.equipment as EquipmentCatalogItem;
}

/** The most recent stock changes of an item, newest first. */
export async function fetchStockHistory(id: number): Promise<StockChange[]> {
  const res = await fetch(`${catalogApiBase}/${id}/stock-history`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load the stock history");
  return ((await res.json()) as { changes: StockChange[] }).changes;
}
