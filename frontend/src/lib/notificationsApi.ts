import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

/** E7-1: one in-app notification, from notification-service. */
export interface AppNotification {
  id: number;
  type: string;
  title: string;
  body: string;
  /** In-app path to open, e.g. "/events/7". */
  link: string | null;
  read: boolean;
  /** ISO timestamp. */
  createdAt: string;
}

export interface NotificationFeed {
  notifications: AppNotification[];
  unreadCount: number;
}

const apiBase =
  (import.meta.env.VITE_NOTIFICATIONS_API_URL as string | undefined) ?? "http://localhost:4004/api/notifications";

export async function fetchNotifications(limit = 5): Promise<NotificationFeed> {
  const res = await fetch(`${apiBase}?limit=${limit}`, { headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load notifications");
  return (await res.json()) as NotificationFeed;
}

export async function markNotificationsRead(): Promise<void> {
  const res = await fetch(`${apiBase}/read`, { method: "POST", headers: authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to mark notifications as read");
}
