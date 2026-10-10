import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

/** E5-1: one line item on an equipment request — type and quantity. */
export interface EquipmentItem {
  id: number;
  equipmentType: string;
  quantity: number;
  /** E5-3: how much of this item is currently taken off the shelf for this request. */
  quantityFulfilled: number;
}

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

/** Only present on Technical Support's list (GET with no eventId). */
export interface EquipmentRequestWithEvent extends EquipmentRequest {
  event: { id: number; name: string | null; proposedDate: string | null; startTime: string | null; endTime: string | null } | null;
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
