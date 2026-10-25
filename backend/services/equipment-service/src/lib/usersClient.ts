/**
 * Resolves user ids to display names via user-service's /api/users/names
 * (user-service owns the users table, AGENTS.md §1). Used only by
 * GET /equipment-requests/event/:eventId, to show Technical Support which
 * coordinator raised a request — a deliberate, narrow exception to that
 * route otherwise showing nothing about the event's people (E5-1 AC1).
 * The caller's own bearer token is forwarded, same as events-service's
 * usersClient.ts; user-service's own role check (organiser, coordinator or
 * technical_support) is what actually gates this.
 */

export interface UserName {
  id: string;
  name: string;
}

function userServiceUrl(): string {
  return process.env.USER_SERVICE_URL ?? `http://localhost:${process.env.USER_SERVICE_PORT ?? 4002}`;
}

/**
 * Best-effort: a name is a display nicety, never something worth failing
 * the page over. Any error, or an empty `ids`, resolves to an empty map —
 * callers then fall back to showing the id on its own.
 */
export async function fetchUserNames(ids: string[], authorization: string): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  try {
    const res = await fetch(`${userServiceUrl()}/api/users/names?ids=${encodeURIComponent(ids.join(","))}`, {
      headers: { Authorization: authorization },
    });
    if (!res.ok) return new Map();
    const body = (await res.json()) as { users?: UserName[] };
    return new Map((body.users ?? []).map((u) => [u.id, u.name]));
  } catch {
    return new Map();
  }
}
