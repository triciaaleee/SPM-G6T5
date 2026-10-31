import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * In-app notifications (E7-1). Anyone signed in reads and clears their own
 * feed. Notifications are created only by the RabbitMQ consumer
 * (lib/notificationFromMessage.ts), never over REST.
 */
export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

interface NotificationRow {
  id: number;
  type: string;
  title: string;
  body: string;
  link: string | null;
  event_id: number | null;
  actor_id: string | null;
  occurred_at: string | null;
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
    eventId: row.event_id,
    /** Who caused it — set only for broker-delivered notifications (M7/audit trail); null for the direct REST path. */
    actorId: row.actor_id,
    /** When the action actually happened, vs. createdAt (when this row was inserted). Null for the direct REST path. */
    occurredAt: row.occurred_at,
    read: row.read_at !== null,
    createdAt: row.created_at,
  };
}

const SELECT_COLUMNS = "id, type, title, body, link, event_id, actor_id, occurred_at, read_at, created_at";

/**
 * The caller's notifications, newest first. `before` (a notification id)
 * pages back through older ones — rows are ordered `created_at desc, id
 * desc` and `id` is monotonic, so it's a simple, stable cursor. `unreadCount`
 * is only computed on the first page (no `before`): "load more" pages skip
 * it, since the bell already polls for the live count separately.
 */
// Stryker disable next-line StringLiteral: a mounted router's "/" and "" match the same path.
notificationsRouter.get("/", async (req: AuthedRequest, res) => {
  const supabase = req.supabase!;
  const userId = req.user!.id;

  // A missing or repeated parameter reads as NaN, which falls back like any other invalid value.
  const rawLimit = Number(req.query.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

  const rawBefore = Number(req.query.before);
  const before = Number.isSafeInteger(rawBefore) && rawBefore > 0 ? rawBefore : undefined;

  let listQuery = supabase
    .from("notifications")
    .select(SELECT_COLUMNS)
    .eq("recipient_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (before !== undefined) {
    listQuery = listQuery.lt("id", before);
  }

  const [list, unread] = await Promise.all([
    listQuery,
    before === undefined
      ? supabase
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("recipient_id", userId)
          .is("read_at", null)
      : Promise.resolve({ count: null, error: null }),
  ]);

  if (list.error || unread.error) {
    res.status(500).json({ error: "Failed to load notifications" });
    return;
  }

  const rows = (list.data ?? []) as NotificationRow[];
  res.json({
    notifications: rows.map(toNotification),
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
    ...(before === undefined ? { unreadCount: unread.count ?? 0 } : {}),
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

/**
 * Marks a single notification read. Scoped to `recipient_id` so no one can
 * mark another user's notification, and a no-op (still 204) if it's
 * already read or doesn't belong to the caller.
 */
notificationsRouter.post("/:id/read", async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  // Safe integers only: 1e30 is an integer to JavaScript but doesn't fit the bigint column, so Postgres would error.
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "id must be a positive integer" });
    return;
  }

  const { error } = await req
    .supabase!.from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("recipient_id", req.user!.id)
    .is("read_at", null);

  if (error) {
    res.status(500).json({ error: "Failed to mark notification as read" });
    return;
  }
  res.status(204).end();
});
