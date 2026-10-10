import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

/** E2-15: one message in an event's thread. */
export interface ChatMessage {
  id: number;
  senderId: string;
  senderRole: "organiser" | "coordinator";
  body: string;
  createdAt: string;
  /** Sent by the current viewer — drives which side of the thread a bubble renders on. */
  mine: boolean;
}

export interface ChatThreadEvent {
  id: number;
  name: string;
  status: string;
  /** False once the event is closed (Rejected/Completed/Cancelled) — history stays visible, sending doesn't. */
  canSend: boolean;
}

export interface ChatThreadHistory {
  event: ChatThreadEvent;
  messages: ChatMessage[];
  unreadCount: number;
}

/** E2-15 AC1: one row in the drawer's inbox — an event this viewer has a chat for. */
export interface ChatThreadSummary {
  eventId: number;
  eventName: string;
  status: string;
  canSend: boolean;
  /** The other party's name — the coordinator's, for an organiser; the organiser's, for a coordinator. */
  otherParty: string | null;
  lastMessage: { body: string; senderId: string; createdAt: string } | null;
  unreadCount: number;
}

const apiBase = (import.meta.env.VITE_CHAT_API_URL as string | undefined) ?? "http://localhost:4006/api/chat";

export class ChatError extends Error {}

/** The drawer's inbox: every event this viewer has a chat for, newest activity first. */
export async function fetchChatThreads(): Promise<ChatThreadSummary[]> {
  const res = await fetch(`${apiBase}/threads`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new ChatError("Failed to load your conversations");
  const body = await res.json();
  return body.threads as ChatThreadSummary[];
}

/** One event's full message history. */
export async function fetchChatMessages(eventId: number): Promise<ChatThreadHistory> {
  const res = await fetch(`${apiBase}/${eventId}/messages`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  const body = await res.json();
  if (!res.ok) throw new ChatError(body.error ?? "Failed to load this conversation");
  return body as ChatThreadHistory;
}

/** Marks every message the other party sent on this thread as read. */
export async function markChatThreadRead(eventId: number): Promise<void> {
  const res = await fetch(`${apiBase}/${eventId}/read`, { method: "POST", headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok && res.status !== 204) {
    // Best effort — a failed mark-as-read doesn't block using the thread.
  }
}

/** AC1: send a message on this event's thread; the other party is notified. */
export async function sendChatMessage(eventId: number, body: string): Promise<{ message: ChatMessage; notified: boolean }> {
  const res = await fetch(`${apiBase}/${eventId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify({ body }),
  });
  await redirectIfUnauthenticated(res);
  const responseBody = await res.json();
  if (!res.ok) throw new ChatError(responseBody.error ?? "Failed to send your message");
  return responseBody as { message: ChatMessage; notified: boolean };
}
