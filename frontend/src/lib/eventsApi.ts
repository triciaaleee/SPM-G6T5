import { supabase } from "./supabase";

export interface EventSummary {
  id: string;
  status: string;
  submitted_details: Record<string, unknown>;
  coordinator_id: string | null;
  review_outcome: string | null;
  created_at: string;
}

const apiBase = import.meta.env.VITE_EVENTS_API_URL as string;

async function authHeader(): Promise<HeadersInit> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function fetchMyEvents(): Promise<EventSummary[]> {
  const res = await fetch(apiBase, { headers: await authHeader() });
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

  const body = await res.json();

  if (res.status === 400) {
    throw new ValidationError(body.fields ?? {});
  }
  if (!res.ok) {
    throw new Error(body.error ?? "Failed to submit event request");
  }

  return body.event as EventSummary;
}

export async function fetchEventById(id: string): Promise<EventSummary> {
  const res = await fetch(`${apiBase}/${id}`, { headers: await authHeader() });
  if (res.status === 403) {
    throw new AccessDeniedError("You don't have access to this event");
  }
  if (!res.ok) throw new Error("Failed to load event");
  const body = await res.json();
  return body.event as EventSummary;
}
