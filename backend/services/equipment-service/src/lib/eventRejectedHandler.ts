import type { InboundMessage } from "./rabbitConsumer.js";
import { releaseForEvent, type HandleEventCancelledDeps } from "./eventCancelledHandler.js";

/**
 * RabbitMQ.md section 4: `event.rejected` -> releases every reservation for
 * the event, then publishes `equipment.released` (`reason: event_rejected`) to
 * Technical Support. Idempotent on redelivery, like `event.cancelled`.
 */
export async function handleEventRejected(msg: InboundMessage, deps: HandleEventCancelledDeps): Promise<void> {
  await releaseForEvent(msg, deps, "event_rejected");
}
