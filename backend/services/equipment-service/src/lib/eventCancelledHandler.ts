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
 * redelivery: release_equipment_for_event frees the event's units (their
 * booking rows go; the requests and items stay as history), so a
 * message processed twice releases nothing the second time — but it would
 * still re-notify, so this skips the publish entirely when the event held
 * no bookings.
 */
export async function handleEventCancelled(msg: InboundMessage, deps: HandleEventCancelledDeps): Promise<void> {
  await releaseForEvent(msg, deps, "event_cancelled");
}

/**
 * The release shared by `event.cancelled` and `event.rejected` (a Planning
 * event rejected through a clarification may already hold reservations,
 * AGENTS.md section 3). `reason` is what Technical Support is told.
 */
export async function releaseForEvent(
  msg: InboundMessage,
  deps: HandleEventCancelledDeps,
  reason: "event_cancelled" | "event_rejected",
): Promise<void> {
  if (msg.eventId === null) return;

  // The units reserved for the event are its equipment_booking rows. Releasing
  // the event frees them, so a redelivered message finds none and notifies nobody.
  const { data: bookings, error: bookingsError } = await deps.supabase
    .from("equipment_booking")
    .select("id")
    .eq("event_id", msg.eventId)
    .eq("status", "Reserved")
    .limit(1);
  if (bookingsError) throw bookingsError;
  const hadReservations = (bookings ?? []).length > 0;

  await releaseEquipmentForEvent(deps.supabase, msg.eventId);
  if (!hadReservations) return;

  const eventName = typeof msg.data.eventName === "string" && msg.data.eventName ? msg.data.eventName : `Event #${msg.eventId}`;
  await getPublisher().publish({
    type: "equipment.released",
    eventId: msg.eventId,
    actorId: msg.actorId,
    recipients: { userIds: [], roles: ["technical_support"] },
    data: { eventName, reason },
  });
}
