/**
 * Reads where events are held through venue-service's REST API — equipment-service
 * never queries venue_bookings itself (venue-service owns it). Technical Support's
 * own bearer token is forwarded.
 *
 * The event's own `venue` field is the organiser's free-text requirement ("Indoor
 * room for 60"), not a venue, so Technical Support is shown the booked venue
 * from here instead.
 */

function venueServiceUrl(): string {
  return process.env.VENUE_SERVICE_URL ?? `http://localhost:${process.env.VENUE_SERVICE_PORT ?? 4003}`;
}

/**
 * Booked (Approved) venue names per event id, several joined with ", " when an
 * event has more than one. An event with no approved booking is left out. Best
 * effort: if venue-service is unreachable or refuses, every event is simply left
 * out and the page says the venue is to be confirmed.
 */
export async function fetchBookedVenueNames(
  eventIds: number[],
  authorization: string,
): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (eventIds.length === 0) return names;

  let res: Response;
  try {
    res = await fetch(`${venueServiceUrl()}/api/venues/support-info?eventIds=${eventIds.join(",")}`, {
      headers: { Authorization: authorization },
    });
  } catch {
    return names;
  }
  if (!res.ok) return names;

  const body = (await res.json().catch(() => ({}))) as { venues?: { eventId: number; venueName: string }[] };
  const byEvent = new Map<number, string[]>();
  for (const { eventId, venueName } of body.venues ?? []) {
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), venueName]);
  }
  for (const [eventId, list] of byEvent) names.set(eventId, list.join(", "));
  return names;
}
