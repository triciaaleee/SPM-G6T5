import { authHeader, redirectIfUnauthenticated } from "./eventsApi";
import type { BookingStatus } from "./bookingStatus";
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
  /** "HH:MM"; null when the event never recorded one. */
  startTime: string | null;
  endTime: string | null;
  /** venue_bookings.status (venue_booking_status enum). */
  status: BookingStatus;
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

/**
 * E4-1: a venue record as venue staff fill it in. The number fields are the
 * raw text typed, so "abc" reaches validation instead of silently becoming
 * 0 (AC4); the server does the same parsing.
 */
export interface VenueDraft {
  name: string;
  location: string;
  description: string;
  capacity: string;
  accessibility: string[];
  /** The venue genuinely has none — sent with an empty `accessibility` list. */
  noAccessibilityFeatures: boolean;
  layouts: string[];
  facilities: string[];
  setupMinutes: string;
  turnaroundMinutes: string;
  /** "HH:MM". */
  openingTime: string;
  closingTime: string;
}

/** A saved venue record, as venue-service returns it. */
export interface VenueRecord {
  id: number;
  name: string;
  location: string;
  description: string;
  capacity: number;
  accessibility: string[];
  layouts: string[];
  facilities: string[];
  setupMinutes: number;
  turnaroundMinutes: number;
  openingTime: string;
  closingTime: string;
  status: string;
}

/** AC6: a future Approved booking whose expected attendance no longer fits. */
export interface CapacityShortfall {
  bookingId: number;
  eventId: number;
  eventName: string | null;
  date: string;
  expectedAttendance: number;
  hasCoordinator: boolean;
}

interface OverlapSide {
  bookingId: number;
  eventId: number;
  eventName: string | null;
  /** The booking's new occupied window, e.g. "2026-10-12 09:30–12:45". */
  window: string;
  hasCoordinator: boolean;
}

/** Two bookings that only overlap under the new setup/turnaround times (§3a change 1). */
export interface BufferOverlap {
  first: OverlapSide;
  second: OverlapSide;
}

export interface VenueChangeImpact {
  capacityShortfalls: CapacityShortfall[];
  bufferOverlaps: BufferOverlap[];
}

export interface VenueUpdateResult extends VenueChangeImpact {
  venue: VenueRecord;
  coordinatorsNotified: number;
  notificationsFailed: boolean;
}

/** Option lists for the venue form — the same words coordinators filter by. */
export interface VenueFormOptions {
  locations: string[];
  accessibility: string[];
  layouts: string[];
  facilities: string[];
}

export class VenueFormError extends Error {
  fields: Record<string, string>;
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.fields = fields;
  }
}

export async function fetchVenueFormOptions(): Promise<VenueFormOptions> {
  const res = await fetch(`${apiBase}/staff/venue-options`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load venue options");
  return (await res.json()) as VenueFormOptions;
}

const jsonHeaders = () => ({ ...authHeader(), "Content-Type": "application/json" });

/** The venues this staff member looks after, in full. */
export async function fetchMyVenues(): Promise<VenueRecord[]> {
  const res = await fetch(`${apiBase}/staff/my-venues`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load your venues");
  return ((await res.json()) as { venues: VenueRecord[] }).venues;
}

async function sendVenue<T>(url: string, method: string, draft: VenueDraft, fallback: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method, headers: jsonHeaders(), body: JSON.stringify(draft), signal });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new VenueFormError(body.error ?? fallback, body.fields ?? {});
  return body as T;
}

export async function createVenue(draft: VenueDraft): Promise<VenueRecord> {
  const body = await sendVenue<{ venue: VenueRecord }>(`${apiBase}/staff/venues`, "POST", draft, "Failed to add the venue");
  return body.venue;
}

/** What saving `draft` would do to the venue's existing bookings. Nothing is written. */
export function previewVenueUpdate(venueId: number, draft: VenueDraft, signal?: AbortSignal): Promise<VenueChangeImpact> {
  return sendVenue(`${apiBase}/staff/venues/${venueId}/preview`, "POST", draft, "Failed to check bookings", signal);
}

