import { signInternalToken } from "./internalAuth.js";

/**
 * Resolves a role group (e.g. `coordinator_lead`) to user ids, for a
 * broker message's `recipients.roles` (RabbitMQ.md section 2). There's no
 * end-user bearer token on a queue message, so this calls user-service
 * with a signed internal token instead of forwarding a caller's own.
 *
 * A failed lookup throws rather than returning []: [] means "nobody holds
 * this role", which the consumer acks, losing the message for good. A throw
 * nacks it to the DLQ, where it can be seen and replayed.
 */

function userServiceUrl(): string {
  return process.env.USER_SERVICE_URL ?? `http://localhost:${process.env.USER_SERVICE_PORT ?? 4002}`;
}

export async function resolveRoleUserIds(role: string): Promise<string[]> {
  const res = await fetch(`${userServiceUrl()}/api/users?role=${encodeURIComponent(role)}`, {
    headers: { "X-Internal-Auth": signInternalToken("notification-service") },
  });
  if (!res.ok) throw new Error(`user-service returned ${res.status} resolving role "${role}"`);

  const body = (await res.json()) as { users?: { id: string }[] };
  return (body.users ?? []).map((u) => u.id);
}
