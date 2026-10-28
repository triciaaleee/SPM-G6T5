/**
 * Shared seeding for the real-DB integration tests. Everything is created
 * under an id/name prefix ("ZINT-") that can never collide with a real
 * generate_user_id()-issued id or a real venue, and removed by `teardown`
 * in afterAll regardless of outcome. venues.staff_id references users, so
 * the throwaway staff row goes in first and out last; venue_unavailability
 * rows cascade with their venue.
 */
import "../../lib/env.js";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

// Files run in parallel workers, so the clock alone can repeat; the random tail keeps two files' rows and teardowns apart.
export const RUN = `${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
export const STAFF_ID = `ZINT-VEN-${RUN}`;
export const COORD_ID = `ZINT-COORD-${RUN}`;

export const venueBody = (overrides: Record<string, unknown> = {}) => ({
  name: `ZINT Venue ${RUN}`,
  location: "ZINT Test Campus",
  description: "Integration test venue",
  capacity: 80,
  setupMinutes: 15,
  turnaroundMinutes: 30,
  openingTime: "08:00",
  closingTime: "22:00",
  accessibility: ["Wheelchair accessible"],
  layouts: ["Theatre"],
  facilities: ["Projector"],
  ...overrides,
});

export async function seedUsers(): Promise<void> {
  const rows = [
    { id: STAFF_ID, name: "ZINT Venue Staff", email: `zint-staff-${RUN}@example.com`, role: "venue_staff" },
    { id: COORD_ID, name: "ZINT Coordinator", email: `zint-coord-${RUN}@example.com`, role: "coordinator" },
  ].map((u) => ({ ...u, password_hash: `unused-${randomUUID()}` }));
  const { error } = await supabaseAdmin.from("users").insert(rows);
  if (error) throw new Error(`Failed to seed integration users: ${error.message}`);
}

/** Deletes every venue the throwaway staff user looks after, then the users. */
export async function teardown(): Promise<void> {
  await supabaseAdmin.from("venues").delete().eq("staff_id", STAFF_ID);
  await supabaseAdmin.from("users").delete().in("id", [STAFF_ID, COORD_ID]);
}
