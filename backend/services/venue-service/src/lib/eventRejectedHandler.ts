import type { supabaseAdmin } from "./supabaseAdmin.js";
import type { InboundMessage } from "./rabbitConsumer.js";
import { releaseBookingsForCancelledEvent } from "./eventCancellation.js";

export interface HandleEventRejectedDeps {
  supabase: typeof supabaseAdmin;
}

/**
 * RabbitMQ.md section 4: `event.rejected` -> withdraws every active
 * booking, then publishes #33 (`reason: event_rejected`). A Planning event
 * is rejected only through a clarification and may already hold bookings.
 * Naturally idempotent on redelivery, like `event.cancelled`.
 */
export async function handleEventRejected(msg: InboundMessage, deps: HandleEventRejectedDeps): Promise<void> {
  if (msg.eventId === null) return;
  const eventName = typeof msg.data.eventName === "string" && msg.data.eventName ? msg.data.eventName : `Event #${msg.eventId}`;
  await releaseBookingsForCancelledEvent(deps.supabase, msg.eventId, msg.actorId, eventName, "event_rejected");
}
