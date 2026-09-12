const TOKEN_KEY = "auth_token";
const USER_KEY = "auth_user";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

const apiBase = import.meta.env.VITE_EVENTS_API_URL as string;
const authBase = apiBase.replace(/\/events$/, "/auth");

/**
 * Thrown when the backend reports the account is locked (HTTP 423, E1-2
 * AC3). Separate from a plain credential failure so the login form can
 * present it as a wait-and-retry state rather than "try again now".
 */
export class LockedOutError extends Error {
  retryAfterMinutes: number;
  constructor(message: string, retryAfterMinutes: number) {
    super(message);
    this.retryAfterMinutes = retryAfterMinutes;
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    // Corrupt or hand-edited storage — treat as no session rather than
    // letting a parse error escape into every component that reads it.
    clearSession();
    return null;
  }
}

function storeSession(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** AC4: ending the session is just discarding the token — it's stateless. */
export function logout(): void {
  clearSession();
}

/**
 * Reads `exp` out of the JWT payload without verifying the signature.
 * That's fine for this purpose: the check exists so an obviously dead
 * session sends the user to the login page instead of into a screen that
 * will 401 on every request. The backend still verifies the signature on
 * every call and remains the only thing standing between a forged token
 * and the data.
 */
function tokenExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * AC5: the router guard calls this before every protected route. An
 * expired token is cleared here so the user isn't left in a half-logged-in
 * state where the header says their name but nothing loads.
 */
export function isAuthenticated(): boolean {
  const token = getToken();
  if (!token) return false;

  const expiresAt = tokenExpiryMs(token);
  if (expiresAt !== null && expiresAt <= Date.now()) {
    clearSession();
    return false;
  }
  return true;
}

/**
 * AC1: where a user lands after signing in. Every role currently resolves
 * to the events list — coordinators and organisers already see different
 * data there, since the backend scopes the query by role — but routing
 * through this map means adding a dedicated screen for, say, attendees is
 * a one-line change here rather than an edit to every call site.
 */
const LANDING_ROUTE_BY_ROLE: Record<string, string> = {
  organiser: "events-list",
  coordinator: "events-list",
  attendee: "events-list",
  venue_staff: "events-list",
  technical_support: "events-list",
};

export function landingRouteForRole(role: string | undefined | null): string {
  return (role && LANDING_ROUTE_BY_ROLE[role]) || "events-list";
}

/** Human-readable role, for the header. `venue_staff` → `Venue staff`. */
export function formatRole(role: string): string {
  const words = role.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function readErrorBody(res: Response): Promise<{ error?: string; retryAfterMinutes?: number }> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${authBase}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    if (res.status === 423) {
      throw new LockedOutError(
        body.error ?? "This account is temporarily locked.",
        body.retryAfterMinutes ?? 15,
      );
    }
    // AC2: whatever the backend sends here is deliberately generic — pass
    // it through rather than trying to be more specific about the cause.
    throw new Error(body.error ?? "Login failed");
  }

  const body = await res.json();
  storeSession(body.token, body.user);
  return body.user as AuthUser;
}

export async function signup(name: string, email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${authBase}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password }),
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    throw new Error(body.error ?? "Signup failed");
  }

  const body = await res.json();
  storeSession(body.token, body.user);
  return body.user as AuthUser;
}
