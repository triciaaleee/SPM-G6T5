/**
 * Where events are held, from venue-service's attendee-info endpoint —
 * venue names for Approved bookings only. registration-service never reads
 * venue_bookings itself.
 */

function venueServiceUrl(): string {
  return process.env.VENUE_SERVICE_URL ?? `http://localhost:${process.env.VENUE_SERVICE_PORT ?? 4003}`;
}

export type FetchVenueNamesResult = { status: "ok"; venuesByEvent: Map<number, string[]> } | { status: "error" };

export async function fetchVenueNames(eventIds: number[], authorization: string): Promise<FetchVenueNamesResult> {
  const venuesByEvent = new Map<number, string[]>();
  if (eventIds.length === 0) return { status: "ok", venuesByEvent };

  let res: Response;
  try {
    res = await fetch(`${venueServiceUrl()}/api/venues/attendee-info?eventIds=${eventIds.join(",")}`, {
      headers: { Authorization: authorization },
    });
  } catch {
    return { status: "error" };
  }
  if (!res.ok) return { status: "error" };

  const body = (await res.json()) as { venues?: { eventId: number; venueName: string }[] };
  for (const { eventId, venueName } of body.venues ?? []) {
    venuesByEvent.set(eventId, [...(venuesByEvent.get(eventId) ?? []), venueName]);
  }
  return { status: "ok", venuesByEvent };
}
