import path from "node:path";
import { loadEnv } from "vite";

/**
 * Direct database writes, for the few rules that turn on the passing of time
 * (a 72-hour hold lapsing, an event having ended). No test can wait for that
 * and no API lets a client fake it, so these move one of the test's own rows
 * as if time had passed, then the test drives the real services from there.
 *
 * Only ever against a local database: the throwaway Supabase CI builds, or
 * one started with `supabase start`. `timeTravel` is null otherwise, and
 * tests needing it skip — never write past the services to the shared dev
 * database or anything else.
 */
const backendEnv = loadEnv("", path.resolve(process.cwd(), "../backend"), "");
const supabaseUrl = backendEnv.SUPABASE_URL ?? "";
const serviceRoleKey = backendEnv.SUPABASE_SERVICE_ROLE_KEY ?? "";

function isLocal(url: string): boolean {
  try {
    return ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function rest(method: "GET" | "PATCH", pathAndQuery: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${pathAndQuery} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

/** The Singapore calendar date `days` from today (negative for the past) — the services read dates as UTC+8. */
function singaporeDate(days: number): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000 + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const timeTravel =
  supabaseUrl && serviceRoleKey && isLocal(supabaseUrl)
    ? {
        /** Makes an On Hold booking's hold lapse, as if its 72 hours had run out. */
        async expireHold(bookingId: number): Promise<void> {
          await rest("PATCH", `venue_bookings?id=eq.${bookingId}`, {
            hold_expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
          });
        },

        /** Moves an event to yesterday, so it has ended. Its other details are kept. */
        async moveEventToYesterday(eventId: number): Promise<void> {
          const [row] = (await rest("GET", `events?id=eq.${eventId}&select=submitted_details`)) as {
            submitted_details: Record<string, unknown>;
          }[];
          await rest("PATCH", `events?id=eq.${eventId}`, {
            submitted_details: { ...row.submitted_details, proposedDate: singaporeDate(-1) },
          });
        },
      }
    : null;
