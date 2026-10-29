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
  // E3-8 AC4: capacity is only on the venue since Week 7 change 1 (venue-
  // service's eventBookings route) — null if that service's response
  // doesn't have it (e.g. a rolling deploy), so capacity checks degrade
  // rather than throw.
  venue: { id: number; name: string; capacity?: number | null } | null;
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
  if (result.status !== "ok") return result;
  return {
    status: "ok",
    value: (result.value.bookings ?? []).map((booking) => ({
      ...booking,
      venue: booking.venue ? { ...booking.venue, capacity: booking.venue.capacity ?? null } : null,
    })),
  };
}

/**
 * Every equipment request recorded for the event, with its items. A request
 * the coordinator cancelled (E5-2) is left out: it holds nothing and nobody is
 * waiting on it, so it must not count as an outstanding arrangement.
 */
export async function fetchEventEquipmentRequests(
  eventId: number,
  authorization: string,
): Promise<FetchResult<ArrangementEquipmentRequest[]>> {
  const result = await getJson<{ equipmentRequests?: ArrangementEquipmentRequest[] }>(
    `${equipmentServiceUrl()}/api/equipment-requests?eventId=${eventId}`,
    authorization,
  );
  return result.status === "ok"
    ? { status: "ok", value: (result.value.equipmentRequests ?? []).filter((request) => request.status !== "Cancelled") }
    : result;
}

/**
 * E3-11 AC2: flags a booking for rebooking after a coordinator approves a
 * held change that actually invalidated it (events-service decided that
 * using the same capacity/availability check E3-10 already runs — see
 * loadChangeRequestImpact in routes/events/changeRequests.ts). venue-service owns the
 * write and its own venue-staff notification; this just calls it.
 */
export async function flagBookingForRebooking(
  bookingId: number,
  reason: string,
  authorization: string,
): Promise<FetchResult<{ staffNotified: boolean }>> {
  try {
    const res = await fetch(`${venueServiceUrl()}/api/venues/bookings/${bookingId}/flag-for-rebooking`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) return { status: "error" };
    return { status: "ok", value: (await res.json()) as { staffNotified: boolean } };
  } catch {
    return { status: "error" };
  }
}

/**
 * E3-11 AC3: flags every equipment request on the event for Technical
 * Support to reassess, after the coordinator approves a change that held
 * the `equipment` field. equipment-service owns the write and its own
 * technical_support notification.
 */
export async function flagEquipmentForReassessment(
  eventId: number,
  reason: string,
  authorization: string,
): Promise<FetchResult<{ flaggedRequestIds: number[]; notified: boolean }>> {
  try {
    const res = await fetch(`${equipmentServiceUrl()}/api/equipment-requests/flag-for-event/${eventId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) return { status: "error" };
    return { status: "ok", value: (await res.json()) as { flaggedRequestIds: number[]; notified: boolean } };
  } catch {
    return { status: "error" };
  }
}

export interface BookingAvailability {
  available: boolean;
  unavailabilityConflict: { reason: string; description: string } | null;
  bookingConflict: { bookingId: number; status: string; window: string } | null;
}

/**
 * E3-10 AC2: whether a *proposed* new date/time for an existing booking
 * would clash with the venue's block-out periods or another booking —
 * read-only, venue-service's own re-check re-run early so the coordinator
 * sees it before deciding on a held schedule change.
 */
export async function checkBookingAvailability(
  bookingId: number,
  schedule: { proposedDate: string; startTime: string | null; endTime: string | null },
  authorization: string,
): Promise<FetchResult<BookingAvailability>> {
  const params = new URLSearchParams({ proposedDate: schedule.proposedDate });
  if (schedule.startTime) params.set("startTime", schedule.startTime);
  if (schedule.endTime) params.set("endTime", schedule.endTime);
  return getJson<BookingAvailability>(
    `${venueServiceUrl()}/api/venues/bookings/${bookingId}/availability-check?${params.toString()}`,
    authorization,
  );
}
