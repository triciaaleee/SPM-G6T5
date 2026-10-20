import type { RegistrationStateValue } from "./registrationStatus";

/**
 * The guest-facing landing pages: events and venues anyone can browse
 * without an account. No auth header — these routes are public on the
 * backend (events-service /api/events/public, venue-service
 * /api/venues/public). Registering still needs an attendee account.
 */
const eventsBase = import.meta.env.VITE_EVENTS_API_URL as string;
const venuesBase = import.meta.env.VITE_VENUES_API_URL as string;

/** A listed event as guests see it: no capacity or places count (that needs an account). */
export interface PublicEvent {
  id: number;
  name: string | null;
  description: string | null;
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  accessibility: string | null;
  organiserName: string | null;
  registrationState: RegistrationStateValue;
  open: boolean;
}

export interface PublicVenueEvent {
  id: number;
  name: string | null;
  proposedDate: string | null;
  startTime: string | null;
}

export interface PublicVenue {
  id: number;
  name: string;
  location: string;
  description: string | null;
  capacity: number;
  accessibility: string[];
  layouts: string[];
  facilities: string[];
  /** Publicly listed events with an approved booking here, soonest first. */
  upcomingEvents: PublicVenueEvent[];
}

/** The event isn't listed publicly (or doesn't exist). */
export class PublicEventNotFoundError extends Error {}

export async function fetchPublicEvents(): Promise<PublicEvent[]> {
  const res = await fetch(`${eventsBase}/public`);
  if (!res.ok) throw new Error("Failed to load events");
  return ((await res.json()) as { events: PublicEvent[] }).events;
}

export async function fetchPublicEvent(id: string | number): Promise<PublicEvent> {
  const res = await fetch(`${eventsBase}/public/${id}`);
  if (res.status === 404 || res.status === 400) throw new PublicEventNotFoundError("Event not found");
  if (!res.ok) throw new Error("Failed to load the event");
  return ((await res.json()) as { event: PublicEvent }).event;
}

export async function fetchPublicVenues(): Promise<PublicVenue[]> {
  const res = await fetch(`${venuesBase}/public`);
  if (!res.ok) throw new Error("Failed to load venues");
  return ((await res.json()) as { venues: PublicVenue[] }).venues;
}

/** Venue names per event, for listed events only. Empty input needs no request. */
export async function fetchPublicEventVenues(eventIds: number[]): Promise<Map<number, string[]>> {
  const byEvent = new Map<number, string[]>();
  if (eventIds.length === 0) return byEvent;
  const res = await fetch(`${venuesBase}/public/event-venues?eventIds=${eventIds.join(",")}`);
  if (!res.ok) throw new Error("Failed to load venues");
  const { venues } = (await res.json()) as { venues: { eventId: number; venueName: string }[] };
  for (const { eventId, venueName } of venues) byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), venueName]);
  return byEvent;
}

/** Soonest first; an event with no date sorts last. */
export function byStartTime(a: PublicEvent, b: PublicEvent): number {
  const key = (e: PublicEvent) => `${e.proposedDate ?? "9999-12-31"}T${e.startTime ?? "00:00"}`;
  return key(a).localeCompare(key(b));
}
