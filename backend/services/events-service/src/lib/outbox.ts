import type { supabaseAdmin } from "./supabaseAdmin.js";
import { getPublisher, type OutboundMessage } from "./rabbitPublisher.js";
import { clock } from "./clock.js";

type Supabase = typeof supabaseAdmin;

/**
 * Reliable publishing for a message another service must act on (today
 * `event.cancelled`; migration 0045). The message is stored in
 * `event_outbox` right after the DB write it announces, then published.
 * If the broker is down or the service stops first, `flushOutbox` (run on
 * a timer by index.ts) keeps retrying until the broker confirms it. A
 * notification-only message doesn't need this; it publishes directly.
 *
 * Delivery is at-least-once: a retry reuses the stored `message_id`, so a
 * consumer can skip a repeat. The store is not in the same transaction as
 * the write it announces, so a crash between the two can still lose the
 * message; it is a much smaller window than a broker outage.
 */

interface OutboxRow {
  id: number;
  message_id: string;
  type: string;
  event_id: number | null;
  actor_id: string | null;
  recipients: { userIds: string[]; roles: string[] };
  data: Record<string, unknown>;
  occurred_at: string;
}

const OUTBOX_COLUMNS = "id, message_id, type, event_id, actor_id, recipients, data, occurred_at";
const FLUSH_BATCH = 50;

function toMessage(row: OutboxRow): OutboundMessage {
  return {
    messageId: row.message_id,
    occurredAt: row.occurred_at,
    type: row.type,
    eventId: row.event_id,
    actorId: row.actor_id,
    recipients: row.recipients,
    data: row.data,
  };
}

async function markPublished(supabase: Supabase, id: number): Promise<void> {
  const { error } = await supabase
    .from("event_outbox")
    .update({ published_at: clock.now().toISOString() })
    .eq("id", id);
  // Left unmarked, the relay will publish it again; a consumer skips the repeat.
  if (error) console.error(`events-service: could not mark outbox row ${id} published`, error);
}

async function markFailed(supabase: Supabase, row: OutboxRow, attempts: number): Promise<void> {
  const { error } = await supabase
    .from("event_outbox")
    .update({ attempts, last_error: "broker did not confirm the message" })
    .eq("id", row.id);
  if (error) console.error(`events-service: could not record the failed attempt on outbox row ${row.id}`, error);
}

/**
 * Stores `msg`, then tries to publish it once. Resolves true when the
 * message is safe: published, or stored for the relay to retry. Resolves
 * false only when it could neither be stored nor published directly.
 */
export async function publishDurably(supabase: Supabase, msg: OutboundMessage): Promise<boolean> {
  const { data, error } = await supabase
    .from("event_outbox")
    .insert({
      type: msg.type,
      event_id: msg.eventId,
      actor_id: msg.actorId,
      recipients: msg.recipients,
      data: msg.data,
    })
    .select(OUTBOX_COLUMNS)
    .single();

  if (error || !data) {
    console.error(`events-service: could not store "${msg.type}" in the outbox, publishing it directly`, error);
    return getPublisher().publish(msg);
  }

  const row = data as unknown as OutboxRow;
  if (await getPublisher().publish(toMessage(row))) {
    await markPublished(supabase, row.id);
  }
  return true;
}

/**
 * Publishes what is still waiting, oldest first. Stops at the first
 * failure: the broker is likely down, and later messages should not
 * overtake an earlier one. Resolves how many it published.
 */
export async function flushOutbox(supabase: Supabase): Promise<number> {
  const { data, error } = await supabase
    .from("event_outbox")
    .select(`${OUTBOX_COLUMNS}, attempts`)
    .is("published_at", null)
    .order("id", { ascending: true })
    .limit(FLUSH_BATCH);

  if (error) {
    console.error("events-service: could not read the outbox", error);
    return 0;
  }

  let published = 0;
  for (const row of (data ?? []) as unknown as (OutboxRow & { attempts: number })[]) {
    if (!(await getPublisher().publish(toMessage(row)))) {
      await markFailed(supabase, row, row.attempts + 1);
      break;
    }
    await markPublished(supabase, row.id);
    published += 1;
  }
  return published;
}

/** Runs `flushOutbox` on a timer; a failed run is logged and the next one tries again. */
export function startOutboxRelay(supabase: Supabase, intervalMs = 10_000): () => void {
  const timer = setInterval(() => {
    flushOutbox(supabase).catch((err) => console.error("events-service: outbox relay failed", err));
  }, intervalMs);
  return () => clearInterval(timer);
}
