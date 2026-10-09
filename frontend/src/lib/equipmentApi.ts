import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

/** E5-1: one line item on an equipment request — type, quantity, technical requirements. */
export interface EquipmentItem {
  id: number;
  equipmentType: string;
  quantity: number;
  technicalRequirements: string;
}

export interface EquipmentRequest {
  id: number;
  eventId: number;
  status: string;
  createdAt: string;
  items: EquipmentItem[];
}

/** Only present on Technical Support's list (GET with no eventId). */
export interface EquipmentRequestWithEvent extends EquipmentRequest {
  event: { id: number; name: string | null; proposedDate: string | null; startTime: string | null; endTime: string | null } | null;
}

export interface EquipmentItemInput {
  equipmentType: string;
  quantity: number | string;
  technicalRequirements: string;
}

const apiBase =
  (import.meta.env.VITE_EQUIPMENT_API_URL as string | undefined) ?? "http://localhost:4005/api/equipment-requests";

export class EquipmentValidationError extends Error {
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super("Validation failed");
    this.fields = fields;
  }
}

export class EquipmentRequestError extends Error {}

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
