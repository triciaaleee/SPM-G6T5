/**
 * Creates in-app notifications through notification-service's REST API —
 * events-service never writes the notifications table itself. The caller's
 * own bearer token is forwarded, so notification-service knows who sent
 * them. Duplicated from venue-service rather than imported (AGENTS.md §1).
 */

export interface NewNotification {
  recipientId: string;
  type: string;
  title: string;
  body: string;
  /** An in-app path, e.g. "/events/7". */
  link?: string;
}

/** notification-service refuses a body longer than this (its MAX_BODY_LENGTH). */
export const MAX_NOTIFICATION_BODY_LENGTH = 1000;

/**
 * Cuts free text (e.g. a reason the user typed) so the whole body fits
 * notification-service's limit — an over-long body would be refused and
 * the notification lost. The full text stays wherever it was recorded.
 */
export function fitNotificationBody(body: string): string {
  return body.length <= MAX_NOTIFICATION_BODY_LENGTH ? body : `${body.slice(0, MAX_NOTIFICATION_BODY_LENGTH - 1)}…`;
}

function notificationServiceUrl(): string {
  return (
    process.env.NOTIFICATION_SERVICE_URL ?? `http://localhost:${process.env.NOTIFICATION_SERVICE_PORT ?? 4004}`
  );
}

/** Resolves true when every notification was accepted. */
export async function sendNotifications(notifications: NewNotification[], authorization: string): Promise<boolean> {
  if (notifications.length === 0) return true;

  try {
    const res = await fetch(`${notificationServiceUrl()}/api/notifications`, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ notifications }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
