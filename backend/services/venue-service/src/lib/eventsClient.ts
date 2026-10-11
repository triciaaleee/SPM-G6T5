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
  /** E2-12 AC6: only the event's current coordinator may request a venue for it. */
  coordinator_id?: string | null;
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
  /**
   * The event's lifecycle status. Here because a booking can only be held
   * or approved while the event is in "Planning" (E4-10 AC2) and venue
   * staff cannot call GET /api/events/:id, which is owner-or-coordinator
   * only. Used for that check and never passed on to the browser.
   */
  status: string;
  name: string | null;
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  expectedAttendance: number | null;
  venue: string | null;
  accessibility: string | null;
  equipment: string | null;
  technicalSupport: string | null;
  /** E4-3: who to notify when this booking needs a replacement venue. */
  coordinatorId?: string | null;
}

export type FetchVenueBookingInfoResult = { status: "ok"; events: VenueBookingInfo[] } | { status: "error" };

/** events-service accepts at most this many ids per venue-booking-info call. */
export const VENUE_BOOKING_INFO_BATCH = 100;

/**
 * Booking info for any number of events, fetched in batches the
 * events-service limit allows. Events that don't come back (deleted, or
 * still a draft) are simply missing from the list. If any batch fails the
 * whole lookup fails, so callers never act on a partial picture.
 */
export async function fetchVenueBookingInfo(
  eventIds: number[],
  authorization: string,
): Promise<FetchVenueBookingInfoResult> {
  if (eventIds.length === 0) return { status: "ok", events: [] };

  const batches: number[][] = [];
  for (let i = 0; i < eventIds.length; i += VENUE_BOOKING_INFO_BATCH) {
    batches.push(eventIds.slice(i, i + VENUE_BOOKING_INFO_BATCH));
  }
  const results = await Promise.all(batches.map((batch) => fetchVenueBookingInfoBatch(batch, authorization)));
  if (results.some((result) => result.status === "error")) return { status: "error" };
  return { status: "ok", events: results.flatMap((result) => (result.status === "ok" ? result.events : [])) };
}

async function fetchVenueBookingInfoBatch(
  eventIds: number[],
  authorization: string,
): Promise<FetchVenueBookingInfoResult> {
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
