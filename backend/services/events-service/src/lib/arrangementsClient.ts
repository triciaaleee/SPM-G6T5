/**
 * E3-4: an event's venue and equipment arrangements, read from the services
 * that own them (AGENTS.md §1) — venue bookings from venue-service,
 * equipment requests from equipment-service. The caller's own bearer token
 * is forwarded, so each service applies its own access check (both admit
 * the event's coordinator).
 */

export interface ArrangementBooking {
  id: number;
  status: string;
  venue: { id: number; name: string } | null;
}

export interface ArrangementEquipmentItem {
  id: number;
  equipmentType: string;
  quantity: number;
  quantityFulfilled: number;
}

export interface ArrangementEquipmentRequest {
  id: number;
  status: string;
  items: ArrangementEquipmentItem[];
}

export type FetchResult<T> = { status: "ok"; value: T } | { status: "error" };

function venueServiceUrl(): string {
  return process.env.VENUE_SERVICE_URL ?? `http://localhost:${process.env.VENUE_SERVICE_PORT ?? 4003}`;
}

function equipmentServiceUrl(): string {
  return process.env.EQUIPMENT_SERVICE_URL ?? `http://localhost:${process.env.EQUIPMENT_SERVICE_PORT ?? 4005}`;
}

async function getJson<T>(url: string, authorization: string): Promise<FetchResult<T>> {
  try {
    const res = await fetch(url, { headers: { Authorization: authorization } });
    if (!res.ok) return { status: "error" };
    return { status: "ok", value: (await res.json()) as T };
  } catch {
    return { status: "error" };
  }
}

/** Every venue booking for the event, whatever its status. */
export async function fetchEventVenueBookings(
  eventId: number,
  authorization: string,
): Promise<FetchResult<ArrangementBooking[]>> {
  const result = await getJson<{ bookings?: ArrangementBooking[] }>(
    `${venueServiceUrl()}/api/venues/events/${eventId}/bookings`,
    authorization,
  );
  return result.status === "ok" ? { status: "ok", value: result.value.bookings ?? [] } : result;
}

/** Every equipment request recorded for the event, with its items. */
export async function fetchEventEquipmentRequests(
  eventId: number,
  authorization: string,
): Promise<FetchResult<ArrangementEquipmentRequest[]>> {
  const result = await getJson<{ equipmentRequests?: ArrangementEquipmentRequest[] }>(
    `${equipmentServiceUrl()}/api/equipment-requests?eventId=${eventId}`,
    authorization,
  );
  return result.status === "ok" ? { status: "ok", value: result.value.equipmentRequests ?? [] } : result;
}
