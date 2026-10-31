/**
 * Shared seeding for the real-DB integration tests. Everything is created
 * under a name/id prefix ("ZINT") that can never collide with a real
 * generate_user_id()-issued id or a real catalog item, and removed by
 * `teardown` in afterAll regardless of outcome. The order matters:
 * equipment_unavailability cascades with its unit, equipment_stock_changes
 * cascades with its catalog item, and both reference users, so users go last.
 *
 * equipment_booking.event_id is a foreign key to events-service's table, so a
 * throwaway booking would mean writing another service's data. These tests
 * therefore leave bookings, requests and events alone.
 */
import "../../lib/env.js";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

// Files run in parallel workers, so the clock alone can repeat; the random tail keeps two files' rows and teardowns apart.
export const RUN = `${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
export const SUPPORT_ID = `ZINT-TS-${RUN}`;

/** A catalog name that belongs to this run only. */
export const itemName = (suffix: string) => `ZINT ${RUN} ${suffix}`;

export async function seedSupportUser(): Promise<void> {
  const { error } = await supabaseAdmin.from("users").insert({
    id: SUPPORT_ID,
    name: "ZINT Technical Support",
    email: `zint-ts-${RUN}@example.com`,
    role: "technical_support",
    password_hash: `unused-${randomUUID()}`,
  });
  if (error) throw new Error(`Failed to seed the integration user: ${error.message}`);
}

/** Removes every catalog item this run made, its units, and the throwaway user. */
export async function teardown(): Promise<void> {
  const { data: items } = await supabaseAdmin.from("equipment_catalog").select("id").like("name", `ZINT ${RUN}%`);
  const ids = (items ?? []).map((row: { id: number }) => row.id);
  if (ids.length > 0) {
    await supabaseAdmin.from("equipment").delete().in("equipment_catalog_id", ids);
    await supabaseAdmin.from("equipment_catalog").delete().in("id", ids);
  }
  await supabaseAdmin.from("users").delete().eq("id", SUPPORT_ID);
}
