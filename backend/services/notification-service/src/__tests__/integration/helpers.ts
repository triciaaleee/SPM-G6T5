/**
 * Shared helpers for the real-DB integration tests. notifications.recipient_id
 * has no foreign key (migration 0017), so no users need seeding: every row
 * belongs to a recipient under a "ZINT-NOTIF-" prefix that can never collide
 * with a real generate_user_id()-issued id, and `teardown` removes them in
 * afterAll regardless of outcome.
 */
import "../../lib/env.js";
import { randomUUID } from "node:crypto";
import type { InboundMessage } from "../../lib/rabbitConsumer.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";

// Files run in parallel workers, so the clock alone can repeat; the random tail keeps two files' rows and teardowns apart.
export const RUN = `${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
const PREFIX = `ZINT-NOTIF-${RUN}`;

export const recipient = (name: string) => `${PREFIX}-${name}`;

export function buildMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: randomUUID(),
    type: "booking.decided",
    occurredAt: "2026-10-10T08:15:00.000Z",
    publisher: "integration-test",
    actorId: "COORD-0003",
    eventId: 7,
    recipients: { userIds: [recipient("a")], roles: [] },
    data: { venueName: "ZINT Hall", eventName: "ZINT Gala", decision: "approved" },
    ...overrides,
  };
}

/** Every row this file created, oldest first. */
export async function rowsFor(messageId: string) {
  const { data, error } = await supabaseAdmin.from("notifications").select("*").eq("message_id", messageId).order("id");
  if (error) throw new Error(`Failed to read back notifications: ${error.message}`);
  return data;
}

export async function teardown(): Promise<void> {
  const { error } = await supabaseAdmin.from("notifications").delete().like("recipient_id", `${PREFIX}-%`);
  if (error) throw new Error(`Failed to clean up notifications: ${error.message}`);
}
