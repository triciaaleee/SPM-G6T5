import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

/** E7-1: one in-app notification, from notification-service. */
export interface AppNotification {
  id: number;
  type: string;
  title: string;
  body: string;
  /** In-app path to open, e.g. "/events/7". */
  link: string | null;
  /** Which event this is about, if any (notification-service's event_id). */
  eventId: number | null;
  read: boolean;
  /** ISO timestamp. */
  createdAt: string;
}

export interface NotificationFeed {
  notifications: AppNotification[];
  /** Only present on the first page (no `before`); the bell polls for the live count separately. */
  unreadCount?: number;
  /** Last row's id, to pass back as `before` for the next page; null when there's no more. */
  nextCursor: number | null;
}

const apiBase =
  (import.meta.env.VITE_NOTIFICATIONS_API_URL as string | undefined) ?? "http://localhost:4004/api/notifications";

export async function fetchNotifications(options: { limit?: number; before?: number } = {}): Promise<NotificationFeed> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 5));
  if (options.before !== undefined) params.set("before", String(options.before));

  const res = await fetch(`${apiBase}?${params}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load notifications");
  return (await res.json()) as NotificationFeed;
}

export async function markNotificationsRead(): Promise<void> {
  const res = await fetch(`${apiBase}/read`, { method: "POST", headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to mark notifications as read");
}

export async function markNotificationRead(id: number): Promise<void> {
  const res = await fetch(`${apiBase}/${id}/read`, { method: "POST", headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to mark notification as read");
}
