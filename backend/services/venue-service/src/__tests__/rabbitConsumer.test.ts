import { beforeEach, describe, expect, it, vi } from "vitest";

const channel = {
  assertExchange: vi.fn(),
  assertQueue: vi.fn(),
  bindQueue: vi.fn(),
  prefetch: vi.fn(),
  consume: vi.fn(),
  ack: vi.fn(),
  nack: vi.fn(),
  close: vi.fn(),
};
const connection = { createChannel: vi.fn(async () => channel), close: vi.fn() };
vi.mock("amqplib", () => ({ default: { connect: vi.fn(async () => connection) } }));

import amqp from "amqplib";
import { connectAndConsume, type InboundMessage } from "../lib/rabbitConsumer.js";

const message: InboundMessage = {
  messageId: "m-1",
  type: "event.cancelled",
  occurredAt: "2026-10-25T00:00:00Z",
  publisher: "events-service",
  actorId: "ORG-0001",
  eventId: 7,
  recipients: { userIds: [], roles: [] },
  data: {},
};
const delivery = (body: string) => ({ content: Buffer.from(body) });

/** Starts the consumer and returns the callback it registered with channel.consume. */
async function started(handler: (m: InboundMessage) => Promise<void>) {
  const consumer = connectAndConsume("amqp://test", handler);
  await consumer.start();
  const onMessage = channel.consume.mock.calls[0][1] as (m: unknown) => void;
  return { consumer, onMessage };
}
const flush = () => new Promise((r) => setImmediate(r));

describe("connectAndConsume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("declares the exchange, the dead-letter topology and binds to event.cancelled only", async () => {
    await started(vi.fn());

    expect(amqp.connect).toHaveBeenCalledWith("amqp://test");
    expect(channel.assertExchange).toHaveBeenCalledWith("connectsphere.events", "topic", { durable: true });
    expect(channel.assertExchange).toHaveBeenCalledWith("connectsphere.dlx", "topic", { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith("venue-service", {
      durable: true,
      arguments: { "x-dead-letter-exchange": "connectsphere.dlx" },
    });
    expect(channel.bindQueue).toHaveBeenCalledWith("venue-service", "connectsphere.events", "event.cancelled");
    expect(channel.bindQueue).toHaveBeenCalledWith("venue-service.dlq", "connectsphere.dlx", "event.cancelled");
    expect(channel.bindQueue).toHaveBeenCalledWith("venue-service", "connectsphere.events", "event.rejected");
    expect(channel.bindQueue).toHaveBeenCalledWith("venue-service.dlq", "connectsphere.dlx", "event.rejected");
    for (const key of ["event.rescheduled", "event.attendance_changed"]) {
      expect(channel.bindQueue).toHaveBeenCalledWith("venue-service", "connectsphere.events", key);
      expect(channel.bindQueue).toHaveBeenCalledWith("venue-service.dlq", "connectsphere.dlx", key);
    }
    // Four routing keys, each bound to the queue and to its dead-letter queue, and nothing else.
    expect(channel.bindQueue).toHaveBeenCalledTimes(8);
    expect(channel.prefetch).toHaveBeenCalledWith(1);
  });

  it("makes the dead-letter queue durable, so failed messages survive a broker restart", async () => {
    await started(vi.fn());
    expect(channel.assertQueue).toHaveBeenCalledWith("venue-service.dlq", { durable: true });
  });

  it("logs what it consumed", async () => {
    const { onMessage } = await started(vi.fn());
    onMessage(delivery(JSON.stringify(message)));
    await flush();
    expect(console.log).toHaveBeenCalledWith('venue-service: consumed "event.cancelled" from RabbitMQ (messageId=m-1)');
  });

  it("logs why it dead-lettered a message", async () => {
    const boom = new Error("db down");
    const { onMessage } = await started(vi.fn(async () => { throw boom; }));
    onMessage(delivery(JSON.stringify(message)));
    await flush();
    expect(console.error).toHaveBeenCalledWith("venue-service: failed to process message, sending to DLQ", boom);
  });

  it("acks only after the handler succeeds", async () => {
    const handler = vi.fn(async () => {});
    const { onMessage } = await started(handler);
    const msg = delivery(JSON.stringify(message));

    onMessage(msg);
    await flush();

    expect(handler).toHaveBeenCalledWith(message);
    expect(channel.ack).toHaveBeenCalledWith(msg);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("nacks without requeue when the handler throws, so the broker dead-letters it", async () => {
    const { onMessage } = await started(vi.fn(async () => { throw new Error("db down"); }));
    const msg = delivery(JSON.stringify(message));

    onMessage(msg);
    await flush();

    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    expect(channel.ack).not.toHaveBeenCalled();
  });

  it("nacks a message that is not valid JSON without calling the handler", async () => {
    const handler = vi.fn();
    const { onMessage } = await started(handler);
    const msg = delivery("{not json");

    onMessage(msg);
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
  });

  it("ignores a null delivery (consumer cancelled by the broker)", async () => {
    const handler = vi.fn();
    const { onMessage } = await started(handler);

    onMessage(null);
    await flush();

    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("stop closes the channel and the connection", async () => {
    const { consumer } = await started(vi.fn());

    await consumer.stop();

    expect(channel.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalled();
  });

  it("stop before start is a harmless no-op", async () => {
    await expect(connectAndConsume("amqp://test", vi.fn()).stop()).resolves.toBeUndefined();
  });
});
