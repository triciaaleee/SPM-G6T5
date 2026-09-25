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
