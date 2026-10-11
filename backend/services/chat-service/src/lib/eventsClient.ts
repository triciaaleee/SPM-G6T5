/**
 * Reads events through events-service's REST API — chat-service never
 * queries the events table itself (events-service owns it). The caller's
 * own bearer token is forwarded, so events-service's access rules apply
 * exactly as if the organiser/coordinator had asked for the event directly.
 */

export interface EventForChat {
  id: number;
  status: string;
  organiser_id: string;
  coordinator_id: string | null;
  submitted_details: Record<string, unknown>;
}

export type FetchEventResult =
  | { status: "ok"; event: EventForChat }
  | { status: "not_found" }
  | { status: "error" };

function eventsServiceUrl(): string {
  return process.env.EVENTS_SERVICE_URL ?? `http://localhost:${process.env.EVENTS_SERVICE_PORT ?? 4001}`;
}

/**
 * One event, for a per-thread access check. GET /:id already enforces
 * "owning organiser or any coordinator" itself; a 403/404 from there is
 * nothing this caller may open a thread on either way.
 */
export async function fetchEvent(eventId: number, authorization: string): Promise<FetchEventResult> {
  let res: Response;
  try {
    res = await fetch(`${eventsServiceUrl()}/api/events/${eventId}`, {
      headers: { Authorization: authorization },
    });
  } catch {
    return { status: "error" };
  }

  if (res.status === 403 || res.status === 404) return { status: "not_found" };
  if (!res.ok) return { status: "error" };

  const body = (await res.json()) as { event?: EventForChat };
  return body.event ? { status: "ok", event: body.event } : { status: "not_found" };
}

export interface EventForThreadList {
  id: number;
  status: string;
  coordinatorId: string | null;
  coordinatorName: string | null;
  organiserName: string | null;
  name: string | null;
  createdAt: string;
}

export type FetchEventsResult = { status: "ok"; events: EventForThreadList[] } | { status: "error" };

/**
 * E2-15: the inbox list reads straight off events-service's own GET /
 * (already scoped per role — an organiser's own events, or every
 * non-draft event for a coordinator) rather than a bespoke endpoint;
 * chat-service narrows that down itself (coordinator assigned, caller is
 * that coordinator) when building the thread summary.
 */
export async function fetchEventsForRole(authorization: string): Promise<FetchEventsResult> {
  let res: Response;
  try {
    res = await fetch(`${eventsServiceUrl()}/api/events`, {
      headers: { Authorization: authorization },
    });
  } catch {
    return { status: "error" };
  }
  if (!res.ok) return { status: "error" };

  interface RawEvent {
    id: number;
    status: string;
    coordinator_id: string | null;
    coordinator: { name: string } | null;
    organiser: { name: string } | null;
    submitted_details: Record<string, unknown>;
    created_at: string;
  }
  const body = (await res.json()) as { events?: RawEvent[] };

  const events = (body.events ?? []).map((row) => ({
    id: row.id,
    status: row.status,
    coordinatorId: row.coordinator_id,
    coordinatorName: row.coordinator?.name ?? null,
    organiserName: row.organiser?.name ?? null,
    name: (row.submitted_details?.name as string | undefined) ?? null,
    createdAt: row.created_at,
  }));

  return { status: "ok", events };
}
