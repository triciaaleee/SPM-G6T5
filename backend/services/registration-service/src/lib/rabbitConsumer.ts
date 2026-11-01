import amqp from "amqplib";

/**
 * The envelope every publisher on `connectsphere.events` uses
 * (RabbitMQ.md section 2).
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
const QUEUE = "registration-service";
const DLQ = "registration-service.dlq";

/**
 * RabbitMQ.md section 4: registration-service only needs `event.cancelled`
 * (E3-6) today, so the queue binds to that routing key alone rather than
 * every message on the exchange. Acks only after the handler's own DB
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
    // amqplib emits "error" when the broker drops; with no listener Node
    // throws it and the whole service dies, taking the REST API with it.
    connection.on("error", (err: unknown) => {
      console.error("registration-service: RabbitMQ connection error", err);
    });
    channel = await connection.createChannel();
    channel.on("error", (err: unknown) => {
      console.error("registration-service: RabbitMQ channel error", err);
    });

    await channel.assertExchange(EXCHANGE, "topic", { durable: true });
    await channel.assertExchange(DLX, "topic", { durable: true });

    await channel.assertQueue(DLQ, { durable: true });
    await channel.bindQueue(DLQ, DLX, "event.cancelled");

    await channel.assertQueue(QUEUE, {
      durable: true,
      arguments: { "x-dead-letter-exchange": DLX },
    });
    await channel.bindQueue(QUEUE, EXCHANGE, "event.cancelled");

    await channel.prefetch(1);

    await channel.consume(QUEUE, (msg) => {
      if (!msg) return;
      void (async () => {
        let processed = true;
        try {
          const parsed = JSON.parse(msg.content.toString("utf8")) as InboundMessage;
          console.log(`registration-service: consumed "${parsed.type}" from RabbitMQ (messageId=${parsed.messageId})`);
          await handler(parsed);
        } catch (err) {
          processed = false;
          console.error("registration-service: failed to process message, sending to DLQ", err);
        }
        try {
          if (processed) channel!.ack(msg);
          else channel!.nack(msg, false, false);
        } catch (err) {
          // The channel closed while the handler ran. Thrown from here it would end the process; the broker redelivers the message.
          console.error("registration-service: RabbitMQ channel closed before the message was settled", err);
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
