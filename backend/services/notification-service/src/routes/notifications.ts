import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * In-app notifications (E7-1). Anyone signed in reads and clears their own
 * feed; other services create notifications here over REST, forwarding the
 * token of the user whose action triggered them (e.g. venue-service, when
 * venue staff block out a booked venue — E4-3).
 */
export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

/**
 * Roles whose actions can notify someone else. Attendees never trigger a
 * notification for another user.
 */
const SENDER_ROLES = new Set(["venue_staff", "coordinator", "organiser", "technical_support"]);

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;
const MAX_BATCH = 100;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 1000;
const TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

interface NotificationRow {
  id: number;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

function toNotification(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.read_at !== null,
    createdAt: row.created_at,
  };
}

/** The caller's latest notifications (newest first) and how many are unread. */
notificationsRouter.get("/", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;
  const userId = req.user!.id;

  const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : DEFAULT_LIMIT;
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  const [list, unread] = await Promise.all([
    supabase
      .from("notifications")
      .select("id, type, title, body, link, read_at, created_at")
      .eq("recipient_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("recipient_id", userId)
      .is("read_at", null),
  ]);

  if (list.error || unread.error) {
    res.status(500).json({ error: "Failed to load notifications" });
    return;
  }

  res.json({
    notifications: ((list.data ?? []) as NotificationRow[]).map(toNotification),
    unreadCount: unread.count ?? 0,
  });
});

/** Marks all of the caller's unread notifications as read. */
notificationsRouter.post("/read", async (req: AuthedRequest, res) => {
  const { error } = await req
    .supabase!.from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("recipient_id", req.user!.id)
    .is("read_at", null);

  if (error) {
    res.status(500).json({ error: "Failed to mark notifications as read" });
    return;
  }
  res.status(204).end();
});

/** Creates a batch of notifications for other users. Body: { notifications: [...] }. */
notificationsRouter.post("/", async (req: AuthedRequest, res) => {
  if (!SENDER_ROLES.has(req.user!.role)) {
    res.status(403).json({ error: "Your role can't send notifications" });
    return;
  }

  const raw = (req.body as { notifications?: unknown })?.notifications;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BATCH) {
    res.status(400).json({ error: `notifications must be a list of 1–${MAX_BATCH} items` });
    return;
  }

  const rows = [];
  for (const [index, item] of raw.entries()) {
    const n = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const text = (key: string) => (typeof n[key] === "string" ? (n[key] as string).trim() : "");
    const recipientId = text("recipientId");
    const type = text("type");
    const title = text("title");
    const body = text("body");
    const link = text("link");

    const problem =
      !recipientId ? "recipientId is required"
      : !TYPE_PATTERN.test(type) ? "type must be a snake_case identifier"
      : !title || title.length > MAX_TITLE_LENGTH ? `title is required (at most ${MAX_TITLE_LENGTH} characters)`
      : !body || body.length > MAX_BODY_LENGTH ? `body is required (at most ${MAX_BODY_LENGTH} characters)`
      // In-app paths only — a notification must never link off-site.
      : link && (!link.startsWith("/") || link.startsWith("//")) ? "link must be an in-app path"
      : null;

    if (problem) {
      res.status(400).json({ error: `Notification ${index + 1}: ${problem}` });
      return;
    }
    rows.push({ recipient_id: recipientId, type, title, body, link: link || null });
  }

  const { error } = await req.supabase!.from("notifications").insert(rows);
  if (error) {
    res.status(500).json({ error: "Failed to create notifications" });
    return;
  }

  res.status(201).json({ created: rows.length });
});
