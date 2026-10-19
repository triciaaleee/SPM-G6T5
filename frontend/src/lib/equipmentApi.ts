import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

/** E5-6 AC3: whether this item's claimed units no longer hold, re-checked on every view. */
export interface ReservationFlag {
  flagged: boolean;
  reason: string | null;
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
}

/** E5-2: the coordinator cancelled the whole request — kept as history, nothing is reserved against it. */
export const CANCELLED_REQUEST_STATUS = "Cancelled";

/** E5-3: the real values status can take on, fixed by that story. */
export const EQUIPMENT_REQUEST_STATUSES = ["Requested", "Arranged", "Partially Fulfilled"] as const;
export type EquipmentRequestStatus = (typeof EQUIPMENT_REQUEST_STATUSES)[number];

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
  availableStock: number;
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
  /** equipment_catalog.available_stock for this type — null if it isn't in the catalog. */
  catalogAvailableStock: number | null;
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

/** The equipment catalog, for the request form's dropdown and Technical Support's stock table. */
export async function fetchEquipmentCatalog(): Promise<EquipmentCatalogItem[]> {
  const res = await fetch(catalogApiBase, { headers: authHeader() });
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
    throw new EquipmentValidationError(body.fields ?? {});
  }
  if (!res.ok) {
    throw new EquipmentRequestError(body.error ?? "Failed to record the equipment request");
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

async function readBody(res: Response): Promise<Record<string, any>> {
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
    throw new EquipmentValidationError(body.fields ?? {});
  }
  if (!res.ok) {
    throw new EquipmentRequestError(body.error ?? "Failed to amend the equipment request");
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
    throw new EquipmentRequestError(body.error ?? "Failed to cancel the equipment request");
  }
  return body as {
    equipmentRequest: EquipmentRequest;
    released: { equipmentType: string; quantity: number }[];
    notified: boolean;
  };
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
    throw new EquipmentValidationError(body.fields ?? {});
  }
  if (res.status === 409 && body.shortfalls) {
    throw new EquipmentReservationShortfallError(body.error ?? "Not enough equipment available for this change.", body.shortfalls);
  }
  if (!res.ok) {
    throw new EquipmentRequestError(body.error ?? "Failed to update the equipment request");
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
    throw new EquipmentRequestError(body.error ?? "Failed to check equipment availability");
  }
  return body as EquipmentAvailability;
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

/** E5-1 AC3: correct an item's total and/or available stock. */
export function updateCatalogItem(
  id: number,
  changes: { totalStock?: number; availableStock?: number },
): Promise<EquipmentCatalogItem> {
  return writeCatalog(`${catalogApiBase}/${id}`, "PATCH", changes, "Failed to update the equipment item");
}
