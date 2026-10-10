import { authHeader, redirectIfUnauthenticated } from "./eventsApi";

export interface CoordinatorOption {
  id: string;
  name: string;
}

// user-service's /api/users. Falls back to the auth URL's sibling path so a
// .env written before VITE_USERS_API_URL existed keeps working.
const usersBase =
  (import.meta.env.VITE_USERS_API_URL as string | undefined) ??
  (import.meta.env.VITE_AUTH_API_URL as string).replace(/\/auth\/?$/, "/users");

/**
 * E2-13/E2-12: every active Event Coordinator the Lead can assign or
 * reassign an event to. Empty when none exist (E2-13 AC3).
 */
export async function fetchCoordinators(): Promise<CoordinatorOption[]> {
  const res = await fetch(`${usersBase}?role=coordinator`, { headers: await authHeader() });
  await redirectIfUnauthenticated(res);
  if (!res.ok) throw new Error("Failed to load coordinators");
  const body = await res.json();
  return body.users as CoordinatorOption[];
}
