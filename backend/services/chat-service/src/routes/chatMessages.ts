import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchEvent, fetchEventsForRole, type EventForChat } from "../lib/eventsClient.js";
import { sendNotification } from "../lib/notificationsClient.js";
import { validateMessageBody } from "../lib/validateChatMessage.js";

/**
 * E2-15: a live chat between an Organiser and their event's assigned
 * coordinator. One thread per event — chat-service owns only
 * chat_messages (migration 0024); the event itself, and who's assigned to
 * it, is read live through events-service, never queried directly.
 */
export const chatRouter = Router();

chatRouter.use(requireAuth);

// Only an Organiser raises questions and only a Coordinator answers them,
// per the story — no other role has a chat.
chatRouter.use((req: AuthedRequest, res, next) => {
  if (req.user?.role !== "organiser" && req.user?.role !== "coordinator") {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  next();
});

/**
 * E2-15: chat only exists while there's active back-and-forth to have —
 * once the coordinator is actually planning, through confirmation. Not
 * available before that (Unassigned, Requested, Clarification Requested —
 * clarification already has its own dedicated Q&A thread), during Safety
 * Review, or once closed (Rejected, Completed, Cancelled). An event that
 * cycles out of these two (e.g. Planning -> Safety Review) and back keeps
 * its existing messages; the thread is just hidden while it's outside them.
 */
const CHAT_ENABLED_STATUSES = new Set(["Planning", "Confirmed"]);

interface MessageRow {
  id: number;
  event_id: number;
  sender_id: string;
  sender_role: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

const MESSAGE_COLUMNS = "id, event_id, sender_id, sender_role, body, read_at, created_at";

function toMessage(row: MessageRow, viewerId: string) {
  return {
    id: row.id,
    senderId: row.sender_id,
    senderRole: row.sender_role,
    body: row.body,
    createdAt: row.created_at,
    mine: row.sender_id === viewerId,
  };
}

function eventDisplayName(event: EventForChat, fallbackId: number): string {
  return (event.submitted_details?.name as string | undefined) || `Event #${fallbackId}`;
}

type AccessResult = { ok: true; event: EventForChat } | { ok: false; status: number; error: string };

/**
 * Loads the event and checks this caller is specifically the owning
 * Organiser or the ASSIGNED coordinator — stricter than events-service's
 * own "owning organiser or any coordinator may view" rule: a chat is
 * private between the two parties on an event, not visible to every
 * coordinator the way the event's basic info is.
 */
async function checkAccess(
  eventId: number,
  user: { id: string; role: string },
  authorization: string,
): Promise<AccessResult> {
  const result = await fetchEvent(eventId, authorization);
  if (result.status === "not_found") return { ok: false, status: 404, error: "Event not found" };
  if (result.status === "error") return { ok: false, status: 502, error: "Failed to load the event" };

  const { event } = result;
  if (user.role === "organiser" && event.organiser_id !== user.id) {
    return { ok: false, status: 403, error: "Access denied" };
  }
  if (user.role === "coordinator" && event.coordinator_id !== user.id) {
    return { ok: false, status: 403, error: "Access denied" };
  }
  // An Organiser raises questions "to the coordinator" — one must exist to
  // receive them. The inbox hides this event entirely until one is
  // assigned; the backend enforces the same rule so a direct request
  // can't bypass it.
  if (user.role === "organiser" && !event.coordinator_id) {
    return { ok: false, status: 409, error: "No coordinator has been assigned to this event yet." };
  }
  if (!CHAT_ENABLED_STATUSES.has(event.status)) {
    return { ok: false, status: 409, error: "Chat isn't available for this event right now." };
  }

  return { ok: true, event };
}

/**
 * AC1: the inbox — every event this caller has a chat for right now
 * (Organiser: their own events with a coordinator assigned; Coordinator:
 * events assigned to them; both narrowed to CHAT_ENABLED_STATUSES), each
 * with the other party's name, the latest message (if any) and how many
 * are unread. Drives the drawer's list view on any page that isn't already
 * bound to one event.
 */
chatRouter.get("/threads", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventsResult = await fetchEventsForRole(req.headers.authorization!);
  if (eventsResult.status === "error") {
    res.status(502).json({ error: "Failed to load events" });
    return;
  }

  const eligible = eventsResult.events.filter(
    (e) =>
      CHAT_ENABLED_STATUSES.has(e.status) &&
      (user.role === "organiser" ? e.coordinatorId !== null : e.coordinatorId === user.id),
  );

  if (eligible.length === 0) {
    res.json({ threads: [] });
    return;
  }

  const eventIds = eligible.map((e) => e.id);
  const { data: messageRows, error: messagesError } = await supabase
    .from("chat_messages")
    .select(MESSAGE_COLUMNS)
    .in("event_id", eventIds)
    .order("created_at", { ascending: false });

  if (messagesError) {
    res.status(500).json({ error: "Failed to load chat messages" });
    return;
  }

  const rows = (messageRows ?? []) as MessageRow[];
  const lastByEvent = new Map<number, MessageRow>();
  const unreadByEvent = new Map<number, number>();
  for (const row of rows) {
    if (!lastByEvent.has(row.event_id)) lastByEvent.set(row.event_id, row);
    if (row.sender_id !== user.id && row.read_at === null) {
      unreadByEvent.set(row.event_id, (unreadByEvent.get(row.event_id) ?? 0) + 1);
    }
  }

  const threads = eligible
    .map((e) => {
      const last = lastByEvent.get(e.id) ?? null;
      return {
        eventId: e.id,
        eventName: e.name || `Event #${e.id}`,
        status: e.status,
        canSend: true,
        otherParty: user.role === "organiser" ? e.coordinatorName : e.organiserName,
        lastMessage: last ? { body: last.body, senderId: last.sender_id, createdAt: last.created_at } : null,
        unreadCount: unreadByEvent.get(e.id) ?? 0,
        updatedAt: last?.created_at ?? e.createdAt,
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  res.json({ threads });
});

/**
 * AC1: one event's full message history. checkAccess already enforces
 * CHAT_ENABLED_STATUSES, so reaching this point means the event is
 * Planning or Confirmed and `canSend` is always true — kept on the
 * response so the frontend doesn't need special-case logic either way.
 */
chatRouter.get("/:eventId/messages", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Number(req.params.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    res.status(400).json({ error: "A valid event id is required" });
    return;
  }

  const access = await checkAccess(eventId, user, req.headers.authorization!);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const { data, error } = await supabase
    .from("chat_messages")
    .select(MESSAGE_COLUMNS)
    .eq("event_id", eventId)
    .order("created_at", { ascending: true });

  if (error) {
    res.status(500).json({ error: "Failed to load messages" });
    return;
  }

  const rows = (data ?? []) as MessageRow[];
  const unreadCount = rows.filter((row) => row.sender_id !== user.id && row.read_at === null).length;

  res.json({
    event: {
      id: access.event.id,
      name: eventDisplayName(access.event, eventId),
      status: access.event.status,
      canSend: true,
    },
    messages: rows.map((row) => toMessage(row, user.id)),
    unreadCount,
  });
});

/** Opening a thread counts as reading it — same stance as notification-service's read flow. */
chatRouter.post("/:eventId/read", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Number(req.params.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    res.status(400).json({ error: "A valid event id is required" });
    return;
  }

  const access = await checkAccess(eventId, user, req.headers.authorization!);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const { error } = await supabase
    .from("chat_messages")
    .update({ read_at: new Date().toISOString() })
    .eq("event_id", eventId)
    .neq("sender_id", user.id)
    .is("read_at", null);

  if (error) {
    res.status(500).json({ error: "Failed to mark messages read" });
    return;
  }

  res.status(204).send();
});

/**
 * AC1: send a message — checkAccess already enforces CHAT_ENABLED_STATUSES,
 * so there's nothing further to check here. The other party is notified
 * (best effort, same stance as every other service's notification calls: a
 * failure here doesn't undo the message).
 */
chatRouter.post("/:eventId/messages", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Number(req.params.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    res.status(400).json({ error: "A valid event id is required" });
    return;
  }

  const access = await checkAccess(eventId, user, req.headers.authorization!);
  if (!access.ok) {
    res.status(access.status).json({ error: access.error });
    return;
  }

  const bodyResult = validateMessageBody((req.body ?? {}).body);
  if (!bodyResult.valid) {
    res.status(400).json({ error: bodyResult.error });
    return;
  }

  const { data: row, error } = await supabase
    .from("chat_messages")
    .insert({ event_id: eventId, sender_id: user.id, sender_role: user.role, body: bodyResult.value })
    .select(MESSAGE_COLUMNS)
    .single();

  if (error || !row) {
    res.status(500).json({ error: "Failed to send the message" });
    return;
  }

  const recipientId = user.role === "organiser" ? access.event.coordinator_id! : access.event.organiser_id;
  const eventName = eventDisplayName(access.event, eventId);
  const preview = bodyResult.value!.length > 140 ? `${bodyResult.value!.slice(0, 140)}…` : bodyResult.value!;

  const notified = await sendNotification(
    {
      recipientId,
      type: "chat_message",
      title: `New message about ${eventName}`,
      body: preview,
      link: `/events/${eventId}`,
    },
    req.headers.authorization!,
  );

  res.status(201).json({ message: toMessage(row as MessageRow, user.id), notified });
});
