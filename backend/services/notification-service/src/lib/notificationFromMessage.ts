import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboundMessage } from "./rabbitConsumer.js";
import { renderNotification } from "./messageTemplates.js";

export interface HandleInboundMessageDeps {
  supabase: SupabaseClient;
  resolveRoleUserIds: (role: string) => Promise<string[]>;
}

/**
 * Maps one broker message to notification row(s) and inserts them.
 * Bypasses the REST route's input validation (TYPE_PATTERN etc.) by
 * writing through supabaseAdmin directly — that regex is a validator on
 * `POST /`'s request body, not a DB constraint, and the consumer isn't
 * going through that route.
 */
export async function handleInboundMessage(msg: InboundMessage, deps: HandleInboundMessageDeps): Promise<void> {
  const { supabase, resolveRoleUserIds } = deps;

  // M5: a redelivered message is a no-op if already recorded.
  const existing = await supabase.from("notifications").select("id").eq("message_id", msg.messageId).limit(1);
  if (existing.error) throw existing.error;
  if ((existing.data ?? []).length > 0) return;

  const roleRecipients = await Promise.all(msg.recipients.roles.map((role) => resolveRoleUserIds(role)));
  const recipientIds = [...new Set([...msg.recipients.userIds, ...roleRecipients.flat()])];
  if (recipientIds.length === 0) return;

  const rows = recipientIds
    .map((recipientId) => {
      const rendered = renderNotification(msg, recipientId);
      if (!rendered) return null;
      return {
        recipient_id: recipientId,
        type: msg.type,
        title: rendered.title,
        body: rendered.body,
        link: rendered.link,
        event_id: msg.eventId,
        message_id: msg.messageId,
        actor_id: msg.actorId,
        occurred_at: msg.occurredAt,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) {
    console.warn(`notification-service: no template for message type "${msg.type}", skipping`);
    return;
  }

  const { error } = await supabase.from("notifications").insert(rows);
  if (error) throw error;
}
