import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect, channel, connection } = vi.hoisted(() => {
  const channel = {
    assertExchange: vi.fn(async () => {}),
    assertQueue: vi.fn(async () => {}),
    bindQueue: vi.fn(async () => {}),
    prefetch: vi.fn(async () => {}),
    consume: vi.fn(async (..._a: unknown[]) => {}),
    ack: vi.fn(),
    nack: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const connection = { createChannel: vi.fn(async () => channel), close: vi.fn(async () => {}) };
  return { connect: vi.fn(async (..._a: unknown[]) => connection), channel, connection };
});
vi.mock("amqplib", () => ({ default: { connect } }));

import { connectAndConsume, type InboundMessage } from "../lib/rabbitConsumer.js";

const inbound: InboundMessage = {
  messageId: "m1",
  type: "event.cancelled",
  occurredAt: "2026-10-28T04:00:00.000Z",
  publisher: "events-service",
  actorId: "U1",
  eventId: 5,
  recipients: { userIds: [], roles: [] },
  data: {},
};
const raw = (m: unknown) => ({ content: Buffer.from(typeof m === "string" ? m : JSON.stringify(m)) });

async function startWith(handler = vi.fn(async (_m: InboundMessage) => {})) {
  const consumer = connectAndConsume("amqp://broker", handler);
  await consumer.start();
  const onMessage = channel.consume.mock.calls[0][1] as (msg: unknown) => void;
  return { consumer, handler, onMessage };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("connectAndConsume", () => {
  it("connects to the broker URL and declares the exchanges", async () => {
    await startWith();
    expect(connect).toHaveBeenCalledExactlyOnceWith("amqp://broker");
    expect(channel.assertExchange).toHaveBeenNthCalledWith(1, "connectsphere.events", "topic", { durable: true });
    expect(channel.assertExchange).toHaveBeenNthCalledWith(2, "connectsphere.dlx", "topic", { durable: true });
  });

  it("declares a durable dead-letter queue and a main queue that dead-letters into it", async () => {
    await startWith();
    expect(channel.assertQueue).toHaveBeenCalledWith("equipment-service.dlq", { durable: true });
    expect(channel.assertQueue).toHaveBeenCalledWith("equipment-service", {
      durable: true,
      arguments: { "x-dead-letter-exchange": "connectsphere.dlx" },
    });
  });

  it("binds only the three routing keys it handles, on both queues", async () => {
    await startWith();
    const keys = ["event.cancelled", "event.rejected", "event.rescheduled"];
    expect(channel.bindQueue.mock.calls).toHaveLength(6);
    for (const key of keys) {
      expect(channel.bindQueue).toHaveBeenCalledWith("equipment-service.dlq", "connectsphere.dlx", key);
      expect(channel.bindQueue).toHaveBeenCalledWith("equipment-service", "connectsphere.events", key);
    }
  });

  it("takes one message at a time", async () => {
    await startWith();
    expect(channel.prefetch).toHaveBeenCalledExactlyOnceWith(1);
    expect(channel.consume).toHaveBeenCalledExactlyOnceWith("equipment-service", expect.any(Function));
  });

  it("acks after the handler succeeds", async () => {
    const { handler, onMessage } = await startWith();
    const msg = raw(inbound);
    onMessage(msg);
    await vi.waitFor(() => expect(channel.ack).toHaveBeenCalledExactlyOnceWith(msg));
    expect(handler).toHaveBeenCalledExactlyOnceWith(inbound);
    expect(channel.nack).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('equipment-service: consumed "event.cancelled" from RabbitMQ (messageId=m1)');
  });

  it("nacks without requeue when the handler throws, so the broker dead-letters it", async () => {
    const { onMessage } = await startWith(vi.fn(async () => { throw new Error("db down"); }));
    const msg = raw(inbound);
    onMessage(msg);
    await vi.waitFor(() => expect(channel.nack).toHaveBeenCalledExactlyOnceWith(msg, false, false));
    expect(channel.ack).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("equipment-service: failed to process message, sending to DLQ", expect.any(Error));
  });

  it("nacks a message that is not JSON, without calling the handler", async () => {
    const { handler, onMessage } = await startWith();
    const msg = raw("not json{");
    onMessage(msg);
    await vi.waitFor(() => expect(channel.nack).toHaveBeenCalledExactlyOnceWith(msg, false, false));
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores the null the broker sends when the consumer is cancelled", async () => {
    const { handler, onMessage } = await startWith();
    onMessage(null);
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("stop closes the channel, then the connection", async () => {
    const order: string[] = [];
    channel.close.mockImplementationOnce(async () => { order.push("channel"); });
    connection.close.mockImplementationOnce(async () => { order.push("connection"); });
    const { consumer } = await startWith();
    await consumer.stop();
    expect(order).toEqual(["channel", "connection"]);
  });

  it("stop before start is a no-op", async () => {
    const consumer = connectAndConsume("amqp://broker", vi.fn());
    await expect(consumer.stop()).resolves.toBeUndefined();
    expect(channel.close).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
  });

  it("start rejects when the broker is down", async () => {
    connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(connectAndConsume("amqp://broker", vi.fn()).start()).rejects.toThrow("ECONNREFUSED");
  });
});
