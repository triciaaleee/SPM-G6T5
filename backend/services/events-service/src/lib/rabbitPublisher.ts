import amqp from "amqplib";
import { randomUUID } from "node:crypto";
import { clock } from "./clock.js";

/**
 * The envelope every publisher on `connectsphere.events` uses
 * (RabbitMQ.md section 2).
 */
export interface OutboundMessage {
  /** Set by the outbox so a retry reuses the same id and consumers can skip a repeat; otherwise generated. */
  messageId?: string;
  /** Likewise kept stable across retries. */
  occurredAt?: string;
  type: string;
  eventId: number | null;
  actorId: string | null;
  recipients: { userIds: string[]; roles: string[] };
  data: Record<string, unknown>;
}

export interface EventPublisher {
  /** Resolves true once the broker has confirmed the message, false on failure — never rejects (M6: best effort, logged). */
  publish(msg: OutboundMessage): Promise<boolean>;
}

const EXCHANGE = "connectsphere.events";

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection["createConfirmChannel"]>>;

/**
 * Lazily connects on the first publish and reuses the channel after that.
 * M3: callers publish only after their own DB write has committed. M6: a
 * failed publish is logged and swallowed — best effort, which suits a
 * notification. A message another service must act on goes through
 * `lib/outbox.ts` instead, which retries until this resolves true.
 */
function createRealPublisher(url: string): EventPublisher {
  let channelPromise: Promise<Channel> | undefined;

  async function getChannel(): Promise<Channel> {
    if (!channelPromise) {
      channelPromise = (async () => {
        const connection = await amqp.connect(url);
        const channel = await connection.createConfirmChannel();
        await channel.assertExchange(EXCHANGE, "topic", { durable: true });
        return channel;
      })();
    }
    return channelPromise;
  }

  return {
    async publish(msg: OutboundMessage): Promise<boolean> {
      try {
        const channel = await getChannel();
        const envelope = {
          messageId: msg.messageId ?? randomUUID(),
          type: msg.type,
          occurredAt: msg.occurredAt ?? clock.now().toISOString(),
          publisher: "events-service",
          actorId: msg.actorId,
          eventId: msg.eventId,
          recipients: msg.recipients,
          data: msg.data,
        };
        // A confirm channel: the callback fires once the broker has the message,
        // so `true` below means it was accepted, not just handed to the client.
        await new Promise<void>((resolve, reject) => {
          channel.publish(EXCHANGE, msg.type, Buffer.from(JSON.stringify(envelope)), { persistent: true }, (err) =>
            err ? reject(err) : resolve(),
          );
        });
        console.log(`events-service: published "${msg.type}" to RabbitMQ (messageId=${envelope.messageId})`);
        return true;
      } catch (err) {
        console.error(`events-service: failed to publish "${msg.type}"`, err);
        channelPromise = undefined; // retry a fresh connection next time
        return false;
      }
    },
  };
}

/** No-op if RABBITMQ_URL isn't set, so local dev without Docker isn't blocked. */
const idlePublisher: EventPublisher = {
  async publish() {
    return true;
  },
};

let publisher: EventPublisher | undefined;

export function getPublisher(): EventPublisher {
  if (!publisher) {
    const url = process.env.RABBITMQ_URL;
    publisher = url ? createRealPublisher(url) : idlePublisher;
  }
  return publisher;
}

/** Test-only: lets tests swap in a fake without touching real amqplib (M12). */
export function setPublisherForTest(fake: EventPublisher | undefined): void {
  publisher = fake;
}
