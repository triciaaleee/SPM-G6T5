import { loadEnv } from "vite";

/**
 * The same VITE_* API base URLs the app itself is built with — read through
 * Vite's own loadEnv so there is exactly one .env file and one source of
 * truth. Pointing this suite at a different stack (CI's throwaway services,
 * a second local stack on different ports) is then just an env change, not
 * a code change.
 */
const env = loadEnv("", process.cwd(), "VITE_");

function required(key: string): string {
  const value = env[key] ?? process.env[key];
  if (!value) throw new Error(`Missing ${key} — copy frontend/.env.example to frontend/.env and fill it in.`);
  return value;
}

export const AUTH_URL = required("VITE_AUTH_API_URL");
export const USERS_URL = required("VITE_USERS_API_URL");
export const EVENTS_URL = required("VITE_EVENTS_API_URL");
export const VENUES_URL = required("VITE_VENUES_API_URL");
export const NOTIFICATIONS_URL = required("VITE_NOTIFICATIONS_API_URL");
export const EQUIPMENT_URL = required("VITE_EQUIPMENT_API_URL");
/** Not a separate VITE_* var in the app — equipment-service mounts both routers, so this is derived once, here. */
export const EQUIPMENT_CATALOG_URL = EQUIPMENT_URL.replace("/equipment-requests", "/equipment-catalog");
export const REGISTRATION_URL = required("VITE_REGISTRATION_API_URL");
export const CHAT_URL = required("VITE_CHAT_API_URL");

/** Every seeded account (supabase/seed.sql) shares this password. */
export const SEEDED_PASSWORD = "password123";
