/**
 * Display names for a roster, from user-service — registration-service
 * never reads the users table. Best-effort: a roster is still useful with
 * user ids alone, so a failure returns an empty map rather than an error.
 */

function userServiceUrl(): string {
  return process.env.USER_SERVICE_URL ?? `http://localhost:${process.env.USER_SERVICE_PORT ?? 4002}`;
}

export async function fetchUserNames(userIds: string[], authorization: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0) return names;

  try {
    const res = await fetch(`${userServiceUrl()}/api/users/names?ids=${userIds.map(encodeURIComponent).join(",")}`, {
      headers: { Authorization: authorization },
    });
    if (!res.ok) return names;

    const body = (await res.json()) as { users?: { id: string; name: string }[] };
    for (const user of body.users ?? []) names.set(user.id, user.name);
  } catch {
    // Roster still renders without names.
  }
  return names;
}
