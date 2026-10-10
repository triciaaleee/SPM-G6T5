import { authHeader, redirectIfUnauthenticated } from "./eventsApi";
import type { RegistrationStatus } from "./registrationStatus";

/** The attendee-facing fields of an event, as registration-service returns them. */
export interface RegisteredEventInfo {
  name: string | null;
  description: string | null;
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  venues: string[];
  /** The organiser's accessibility note; null when there is none. */
  accessibility: string | null;
}

export interface MyRegistration {
  registrationId: number;
  eventId: number;
  userId: string;
  status: RegistrationStatus;
  createdAt: string;
  additionalInfo: Record<string, unknown> | null;
  /** Null when the event is no longer visible to attendees. */
  event: RegisteredEventInfo | null;
}

/** What an attendee sees when they open one event: attendee-facing fields and their own status only. */
export interface AttendeeEventView {
  id: number;
  name: string | null;
  description: string | null;
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  venues: string[];
  accessibility: string | null;
  /** Null when the attendee has no registration for this event. */
  registrationStatus: RegistrationStatus | null;
  open: boolean;
}

/** The backend refused the event: the attendee isn't registered and it isn't open (or it doesn't exist). */
export class AccessDeniedError extends Error {}

/** A registration action the backend refused; `code` says why (e.g. `already_withdrawn`). */
export class RegistrationRequestError extends Error {
  status: number;
  code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const apiBase =
  (import.meta.env.VITE_REGISTRATION_API_URL as string | undefined) ?? "http://localhost:4006/api/registrations";

/** The signed-in attendee's own registrations, newest first. */
export async function fetchMyRegistrations(userId: string): Promise<MyRegistration[]> {
  const res = await fetch(`${apiBase}/user/${encodeURIComponent(userId)}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load your events");
  const body = await res.json();
  return body.registrations as MyRegistration[];
}

/** The attendee-facing view of one event. Throws `AccessDeniedError` when the backend refuses it. */
export async function fetchAttendeeEventView(eventId: number | string): Promise<AttendeeEventView> {
  const res = await fetch(`${apiBase}/event/${encodeURIComponent(String(eventId))}/view`, {
    headers: authHeader(),
  });
  await redirectIfUnauthenticated(res);
  if (res.status === 403) throw new AccessDeniedError("You don't have access to this event");
  if (!res.ok) throw new Error("Failed to load the event");
  const body = await res.json();
  return body.event as AttendeeEventView;
}

/** Give up the attendee's place. The registration is kept as Withdrawn. */
export async function withdraw(eventId: number | string): Promise<void> {
  const res = await fetch(`${apiBase}/event/${encodeURIComponent(String(eventId))}/withdraw`, {
    method: "PATCH",
    headers: authHeader(),
  });
  await redirectIfUnauthenticated(res);
  if (res.ok) return;

  let body: { error?: string; code?: string } = {};
  try {
    body = await res.json();
  } catch {
    // No JSON body: fall back to the generic message below.
  }
  throw new RegistrationRequestError(body.error ?? "Failed to withdraw", res.status, body.code ?? null);
}
