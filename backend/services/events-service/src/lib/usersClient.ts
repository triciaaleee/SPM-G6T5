/**
 * Reads the coordinator list from user-service, which owns the users
 * table (AGENTS.md §1). The caller's own bearer token is forwarded, so
 * user-service applies its own role check: only the Event Coordinator Lead
 * may list coordinators.
 */

export interface Coordinator {
  id: string;
  name: string;
}

export type FetchCoordinatorsResult = { status: "ok"; coordinators: Coordinator[] } | { status: "error" };

function userServiceUrl(): string {
  return process.env.USER_SERVICE_URL ?? `http://localhost:${process.env.USER_SERVICE_PORT ?? 4002}`;
}

/**
 * Every active Event Coordinator. There is no active/inactive flag on
 * users, so every account with the coordinator role counts as active
 * (the same assumption E2-6 made).
 */
export async function fetchCoordinators(authorization: string): Promise<FetchCoordinatorsResult> {
  try {
    const res = await fetch(`${userServiceUrl()}/api/users?role=coordinator`, {
      headers: { Authorization: authorization },
    });
    if (!res.ok) return { status: "error" };
    const body = (await res.json()) as { users?: Coordinator[] };
    return { status: "ok", coordinators: body.users ?? [] };
  } catch {
    return { status: "error" };
  }
}
