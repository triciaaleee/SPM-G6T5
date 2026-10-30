import type { supabaseAdmin } from "./supabaseAdmin.js";
import type { InboundMessage } from "./rabbitConsumer.js";
import { handleEventCancelled } from "./eventCancelledHandler.js";
import { handleEventRejected } from "./eventRejectedHandler.js";
import { handleEventRescheduled } from "./eventRescheduledHandler.js";

/** Routes a message from the equipment-service queue (its bindings, RabbitMQ.md section 1) to its handler. */
export async function handleMessage(msg: InboundMessage, deps: { supabase: typeof supabaseAdmin }): Promise<void> {
  switch (msg.type) {
    case "event.cancelled":
      return handleEventCancelled(msg, deps);
    case "event.rejected":
      return handleEventRejected(msg, deps);
    case "event.rescheduled":
      return handleEventRescheduled(msg, deps);
    default:
      console.warn(`equipment-service: no handler for "${msg.type}", skipping`);
  }
}
