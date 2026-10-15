import type { supabaseAdmin } from "./supabaseAdmin.js";
import type { InboundMessage } from "./rabbitConsumer.js";
import { releaseBookingsForCancelledEvent } from "./eventCancellation.js";

export interface HandleEventCancelledDeps {
  supabase: typeof supabaseAdmin;
}

/**
 * RabbitMQ.md section 4: `event.cancelled` -> withdraws every active
 * booking, then publishes #33. Naturally idempotent on redelivery — the
 * update only ever matches bookings still in an active status, so a
 * message processed twice releases nothing the second time.
 */
export async function handleEventCancelled(msg: InboundMessage, deps: HandleEventCancelledDeps): Promise<void> {
  if (msg.eventId === null) return;
  const eventName = typeof msg.data.eventName === "string" && msg.data.eventName ? msg.data.eventName : `Event #${msg.eventId}`;
  await releaseBookingsForCancelledEvent(deps.supabase, msg.eventId, msg.actorId, eventName);
}
