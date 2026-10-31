/**
 * Shared seeding for the real-DB integration tests. registrations references
 * users and events, so a throwaway organiser, attendees and events go in
 * first, under a "ZINT-REG-" id prefix that can never collide with a real
 * generate_user_id()-issued id. `teardown` removes them in afterAll regardless
 * of outcome; registrations cascade with their event.
 */
import "../../lib/env.js";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

// Files run in parallel workers, so the clock alone can repeat; the random tail keeps two files' rows and teardowns apart.
export const RUN = `${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
const PREFIX = `ZINT-REG-${RUN}`;
export const ORGANISER = `${PREFIX}-ORG`;

const madeUsers: string[] = [ORGANISER];

export const attendeeId = (n: number) => `${PREFIX}-ATT-${n}`;

export const auth = (id: string, role = "attendee") =>
  `Bearer ${jwt.sign({ sub: id, role }, process.env.JWT_SECRET!, { expiresIn: "1h" })}`;

function userRow(id: string, role: string) {
  return { id, name: `ZINT ${role}`, email: `${id.toLowerCase()}@example.com`, role, password_hash: `unused-${randomUUID()}` };
}

export async function seedUsers(attendees: number): Promise<void> {
  const ids = Array.from({ length: attendees }, (_, i) => attendeeId(i + 1));
  madeUsers.push(...ids);
  const rows = [userRow(ORGANISER, "organiser"), ...ids.map((id) => userRow(id, "attendee"))];
  const { error } = await supabaseAdmin.from("users").insert(rows);
  if (error) throw new Error(`Failed to seed users: ${error.message}`);
}

export async function seedEvent(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("events")
    .insert({ organiser_id: ORGANISER, status: "Confirmed", submitted_details: { eventName: `ZINT Event ${RUN}` } })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Failed to seed event: ${error?.message}`);
  return data.id;
}

export async function teardown(): Promise<void> {
  const events = await supabaseAdmin.from("events").delete().eq("organiser_id", ORGANISER);
  const users = await supabaseAdmin.from("users").delete().in("id", madeUsers);
  if (events.error || users.error) throw new Error(`Failed to clean up: ${events.error?.message ?? users.error?.message}`);
}
