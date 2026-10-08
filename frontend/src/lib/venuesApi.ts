import { authHeader, redirectIfUnauthenticated } from "./eventsApi";
import type { UnavailabilityPeriod } from "./unavailabilityApi";

export interface Venue {
  id: number;
  name: string;
  location: string;
  description: string | null;
  capacity: number;
  accessibility: string[];
  layouts: string[];
  facilities: string[];
}

/** Mirrors VenueSearchCriteria in events-service's lib/venueSearch.ts. */
export interface VenueFilters {
  q: string;
  date: string | null;
  startTime: string;
  endTime: string;
  capacityMin: number | null;
  capacityMax: number | null;
  accessibility: string[];
  layouts: string[];
  facilities: string[];
}

/** The criteria this UI sets. The API also accepts attendance/locations,
 * which aren't exposed here — pre-filled attendance goes into capacityMin. */
export type CriterionKey =
  | "q"
  | "availability"
  | "capacity"
  | "accessibility"
  | "layouts"
  | "facilities";

export interface RelaxOption {
  key: CriterionKey;
  label: string;
  count: number;
}

export interface VenueSearchResult {
  venues: Venue[];
  relax: RelaxOption[];
}

export interface VenueFilterOptions {
  accessibility: string[];
  layouts: string[];
  facilities: string[];
  capacity: { min: number; max: number } | null;
}

export function emptyVenueFilters(): VenueFilters {
  return {
    q: "",
    date: null,
    startTime: "",
    endTime: "",
    capacityMin: null,
    capacityMax: null,
    accessibility: [],
    layouts: [],
    facilities: [],
  };
}

/** Resets just the filter(s) behind one criterion — used by "relax filters". */
export function clearCriterion(filters: VenueFilters, key: CriterionKey): void {
  switch (key) {
    case "q":
      filters.q = "";
      break;
    case "availability":
      filters.date = null;
      filters.startTime = "";
      filters.endTime = "";
      break;
    case "capacity":
      filters.capacityMin = null;
      filters.capacityMax = null;
      break;
    default:
      filters[key] = [];
  }
}

// Same service as events (events-service), so default to its sibling path
// rather than requiring a new env var for every checkout.
const eventsBase = import.meta.env.VITE_EVENTS_API_URL as string;
const apiBase = (import.meta.env.VITE_VENUES_API_URL as string | undefined) ?? eventsBase.replace(/\/events\/?$/, "/venues");

function toQuery(filters: VenueFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.date) {
    params.set("date", filters.date);
    if (filters.startTime && filters.endTime) {
      params.set("startTime", filters.startTime);
      params.set("endTime", filters.endTime);
    }
  }
  if (filters.capacityMin) params.set("capacityMin", String(filters.capacityMin));
  if (filters.capacityMax) params.set("capacityMax", String(filters.capacityMax));
  for (const key of ["accessibility", "layouts", "facilities"] as const) {
    for (const value of filters[key]) params.append(key, value);
  }
  return params;
}

export class VenueSearchError extends Error {
  fields: Record<string, string>;
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.fields = fields;
  }
}

