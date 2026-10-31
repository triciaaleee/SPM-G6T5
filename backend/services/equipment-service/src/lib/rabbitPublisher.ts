import amqp from "amqplib";
import { randomUUID } from "node:crypto";

/**
 * The envelope every publisher on `connectsphere.events` uses
 * (RabbitMQ.md section 2).
 */
export interface OutboundMessage {
  /** Set by a caller that must publish the same message twice as one (a redelivered trigger); otherwise generated. */
  messageId?: string;
  type: string;
  eventId: number | null;
  actorId: string | null;
  recipients: { userIds: string[]; roles: string[] };
  data: Record<string, unknown>;
}

export interface EventPublisher {
  /** Resolves true on success, false on failure — never rejects (M6: best effort, logged). */
  publish(msg: OutboundMessage): Promise<boolean>;
}

const EXCHANGE = "connectsphere.events";

type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection["createChannel"]>>;

/**
 * Lazily connects on the first publish and reuses the channel after that.
 * M3: callers publish only after their own DB write has committed. M6:
 * this is a notification-only message, so a failed publish is logged and
 * swallowed — best effort.
 */
function createRealPublisher(url: string): EventPublisher {
  let channelPromise: Promise<Channel> | undefined;

  async function getChannel(): Promise<Channel> {
    if (!channelPromise) {
      channelPromise = (async () => {
        const connection = await amqp.connect(url);
        const channel = await connection.createChannel();
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
          occurredAt: new Date().toISOString(),
          publisher: "equipment-service",
          actorId: msg.actorId,
          eventId: msg.eventId,
          recipients: msg.recipients,
          data: msg.data,
        };
        channel.publish(EXCHANGE, msg.type, Buffer.from(JSON.stringify(envelope)), { persistent: true });
        console.log(`equipment-service: published "${msg.type}" to RabbitMQ (messageId=${envelope.messageId})`);
        return true;
      } catch (err) {
        console.error(`equipment-service: failed to publish "${msg.type}"`, err);
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
