import amqp from "amqplib";

/**
 * The envelope every publisher on `connectsphere.events` uses
 * (c4_diagrams/RabbitMQ.md section 2).
 */
export interface InboundMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  publisher: string;
  actorId: string | null;
  eventId: number | null;
  recipients: { userIds: string[]; roles: string[] };
  data: Record<string, unknown>;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;

export interface RabbitConsumer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const EXCHANGE = "connectsphere.events";
const DLX = "connectsphere.dlx";
const QUEUE = "equipment-service";
const DLQ = "equipment-service.dlq";

/**
 * RabbitMQ.md section 4: equipment-service only needs `event.cancelled`
 * (E3-6) and `event.rescheduled` (stored booking windows follow the event),
 * so the queue binds to those routing keys alone rather than every message
 * on the exchange. Acks only after the handler's own DB
 * write succeeds; a thrown handler error nacks without requeue, so the
 * broker's dead-letter policy sends it straight to the DLQ rather than
 * looping forever.
 */
type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection["createChannel"]>>;

export function connectAndConsume(url: string, handler: MessageHandler): RabbitConsumer {
  let connection: Connection | undefined;
  let channel: Channel | undefined;

  async function start(): Promise<void> {
    connection = await amqp.connect(url);
    channel = await connection.createChannel();

    await channel.assertExchange(EXCHANGE, "topic", { durable: true });
    await channel.assertExchange(DLX, "topic", { durable: true });

    await channel.assertQueue(DLQ, { durable: true });
    await channel.bindQueue(DLQ, DLX, "event.cancelled");
    await channel.bindQueue(DLQ, DLX, "event.rescheduled");

    await channel.assertQueue(QUEUE, {
      durable: true,
      arguments: { "x-dead-letter-exchange": DLX },
    });
    await channel.bindQueue(QUEUE, EXCHANGE, "event.cancelled");
    await channel.bindQueue(QUEUE, EXCHANGE, "event.rescheduled");

    await channel.prefetch(1);

    await channel.consume(QUEUE, (msg) => {
      if (!msg) return;
      void (async () => {
        try {
          const parsed = JSON.parse(msg.content.toString("utf8")) as InboundMessage;
          console.log(`equipment-service: consumed "${parsed.type}" from RabbitMQ (messageId=${parsed.messageId})`);
          await handler(parsed);
          channel!.ack(msg);
        } catch (err) {
          console.error("equipment-service: failed to process message, sending to DLQ", err);
          channel!.nack(msg, false, false);
        }
      })();
    });
  }

  async function stop(): Promise<void> {
    await channel?.close();
    await connection?.close();
  }

  return { start, stop };
}
