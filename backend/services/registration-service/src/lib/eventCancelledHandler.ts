import type { supabaseAdmin } from "./supabaseAdmin.js";
import type { InboundMessage } from "./rabbitConsumer.js";
import { REGISTRATION_STATUS } from "./registrationStatus.js";
import { getPublisher } from "./rabbitPublisher.js";

export interface HandleEventCancelledDeps {
  supabase: typeof supabaseAdmin;
}

/**
 * RabbitMQ.md section 4: `event.cancelled` -> every `Registered` place for
 * the event becomes `Cancelled` (migration 0041 — kept apart from
 * `Withdrawn`, which means the attendee gave up their own place, E6-4),
 * then publishes `registration.cancelled_by_event`
 * (section 3.5, #35) to each affected attendee. Naturally idempotent on
 * redelivery: the update only ever matches rows still `Registered`, so a
 * message processed twice notifies nobody the second time.
 */
export async function handleEventCancelled(msg: InboundMessage, deps: HandleEventCancelledDeps): Promise<void> {
  if (msg.eventId === null) return;

  const { data: updated, error } = await deps.supabase
    .from("registrations")
    .update({ status: REGISTRATION_STATUS.cancelled })
    .eq("event_id", msg.eventId)
    .eq("status", REGISTRATION_STATUS.registered)
    .select("user_id");
  if (error) throw error;

  const attendeeIds = [...new Set((updated ?? []).map((row) => row.user_id as string))];
  if (attendeeIds.length === 0) return;

  const eventName = typeof msg.data.eventName === "string" && msg.data.eventName ? msg.data.eventName : undefined;
  await getPublisher().publish({
    type: "registration.cancelled_by_event",
    eventId: msg.eventId,
    actorId: msg.actorId,
    recipients: { userIds: attendeeIds, roles: [] },
    data: { eventName },
  });
}
