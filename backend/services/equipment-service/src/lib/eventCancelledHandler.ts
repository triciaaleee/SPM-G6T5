import type { supabaseAdmin } from "./supabaseAdmin.js";
import type { InboundMessage } from "./rabbitConsumer.js";
import { releaseEquipmentForEvent } from "./eventCancellation.js";
import { getPublisher } from "./rabbitPublisher.js";

export interface HandleEventCancelledDeps {
  supabase: typeof supabaseAdmin;
}

/**
 * RabbitMQ.md section 4: `event.cancelled` -> releases every reservation
 * for the event (E5-6 AC4), then publishes `equipment.released`
 * (section 3.4, #34) to Technical Support. Naturally idempotent on
 * redelivery: release_equipment_for_event only moves stock for items that
 * still have `quantity_fulfilled > 0`, so a message processed twice moves
 * nothing the second time — but it would still re-notify, so this skips
 * the publish entirely when nothing was actually released.
 */
export async function handleEventCancelled(msg: InboundMessage, deps: HandleEventCancelledDeps): Promise<void> {
  if (msg.eventId === null) return;

  const { data: requests, error: requestsError } = await deps.supabase
    .from("equipment_requests")
    .select("id")
    .eq("event_id", msg.eventId);
  if (requestsError) throw requestsError;
  const requestIds = (requests ?? []).map((row) => row.id as number);

  let hadReservations = false;
  if (requestIds.length > 0) {
    const { data: items, error: itemsError } = await deps.supabase
      .from("equipment_request_items")
      .select("id")
      .in("request_id", requestIds)
      .gt("quantity_fulfilled", 0);
    if (itemsError) throw itemsError;
    hadReservations = (items ?? []).length > 0;
  }

  await releaseEquipmentForEvent(deps.supabase, msg.eventId);
  if (!hadReservations) return;

  const eventName = typeof msg.data.eventName === "string" && msg.data.eventName ? msg.data.eventName : `Event #${msg.eventId}`;
  await getPublisher().publish({
    type: "equipment.released",
    eventId: msg.eventId,
    actorId: msg.actorId,
    recipients: { userIds: [], roles: ["technical_support"] },
    data: { eventName, reason: "event_cancelled" },
  });
}
