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

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as AuthUser) : null;
}

function storeSession(token: string, user: AuthUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

async function parseErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${authBase}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    throw new Error(await parseErrorMessage(res, "Login failed"));
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
    throw new Error(await parseErrorMessage(res, "Signup failed"));
  }

  const body = await res.json();
  storeSession(body.token, body.user);
  return body.user as AuthUser;
}
