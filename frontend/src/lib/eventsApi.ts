import { clearSession, getStoredUser, getToken } from "./auth";

export interface EventSummary {
  id: number;
  status: string;
  submitted_details: Record<string, unknown>;
  coordinator_id: string | null;
  /** E2-6 AC2: the assigned coordinator's display name, embedded via the FK. */
  coordinator: { name: string } | null;
  review_outcome: string | null;
  decided_at: string | null;
  decided_by: string | null;
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
  venue: string;
  accessibility: string;
  equipment: string;
  technicalSupport: string;
  registrationNeeded: boolean;
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

/**
 * Thrown by the three coordinator decision actions below when the backend
 * refuses the transition (wrong status, another coordinator owns it,
 * missing reason/message). Message is server-provided and safe to show
 * directly — see the "generic error, pass it through" pattern in auth.ts.
 */
export class ReviewActionError extends Error {}

async function postReviewAction(id: number, action: string, body?: Record<string, unknown>): Promise<EventSummary> {
  const res = await fetch(`${apiBase}/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify(body ?? {}),
  });

  await redirectIfUnauthenticated(res);

  const responseBody = await res.json();

  if (!res.ok) {
    throw new ReviewActionError(responseBody.error ?? "That action couldn't be completed");
  }

  return responseBody.event as EventSummary;
}

/** E1-4.2 AC1: approve as the assigned (or self-assigning) coordinator. */
export function approveEvent(id: number): Promise<EventSummary> {
  return postReviewAction(id, "approve");
}

/** E1-4.2 AC2/AC3: reject with a mandatory reason. */
export function rejectEvent(id: number, reason: string): Promise<EventSummary> {
  return postReviewAction(id, "reject", { reason });
}

/** Requests clarification/amendment from the Organiser with a message. */
export function requestClarification(id: number, message: string): Promise<EventSummary> {
  return postReviewAction(id, "request-clarification", { message });
}

export interface ClarificationMessage {
  id: number;
  parent_id: number | null;
  author_id: string;
  author_role: "coordinator" | "organiser";
  message: string;
  /** Only meaningful for a top-level question (parent_id null) — see resolveClarificationQuestion. */
  resolved: boolean;
  created_at: string;
}

export class ClarificationActionError extends Error {}

/** AC3: the full clarification exchange for this event, in chronological order. */
export async function fetchClarifications(eventId: number): Promise<ClarificationMessage[]> {
  const res = await fetch(`${apiBase}/${eventId}/clarifications`, { headers: await authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load clarifications");
  const body = await res.json();
  return body.clarifications as ClarificationMessage[];
}

/** The popup's "+": coordinator asks a follow-up question while clarification is outstanding. */
export async function addClarificationQuestion(eventId: number, message: string): Promise<ClarificationMessage> {
  const res = await fetch(`${apiBase}/${eventId}/clarifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ message }),
  });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new ClarificationActionError(body.error ?? "Failed to add question");
  return body.clarification as ClarificationMessage;
}

/** Either party replies within a question's thread. */
export async function replyToClarification(
  eventId: number,
  questionId: number,
  message: string,
): Promise<ClarificationMessage> {
  const res = await fetch(`${apiBase}/${eventId}/clarifications/${questionId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ message }),
  });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new ClarificationActionError(body.error ?? "Failed to add reply");
  return body.clarification as ClarificationMessage;
}

/** Coordinator marks a question resolved — once every question on the event is, /approve unblocks. */
export async function resolveClarificationQuestion(eventId: number, questionId: number): Promise<ClarificationMessage> {
  const res = await fetch(`${apiBase}/${eventId}/clarifications/${questionId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
  });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new ClarificationActionError(body.error ?? "Failed to resolve question");
  return body.clarification as ClarificationMessage;
}
