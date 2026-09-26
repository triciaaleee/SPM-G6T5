/**
 * Reads events through events-service's REST API — venue-service never
 * queries the events table itself (events-service owns it). The caller's
 * own bearer token is forwarded, so events-service's access rules apply
 * exactly as if the coordinator had asked for the event directly.
 */

export interface EventForVenues {
  id: number;
  status: string;
  submitted_details: Record<string, unknown>;
}

export type FetchEventResult =
  | { status: "ok"; event: EventForVenues }
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
  // the attempt; from here both just mean there's no event to recommend for.
  if (res.status === 403 || res.status === 404) return { status: "not_found" };
  if (!res.ok) return { status: "error" };

  const body = (await res.json()) as { event?: EventForVenues };
  return body.event ? { status: "ok", event: body.event } : { status: "not_found" };
}

/**
 * E1-5: what venue staff may know about an event booked at their venue —
 * events-service's GET /venue-booking-info returns only these fields. The
 * free-text requirement fields are for extracting layout/facilities here;
 * they're not passed on to the browser.
 */
export interface VenueBookingInfo {
  id: number;
  name: string | null;
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  expectedAttendance: number | null;
  venue: string | null;
  accessibility: string | null;
  equipment: string | null;
  technicalSupport: string | null;
}

export type FetchVenueBookingInfoResult = { status: "ok"; events: VenueBookingInfo[] } | { status: "error" };

/**
 * Booking info for several events in one call. Events that don't come back
 * (deleted, or still a draft) are simply missing from the list.
 */
export async function fetchVenueBookingInfo(
  eventIds: number[],
  authorization: string,
): Promise<FetchVenueBookingInfoResult> {
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

  const body = (await res.json()) as { events?: VenueBookingInfo[] };
  return { status: "ok", events: body.events ?? [] };
}