export function updateVenue(venueId: number, draft: VenueDraft): Promise<VenueUpdateResult> {
  return sendVenue(`${apiBase}/staff/venues/${venueId}`, "PATCH", draft, "Failed to update the venue");
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

/** E4-8 AC5: one of an event's venue requests, as shown on the event page. */
export interface EventVenueBooking {
  id: number;
  status: BookingStatus;
  /** Set only while `On Hold`: when the hold lapses (E4-12). */
  holdExpiresAt: string | null;
  /** E4-10 AC4: why Venue Staff refused it, or the automatic reason. */
  decisionReason: string | null;
  createdAt: string;
  venue: { id: number; name: string; location: string } | null;
}

/**
 * E4-8 AC4/AC6: why a request was refused — the booking already holding
 * the venue, the window it occupies and the window that was asked for,
 * both including the venue's setup and turnaround time.
 */
export interface BookingConflict {
  bookingId: number;
  status: BookingStatus;
  window: string;
  requestedWindow: string;
  setupMinutes: number;
  turnaroundMinutes: number;
}

/**
 * E4-8 AC6 / E4-11: the one wording for a refused booking, used by the
 * coordinator's search and recommendations and by the Venue Staff queue, so
 * all three name the clashing window the same way. The padding is spelled
 * out because the window is wider than the event's own times (§3a change 1)
 * and that is otherwise baffling to read.
 */
export function describeBookingFailure(err: unknown, fallback = "That didn't work. Try again."): string {
  if (err instanceof BookingConflictError && err.conflict) {
    const { window, requestedWindow, setupMinutes, turnaroundMinutes } = err.conflict;
    const padding =
      setupMinutes > 0 || turnaroundMinutes > 0
        ? ` (setup ${setupMinutes} min, turnaround ${turnaroundMinutes} min)`
        : "";
    return `${err.message}. Already booked ${window}${padding}; this event needs ${requestedWindow}.`;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

export class BookingConflictError extends Error {
  conflict: BookingConflict | null;
  constructor(message: string, conflict: BookingConflict | null = null) {
    super(message);
    this.conflict = conflict;
  }
}

/** A booking request whose date/attendance the server rejected, per field. */
export class BookingRequestError extends Error {
  fields: Record<string, string>;
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.fields = fields;
  }
}

/**
 * E4-8: request `venueId` for `eventId`. The event supplies the date,
 * times, attendance and requirements, so nothing else is sent. A 409 means
 * the venue is already held or approved for an overlapping period, and
 * carries that window.
 */
export async function submitVenueBooking(eventId: number, venueId: number): Promise<EventVenueBooking> {
  const res = await fetch(`${apiBase}/bookings`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ eventId, venueId }),
  });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (res.status === 409) throw new BookingConflictError(body.error ?? "Venue is not available", body.conflict ?? null);
  if (!res.ok) throw new BookingRequestError(body.error ?? "Failed to request this venue", body.fields ?? {});
  return (body as { booking: EventVenueBooking }).booking;
}

/**
 * E4-8 AC5: every venue request made for one event, oldest first. Readable
 * by the owning organiser as well as a coordinator — E3-1 AC3 shows the
 * organiser whether a venue is still outstanding.
 */
export async function fetchEventVenueBookings(eventId: number): Promise<EventVenueBooking[]> {
  const res = await fetch(`${apiBase}/events/${eventId}/bookings`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed to load this event's venue requests");
  return (body as { bookings: EventVenueBooking[] }).bookings;
}

/** E4-10 AC6: one booking awaiting this staff member's decision. */
export interface PendingVenueRequest {
  id: number;
  status: BookingStatus;
  holdExpiresAt: string | null;
  venue: {
    id: number;
    name: string;
    location: string;
    setupMinutes: number;
    turnaroundMinutes: number;
  };
  event: {
    id: number;
    name: string | null;
    /** Local "YYYY-MM-DD". */
    date: string | null;
    startTime: string | null;
    endTime: string | null;
    expectedAttendance: number | null;
    layouts: string[];
    facilities: string[];
  };
}

/** The booking as it stands after Venue Staff decided on it. */
export interface DecidedBooking {
  id: number;
  status: BookingStatus;
  holdExpiresAt: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  venue: { id: number; name: string; location: string };
}

export interface BookingDecisionResult {
  booking: DecidedBooking;
  /** Overlapping requests this decision knocked out (§3a, E4-11 AC4). */
  autoRejectedBookingIds: number[];
}

/**
 * E4-10 AC6: every request at the staff member's venues still waiting on
 * a decision, soonest event first. Holds that lapsed are expired
 * server-side and never appear here.
 */
export async function fetchPendingRequests(): Promise<PendingVenueRequest[]> {
  const res = await fetch(`${apiBase}/staff/requests`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed to load booking requests");
  return (body as { requests: PendingVenueRequest[] }).requests;
}

/**
 * Hold, approve or reject one booking. A 409 is a refusal with its reason
 * (AC2) — the venue is taken, the event moved on, or the hold lapsed — and
 * carries the clashing window when there is one, so it reuses E4-8's
 * BookingConflictError.
 */
async function decideBooking(
  bookingId: number,
  action: "hold" | "approve" | "reject",
  body?: Record<string, unknown>,
): Promise<BookingDecisionResult> {
  const res = await fetch(`${apiBase}/staff/bookings/${bookingId}/${action}`, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  await redirectIfUnauthenticated(res);
  const payload = await res.json();
  if (res.status === 409) {
    throw new BookingConflictError(payload.error ?? "This action is no longer possible", payload.conflict ?? null);
  }
  if (!res.ok) throw new BookingRequestError(payload.error ?? "Failed to update the booking", payload.fields ?? {});
  return payload as BookingDecisionResult;
}

/** AC1: hold the venue tentatively; the server sets the expiry. */
export function holdBooking(bookingId: number): Promise<BookingDecisionResult> {
  return decideBooking(bookingId, "hold");
}

/** AC3: confirm the booking. */
export function approveBooking(bookingId: number): Promise<BookingDecisionResult> {
  return decideBooking(bookingId, "approve");
}

/** AC4: refuse it — a reason is required and the coordinator is told it. */
export function rejectBooking(bookingId: number, reason: string): Promise<BookingDecisionResult> {
  return decideBooking(bookingId, "reject", { reason });
}
