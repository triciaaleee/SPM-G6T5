import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

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
