/**
 * Reads events through events-service's REST API — equipment-service never
 * queries the events table itself (events-service owns it). The caller's
 * own bearer token is forwarded, so events-service's access rules apply
 * exactly as if the coordinator had asked for the event directly.
 */

export interface EventForEquipment {
  id: number;
  status: string;
  coordinator_id: string | null;
  submitted_details: Record<string, unknown>;
}

export type FetchEventResult =
  | { status: "ok"; event: EventForEquipment }
  | { status: "not_found" }
  | { status: "error" };

function eventsServiceUrl(): string {
  return process.env.EVENTS_SERVICE_URL ?? `http://localhost:${process.env.EVENTS_SERVICE_PORT ?? 4001}`;
}

export async function fetchEvent(eventId: number, authorization: string): Promise<FetchEventResult> {
  let res: Response;
  try {
    res = await fetch(`${eventsServiceUrl()}/api/events/${eventId}`, {
      headers: { Authorization: authorization },
    });
  } catch {
    return { status: "error" };
  }

  // events-service answers "not yours / doesn't exist" with 403 and records
  // the attempt; from here both just mean there's no event to act on.
  if (res.status === 403 || res.status === 404) return { status: "not_found" };
  if (!res.ok) return { status: "error" };

  const body = (await res.json()) as { event?: EventForEquipment };
  return body.event ? { status: "ok", event: body.event } : { status: "not_found" };
}

/**
 * E5-1 AC1: the event name/date/time Technical Support needs alongside a
 * request, read from events-service's existing venue-booking-info batch
 * lookup (it already returns exactly these fields, including the
 * Organiser's original equipment/technicalSupport notes used as reference
 * text — see AC2). technical_support is allowed to call it the same way
 * venue_staff and coordinator already are.
 */
export interface EquipmentBookingInfo {
  id: number;
  name: string | null;
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  equipment: string | null;
}

export type FetchBookingInfoResult = { status: "ok"; events: EquipmentBookingInfo[] } | { status: "error" };

/** Event info for several events in one call. Missing ids simply aren't returned. */
export async function fetchEventBookingInfo(
  eventIds: number[],
  authorization: string,
): Promise<FetchBookingInfoResult> {
  if (eventIds.length === 0) return { status: "ok", events: [] };

  let res: Response;
  try {
    res = await fetch(`${eventsServiceUrl()}/api/events/venue-booking-info?ids=${eventIds.join(",")}`, {
      headers: { Authorization: authorization },
    });
  } catch {
    return { status: "error" };
  }

  if (!res.ok) return { status: "error" };

  const body = (await res.json()) as { events?: EquipmentBookingInfo[] };
  return { status: "ok", events: body.events ?? [] };
}