export async function searchVenues(filters: VenueFilters): Promise<VenueSearchResult> {
  const res = await fetch(`${apiBase}?${toQuery(filters)}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new VenueSearchError(body.error ?? "Failed to search venues", body.fields ?? {});
  return body as VenueSearchResult;
}

export async function fetchVenueFilterOptions(): Promise<VenueFilterOptions> {
  const res = await fetch(`${apiBase}/filters`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load venue filters");
  return (await res.json()) as VenueFilterOptions;
}

/** What venue-service checked each recommended venue against. */
export interface EventVenueRequirements {
  attendance: number | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  accessibility: string[];
  layouts: string[];
  facilities: string[];
}

export interface VenueRecommendations {
  requirements: EventVenueRequirements;
  /** Every venue meeting all requirements, tightest capacity fit first. */
  venues: Venue[];
}

export async function fetchVenueRecommendations(eventId: number): Promise<VenueRecommendations> {
  const res = await fetch(`${apiBase}/recommendations/${eventId}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed to load venue recommendations");
  return body as VenueRecommendations;
}

/** E1-5: a venue in the venue staff schedule's picker. */
export interface StaffVenueOption {
  id: number;
  name: string;
}

/**
 * E1-5: one booking on the venue schedule. venue_bookings only links a
 * venue to an event, so the date and times are the event's own. Carries
 * only what venue staff need to set up — never the event's wider plan.
 */
export interface VenueBooking {
  id: number;
  /** Local "YYYY-MM-DD". */
  date: string;
  /** "HH:MM". */
  startTime: string | null;
  endTime: string | null;
  /** venue_bookings.status (venue_status enum). Replacement Required: caught by a block-out (E4-3). */
  status: "Requested" | "Approved" | "Rejected" | "Replacement Required";
  event: {
    id: number;
    name: string | null;
    expectedAttendance: number | null;
    layouts: string[];
    facilities: string[];
  };
}

export async function fetchStaffVenues(): Promise<StaffVenueOption[]> {
  const res = await fetch(`${apiBase}/staff/venues`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load venues");
  return ((await res.json()) as { venues: StaffVenueOption[] }).venues;
}

/** Bookings at one venue between two local dates, inclusive (at most 42 days). */
export async function fetchVenueBookings(venueId: number, from: string, to: string): Promise<VenueBooking[]> {
  const params = new URLSearchParams({ from, to });
  const res = await fetch(`${apiBase}/staff/${venueId}/bookings?${params}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed to load bookings");
  return (body as { bookings: VenueBooking[] }).bookings;
}

/** A booking that makes the venue unavailable on the coordinator's availability calendar. */
export interface AvailabilityBooking {
  id: number;
  status: "Approved" | "On Hold";
  /** Local "YYYY-MM-DD" — the event's own date. */
  date: string;
  /** The event's advertised times ("HH:MM"); null when it has none. */
  startTime: string | null;
  endTime: string | null;
  /** The advertised times padded by the venue's setup and turnaround ("24:00" = midnight). */
  occupiedStart: string;
  occupiedEnd: string;
  /** On Hold only: when the hold lapses (ISO timestamp). */
  holdExpiresAt: string | null;
  event: { id: number; name: string | null };
}

/** A free stretch inside the target; eventStart–eventEnd is the event that fits once setup/turnaround are allowed for. */
export interface FreeSlot {
  date: string;
  start: string;
  end: string;
  eventStart: string;
  eventEnd: string;
}

export interface AvailabilityTarget {
  fromDate: string;
  toDate: string;
  startTime: string | null;
  endTime: string | null;
}

export interface VenueAvailability {
  venue: {
    id: number;
    name: string;
    location: string;
    capacity: number;
    setupMinutes: number;
    turnaroundMinutes: number;
    /** "HH:MM"; closingTime may be "24:00". */
    openingTime: string;
    closingTime: string;
  };
  bookings: AvailabilityBooking[];
  unavailability: UnavailabilityPeriod[];
  target: AvailabilityTarget | null;
  freeSlots: FreeSlot[];
}

/**
 * One venue's availability between two local dates (inclusive, at most 42
 * days), plus free slots when a target is given.
 */
export async function fetchVenueAvailability(
  venueId: number,
  from: string,
  to: string,
  target: AvailabilityTarget | null = null,
  signal?: AbortSignal,
): Promise<VenueAvailability> {
  const params = new URLSearchParams({ from, to });
  if (target) {
    params.set("targetFrom", target.fromDate);
    params.set("targetTo", target.toDate);
    if (target.startTime) params.set("targetStart", target.startTime);
    if (target.endTime) params.set("targetEnd", target.endTime);
  }
  const res = await fetch(`${apiBase}/${venueId}/availability?${params}`, { headers: authHeader(), signal });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new VenueSearchError(body.error ?? "Failed to load venue availability", body.fields ?? {});
  return body as VenueAvailability;
}

/**
 * Client-side mirror of the server's time-window rules, so the date
 * popover can flag a bad window inline and the view can skip a request
 * that would only 400.
 */
export function timeWindowError(filters: VenueFilters): string | null {
  const { startTime, endTime } = filters;
  if (!startTime && !endTime) return null;
  if (!startTime || !endTime) return "Give both a start and an end time, or leave both empty for the whole day.";
  if (endTime <= startTime) return "End time must be after start time.";
  return null;
}
