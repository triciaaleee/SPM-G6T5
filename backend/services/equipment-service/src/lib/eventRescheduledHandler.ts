import { createHash } from "node:crypto";
import type { supabaseAdmin } from "./supabaseAdmin.js";
import type { InboundMessage } from "./rabbitConsumer.js";
import { reportArrangementsChanged } from "./eventsClient.js";
import { getPublisher } from "./rabbitPublisher.js";
import { occupiedWindow } from "./scheduleWindow.js";

export interface HandleEventRescheduledDeps {
  supabase: typeof supabaseAdmin;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** A UUID-shaped id that is the same every time for one inbound message, so a redelivery notifies nobody twice. */
function derivedMessageId(inboundMessageId: string, suffix: string): string {
  const hex = createHash("sha256").update(`${inboundMessageId}:${suffix}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * `event.rescheduled`: moves the stored window on every unit still reserved
 * for the event to the event's new date and time, then checks what that did.
 *
 * The window is what reserve_equipment_request and catalog_stock_now compare
 * other bookings against, and only events-service knows when an event
 * happens, so without this it would stay at the old time until a later claim
 * refreshed it (lib/equipmentConflicts.ts). The message carries the new
 * schedule, so no call back to events-service. Setting the same values twice
 * changes nothing. An event left with no usable date gets no window (the
 * database overlap check skips it; the application check still reads
 * events-service). Released bookings are history and keep their window.
 *
 * The new time may put a reserved unit on top of another event's booking of
 * the same unit, or inside a period it is out of use (equipment_reschedule_clashes,
 * migration 0055). The reschedule can't be refused (events-service has already
 * saved it), so each clash is reported instead: the units stay reserved, the
 * event's coordinator and Technical Support are notified (`equipment.reservation_clash`),
 * and events-service is told the arrangements changed, which moves a Confirmed
 * event to Needs Review and leaves one in Planning as it is. The request page
 * keeps flagging the item (lib/reservationFlags.ts) until Technical Support
 * re-arrange it. Reporting is best effort and happens after the window is saved.
 */
export async function handleEventRescheduled(msg: InboundMessage, deps: HandleEventRescheduledDeps): Promise<void> {
  if (msg.eventId === null) return;

  const window = occupiedWindow({
    proposedDate: text(msg.data.proposedDate),
    startTime: text(msg.data.startTime),
    endTime: text(msg.data.endTime),
  });

  const { error } = await deps.supabase
    .from("equipment_booking")
    .update({ window_start_ms: window?.startMs ?? null, window_end_ms: window?.endMs ?? null })
    .eq("event_id", msg.eventId)
    .eq("status", "Reserved");
  if (error) throw error;

  const { data: clashes, error: clashError } = await deps.supabase.rpc("equipment_reschedule_clashes", {
    p_event_id: msg.eventId,
  });
  if (clashError) throw clashError;

  const clashing = (clashes ?? []) as { item_id: number; unit_id: number; kind: string }[];
  if (clashing.length === 0) return;

  const units = new Set(clashing.map((c) => c.unit_id)).size;
  const eventName = text(msg.data.eventName) ?? `Event #${msg.eventId}`;
  const coordinatorId = text(msg.data.coordinatorId);

  await reportArrangementsChanged(
    msg.eventId,
    `${units} reserved unit${units === 1 ? " now clashes" : "s now clash"} after the event was rescheduled`,
  );
  await getPublisher().publish({
    messageId: derivedMessageId(msg.messageId, "equipment.reservation_clash"),
    type: "equipment.reservation_clash",
    eventId: msg.eventId,
    actorId: msg.actorId,
    recipients: { userIds: coordinatorId ? [coordinatorId] : [], roles: ["technical_support"] },
    data: { eventName, coordinatorId, units },
  });
}
