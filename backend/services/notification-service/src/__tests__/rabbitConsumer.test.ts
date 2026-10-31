import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const channel = {
  assertExchange: vi.fn(),
  assertQueue: vi.fn(),
  bindQueue: vi.fn(),
  prefetch: vi.fn(),
  consume: vi.fn(),
  ack: vi.fn(),
  nack: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
};
const connection = { createChannel: vi.fn(), close: vi.fn(), on: vi.fn() };
const connect = vi.fn();

vi.mock("amqplib", () => ({ default: { connect: (...args: unknown[]) => connect(...args) } }));

import { createFakeConsumer } from "../lib/rabbitConsumer.fake.js";
import { connectAndConsume, type InboundMessage } from "../lib/rabbitConsumer.js";

const msg: InboundMessage = {
  messageId: "11111111-1111-1111-1111-111111111111",
  type: "booking.withdrawn",
  occurredAt: "2026-10-10T08:15:00Z",
  publisher: "venue-service",
  actorId: "COORD-0003",
  eventId: 7,
  recipients: { userIds: ["VEN-0001"], roles: [] },
  data: {},
};

const delivery = (content: string) => ({ content: Buffer.from(content, "utf8") });

/** Starts a consumer and returns the callback amqplib would call for each delivery. */
async function startConsumer(handler = vi.fn().mockResolvedValue(undefined)) {
  const consumer = connectAndConsume("amqp://test", handler);
  await consumer.start();
  const deliver = channel.consume.mock.calls[0][1] as (m: unknown) => void;
  return { consumer, handler, deliver };
}

beforeEach(() => {
  vi.clearAllMocks();
  channel.ack.mockReset();
  channel.nack.mockReset();
  connect.mockResolvedValue(connection);
  connection.createChannel.mockResolvedValue(channel);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFakeConsumer", () => {
  it("calls the handler directly, without a live broker (M12)", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const consumer = createFakeConsumer(handler);

    await consumer.start();
    await consumer.publishForTest(msg);
    await consumer.stop();

    expect(handler).toHaveBeenCalledWith(msg);
  });
});

describe("connectAndConsume", () => {
  it("does not connect until started", () => {
    connectAndConsume("amqp://test", vi.fn());
    expect(connect).not.toHaveBeenCalled();
  });

  it("sets up the exchanges, the dead-letter queue and a queue bound to everything", async () => {
    await startConsumer();

    expect(connect).toHaveBeenCalledWith("amqp://test");
    expect(channel.assertExchange.mock.calls).toEqual([
      ["connectsphere.events", "topic", { durable: true }],
      ["connectsphere.dlx", "topic", { durable: true }],
    ]);
    expect(channel.assertQueue.mock.calls).toEqual([
      ["notification-service.dlq", { durable: true }],
      ["notification-service", { durable: true, arguments: { "x-dead-letter-exchange": "connectsphere.dlx" } }],
    ]);
    expect(channel.bindQueue.mock.calls).toEqual([
      ["notification-service.dlq", "connectsphere.dlx", "#"],
      ["notification-service", "connectsphere.events", "#"],
    ]);
    expect(channel.prefetch).toHaveBeenCalledWith(1);
    expect(channel.consume).toHaveBeenCalledWith("notification-service", expect.any(Function));
  });

  it("acks only after the handler has finished", async () => {
    let finish!: () => void;
    const handler = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { deliver } = await startConsumer(handler);
    const delivered = delivery(JSON.stringify(msg));

    deliver(delivered);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(msg));
    expect(channel.ack).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(channel.ack).toHaveBeenCalledWith(delivered));
    expect(channel.nack).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      `notification-service: consumed "booking.withdrawn" from RabbitMQ (messageId=${msg.messageId})`,
    );
  });

  it("nacks without requeue when the handler throws, sending the message to the DLQ", async () => {
    const failure = new Error("insert failed");
    const { deliver } = await startConsumer(vi.fn().mockRejectedValue(failure));
    const delivered = delivery(JSON.stringify(msg));

    deliver(delivered);

    await vi.waitFor(() => expect(channel.nack).toHaveBeenCalledWith(delivered, false, false));
    expect(channel.ack).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("notification-service: failed to process message, sending to DLQ", failure);
  });

  it("nacks a message that isn't JSON without calling the handler", async () => {
    const { deliver, handler } = await startConsumer();
    const delivered = delivery("{not json");

    deliver(delivered);

    await vi.waitFor(() => expect(channel.nack).toHaveBeenCalledWith(delivered, false, false));
    expect(handler).not.toHaveBeenCalled();
  });

  it("reads the message as UTF-8", async () => {
    const { deliver, handler } = await startConsumer();
    const toSend = { ...msg, data: { eventName: "Café × Gala" } };

    deliver(delivery(JSON.stringify(toSend)));

    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(toSend));
  });

  it("ignores the null delivery amqplib sends when a consumer is cancelled", async () => {
    const { deliver, handler } = await startConsumer();

    deliver(null);
    await new Promise((resolve) => setImmediate(resolve));

    expect(handler).not.toHaveBeenCalled();
    expect(channel.ack).not.toHaveBeenCalled();
    expect(channel.nack).not.toHaveBeenCalled();
  });

  // amqplib emits "error" when the broker drops; with no listener Node throws it and the whole service dies.
  it.each([
    ["connection", connection, "notification-service: RabbitMQ connection error"],
    ["channel", channel, "notification-service: RabbitMQ channel error"],
  ])("logs a %s error instead of crashing", async (_name, emitter, logged) => {
    await startConsumer();

    const listener = emitter.on.mock.calls.find(([event]) => event === "error")?.[1] as (err: Error) => void;
    expect(listener).toBeTypeOf("function");
    const err = new Error("broker went away");
    listener(err);

    expect(console.error).toHaveBeenCalledWith(logged, err);
  });

  // ack and nack throw once the channel has closed. Thrown from here, that is an unhandled rejection, which ends the process.
  it("logs instead of crashing when the channel closed before an ack", async () => {
    const closed = new Error("Channel closed");
    channel.ack.mockImplementation(() => {
      throw closed;
    });
    const { deliver } = await startConsumer();

    deliver(delivery(JSON.stringify(msg)));

    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith("notification-service: RabbitMQ channel closed before the message was settled", closed),
    );
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it("logs instead of crashing when the channel closed before a nack", async () => {
    const closed = new Error("Channel closed");
    channel.nack.mockImplementation(() => {
      throw closed;
    });
    const { deliver } = await startConsumer(vi.fn().mockRejectedValue(new Error("insert failed")));

    deliver(delivery(JSON.stringify(msg)));

    await vi.waitFor(() =>
      expect(console.error).toHaveBeenCalledWith("notification-service: RabbitMQ channel closed before the message was settled", closed),
    );
  });

  it("stop closes the channel and the connection", async () => {
    const { consumer } = await startConsumer();
    await consumer.stop();
    expect(channel.close).toHaveBeenCalledOnce();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it("stop is harmless before start", async () => {
    await connectAndConsume("amqp://test", vi.fn()).stop();
    expect(channel.close).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
  });
});
