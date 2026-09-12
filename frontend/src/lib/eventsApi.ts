import { clearSession, getStoredUser, getToken } from "./auth";

export interface EventSummary {
  id: number;
  status: string;
  submitted_details: Record<string, unknown>;
  coordinator_id: string | null;
  review_outcome: string | null;
  created_at: string;
}

const apiBase = import.meta.env.VITE_EVENTS_API_URL as string;

function authHeader(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export class SessionExpiredError extends Error {}

/**
 * AC5, the other half: the router guard only runs on navigation, so a
 * token that dies while the user sits on a page would otherwise surface as
 * a generic "Failed to load events". A 401 from the backend is the
 * authoritative word that the session is over — drop it and send them to
 * login, carrying the current URL so they return here afterwards.
 *
 * Callers should invoke this before interpreting any non-OK response.
 */
async function redirectIfUnauthenticated(res: Response): Promise<void> {
  if (res.status !== 401) return;

  clearSession();
  // Imported here rather than at the top of the file: the router pulls in
  // the views, and the views pull in this module, so a static import would
  // close a cycle. By the time a request can 401, the router is long since
  // constructed.
  const { router } = await import("../router");
  const current = router.currentRoute.value.fullPath;
  await router.replace({
    name: "login",
    query: current === "/" ? {} : { redirect: current },
  });
  throw new SessionExpiredError("Your session has expired. Please log in again.");
}

export async function fetchMyEvents(): Promise<EventSummary[]> {
  const res = await fetch(apiBase, { headers: await authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load events");
  const body = await res.json();
  return body.events as EventSummary[];
}

export interface EventRequestPayload {
  name: string;
  purpose: string;
  description: string;
  proposedDate: string;
  startTime: string;
  endTime: string;
  expectedAttendance: number | string;
}

export class ValidationError extends Error {
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super("Validation failed");
    this.fields = fields;
  }
}

export class AccessDeniedError extends Error {}

export async function submitEventRequest(payload: EventRequestPayload): Promise<EventSummary> {
  const res = await fetch(apiBase, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(payload),
  });

  await redirectIfUnauthenticated(res);

  const body = await res.json();

  if (res.status === 400) {
    throw new ValidationError(body.fields ?? {});
  }
  if (!res.ok) {
    throw new Error(body.error ?? "Failed to submit event request");
  }

  return body.event as EventSummary;
}

export class NotFoundError extends Error {}

export async function fetchEventById(id: string): Promise<EventSummary> {
  const res = await fetch(`${apiBase}/${id}`, { headers: await authHeader() });
  await redirectIfUnauthenticated(res);
  if (res.status === 403) throw new AccessDeniedError("You don't have access to this event");
  if (res.status === 404) throw new NotFoundError("Event not found");
  if (!res.ok) throw new Error("Failed to load event");
  const body = await res.json();
  return body.event as EventSummary;
}

export async function getCurrentUser(): Promise<{ id: string; role: string | undefined }> {
  const user = getStoredUser();
  return { id: user?.id ?? "", role: user?.role };
}
