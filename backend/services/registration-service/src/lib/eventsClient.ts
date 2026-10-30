/**
 * Reads events through events-service's REST API — registration-service
 * never queries the events table itself (events-service owns it). The
 * caller's own bearer token is forwarded, so events-service's access rules
 * apply exactly as if the caller had asked directly.
 */

function eventsServiceUrl(): string {
  return process.env.EVENTS_SERVICE_URL ?? `http://localhost:${process.env.EVENTS_SERVICE_PORT ?? 4001}`;
}

/**
 * The attendee-facing fields of an event (events-service `attendee-info`).
 * Nothing internal is in this shape, so nothing internal can leak through
 * a route that returns it.
 */
export interface AttendeeEventInfo {
  id: number;
  name: string | null;
  description: string | null;
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  /** The organiser's accessibility note, or null when there is none. */
  accessibility: string | null;
  registrationNeeded: boolean;
  /** How many may register (decided by events-service); null means no cap. */
  capacity: number | null;
  /** The organiser's display name (name only), or null when it isn't known. */
  organiserName?: string | null;
  /** Registration state decided by events-service (it can't see the count, so never FULL here). */
  registrationState?: "NOT_OPEN" | "OPEN" | "CLOSED";
  /** Registration has opened for attendees (open date reached or forced open). */
  listed?: boolean;
  /** The attendee may find and open the event: listed, or Confirmed with no registration and not yet ended. */
  viewable?: boolean;
  /** The state is OPEN: Confirmed, in the registration period, not started. */
  open: boolean;
  /** E6-4: the event has started (Singapore time), so a place can no longer be withdrawn. */
  hasStarted?: boolean;
}

export type FetchEventsResult = { status: "ok"; events: AttendeeEventInfo[] } | { status: "error" };

async function getEvents(path: string, authorization: string): Promise<FetchEventsResult> {
  let res: Response;
  try {
    res = await fetch(`${eventsServiceUrl()}${path}`, { headers: { Authorization: authorization } });
  } catch {
    return { status: "error" };
  }
  if (!res.ok) return { status: "error" };

  const body = (await res.json()) as { events?: AttendeeEventInfo[] };
  return { status: "ok", events: body.events ?? [] };
}

/** Attendee-facing info for several events. Missing ids (and drafts) simply aren't returned. */
export async function fetchAttendeeEvents(eventIds: number[], authorization: string): Promise<FetchEventsResult> {
  if (eventIds.length === 0) return { status: "ok", events: [] };
  return getEvents(`/api/events/attendee-info?ids=${eventIds.join(",")}`, authorization);
}

/** Every event whose registration has opened (open, full or closed) — not ones still to open. */
export async function fetchOpenEvents(authorization: string): Promise<FetchEventsResult> {
  return getEvents("/api/events/open-for-registration", authorization);
}

export type CanViewEventResult = { status: "ok" } | { status: "denied" } | { status: "error" };

/**
 * Whether the caller may see this event's full record: events-service's
 * GET /api/events/:id admits the owning organiser or a coordinator and
 * answers 403 to everyone else (and for an event that doesn't exist).
 * Only the verdict is used — the event body is discarded, since a roster
 * has no business with the planning details.
 */
export async function canViewEvent(eventId: number, authorization: string): Promise<CanViewEventResult> {
  let res: Response;
  try {
    res = await fetch(`${eventsServiceUrl()}/api/events/${eventId}`, { headers: { Authorization: authorization } });
  } catch {
    return { status: "error" };
  }

  if (res.status === 403 || res.status === 404) return { status: "denied" };
  return res.ok ? { status: "ok" } : { status: "error" };
}
