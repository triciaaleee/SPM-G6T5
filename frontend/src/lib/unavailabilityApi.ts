import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

/**
 * E4-3: venue staff's block-out periods. A period covers every day from
 * startDate to endDate (inclusive) — either the whole day, or the same
 * startTime–endTime hours on each day.
 */
export interface UnavailabilityPeriod {
  id: number;
  venueId: number;
  /** Local "YYYY-MM-DD". */
  startDate: string;
  endDate: string;
  allDay: boolean;
  /** "HH:MM"; null when allDay. */
  startTime: string | null;
  endTime: string | null;
  reason: string;
}

export interface PeriodDraft {
  venueId: number;
  startDate: string;
  endDate: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  reason: string;
}

/** A live (Requested or Approved) booking a block-out cuts across. */
export interface AffectedBooking {
  bookingId: number;
  status: string;
  eventId: number;
  eventName: string | null;
  date: string;
  startTime: string | null;
  endTime: string | null;
  /** The event's times widened by the venue's setup/turnaround — what was checked. */
  occupiedStart: string | null;
  occupiedEnd: string | null;
  hasCoordinator: boolean;
}

export interface CreatePeriodResult {
  period: UnavailabilityPeriod;
  affected: AffectedBooking[];
  coordinatorsNotified: number;
  notificationsFailed: boolean;
}

export class PeriodError extends Error {
  fields: Record<string, string>;
  constructor(message: string, fields: Record<string, string> = {}) {
    super(message);
    this.fields = fields;
  }
}

const apiBase = `${import.meta.env.VITE_VENUES_API_URL as string}/unavailability`;

function toBody(draft: PeriodDraft): string {
  return JSON.stringify({
    ...draft,
    startTime: draft.allDay ? undefined : draft.startTime,
    endTime: draft.allDay ? undefined : draft.endTime,
  });
}

const jsonHeaders = () => ({ ...authHeader(), "Content-Type": "application/json" });

/** Periods at one venue overlapping `from`..`to` (inclusive, at most 42 days). */
export async function fetchUnavailability(venueId: number, from: string, to: string): Promise<UnavailabilityPeriod[]> {
  const params = new URLSearchParams({ venueId: String(venueId), from, to });
  const res = await fetch(`${apiBase}?${params}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? "Failed to load unavailability");
  return (body as { periods: UnavailabilityPeriod[] }).periods;
}

export interface PeriodPreview {
  affected: AffectedBooking[];
  setupMinutes: number;
  turnaroundMinutes: number;
}

/** Which live bookings a draft period would affect. Saves nothing. */
export async function previewUnavailability(draft: PeriodDraft, signal?: AbortSignal): Promise<PeriodPreview> {
  const res = await fetch(`${apiBase}/preview`, { method: "POST", headers: jsonHeaders(), body: toBody(draft), signal });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new PeriodError(body.error ?? "Failed to check bookings", body.fields ?? {});
  return body as PeriodPreview;
}

export async function createUnavailability(draft: PeriodDraft): Promise<CreatePeriodResult> {
  const res = await fetch(apiBase, { method: "POST", headers: jsonHeaders(), body: toBody(draft) });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new PeriodError(body.error ?? "Failed to save the block-out", body.fields ?? {});
  return body as CreatePeriodResult;
}

/** Edit a period's dates, hours or reason. It stays at the same venue. */
export async function updateUnavailability(id: number, draft: PeriodDraft): Promise<CreatePeriodResult> {
  const res = await fetch(`${apiBase}/${id}`, { method: "PUT", headers: jsonHeaders(), body: toBody(draft) });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new PeriodError(body.error ?? "Failed to save the block-out", body.fields ?? {});
  return body as CreatePeriodResult;
}

export async function deleteUnavailability(id: number): Promise<void> {
  const res = await fetch(`${apiBase}/${id}`, { method: "DELETE", headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to remove the block-out");
}
