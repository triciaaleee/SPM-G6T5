import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const channel = {
  assertExchange: vi.fn(),
  publish: vi.fn(),
};
const connection = { createChannel: vi.fn(), on: vi.fn() };
const connect = vi.fn();

vi.mock("amqplib", () => ({ default: { connect: (...args: unknown[]) => connect(...args) } }));

import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";
import { getPublisher, setPublisherForTest, type OutboundMessage } from "../lib/rabbitPublisher.js";

const msg: OutboundMessage = {
  type: "message.sent",
  eventId: 7,
  actorId: "ORG-1",
  recipients: { userIds: ["COORD-1"], roles: [] },
  data: { preview: "hi" },
};

beforeEach(() => {
  vi.clearAllMocks();
  connect.mockResolvedValue(connection);
  connection.createChannel.mockResolvedValue(channel);
  channel.assertExchange.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  setPublisherForTest(undefined);
});

afterEach(() => {
  delete process.env.RABBITMQ_URL;
  setPublisherForTest(undefined);
  vi.restoreAllMocks();
});

describe("getPublisher without RABBITMQ_URL", () => {
  it("is a no-op that reports success and never connects", async () => {
    expect(await getPublisher().publish(msg)).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });

  it("caches the publisher instance", () => {
    expect(getPublisher()).toBe(getPublisher());
  });
});

describe("getPublisher with RABBITMQ_URL", () => {
  beforeEach(() => {
    process.env.RABBITMQ_URL = "amqp://test";
  });

  it("connects lazily, asserts the topic exchange and publishes the envelope", async () => {
    const pub = getPublisher();
    expect(connect).not.toHaveBeenCalled();
    expect(await pub.publish(msg)).toBe(true);

    expect(connect).toHaveBeenCalledWith("amqp://test");
    expect(channel.assertExchange).toHaveBeenCalledWith("connectsphere.events", "topic", { durable: true });
    const [exchange, key, buf, opts] = channel.publish.mock.calls[0];
    expect(exchange).toBe("connectsphere.events");
    expect(key).toBe("message.sent");
    expect(opts).toEqual({ persistent: true });
    const envelope = JSON.parse(buf.toString());
    expect(envelope).toMatchObject({
      type: "message.sent",
      publisher: "chat-service",
      actorId: "ORG-1",
      eventId: 7,
      recipients: msg.recipients,
      data: msg.data,
    });
    expect(envelope.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(console.log).toHaveBeenCalledWith(`chat-service: published "message.sent" to RabbitMQ (messageId=${envelope.messageId})`);
    expect(new Date(envelope.occurredAt).toString()).not.toBe("Invalid Date");
  });

  it("reuses the connection and channel across publishes", async () => {
    const pub = getPublisher();
    await pub.publish(msg);
    await pub.publish(msg);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(channel.publish).toHaveBeenCalledTimes(2);
  });

  it("returns false (never throws) when the broker is unreachable, then retries a fresh connection", async () => {
    connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const pub = getPublisher();
    expect(await pub.publish(msg)).toBe(false);
    expect(console.error).toHaveBeenCalledWith('chat-service: failed to publish "message.sent"', expect.any(Error));
    expect(await pub.publish(msg)).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("returns false when channel.publish throws and resets the channel", async () => {
    channel.publish.mockImplementationOnce(() => {
      throw new Error("channel closed");
    });
    const pub = getPublisher();
    expect(await pub.publish(msg)).toBe(false);
    expect(await pub.publish(msg)).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe("connection lifecycle", () => {
  beforeEach(() => {
    process.env.RABBITMQ_URL = "amqp://test";
  });

  it("registers an error listener so a dropped broker cannot crash the process", async () => {
    await getPublisher().publish(msg);
    const onError = connection.on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(onError).toBeTypeOf("function");
    expect(() => onError(new Error("ECONNRESET"))).not.toThrow();
    expect(console.error).toHaveBeenCalledWith("chat-service: RabbitMQ connection error", expect.any(Error));
  });

  it("reconnects on the next publish after the connection closes", async () => {
    const pub = getPublisher();
    await pub.publish(msg);
    connection.on.mock.calls.find(([event]) => event === "close")![1]();
    await pub.publish(msg);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe("createFakePublisher / setPublisherForTest", () => {
  it("records published messages", async () => {
    const fake = createFakePublisher();
    expect(await fake.publish(msg)).toBe(true);
    expect(fake.published).toEqual([msg]);
  });

  it("setPublisherForTest swaps the active publisher", async () => {
    const fake = createFakePublisher();
    setPublisherForTest(fake);
    await getPublisher().publish(msg);
    expect(fake.published).toHaveLength(1);
  });
});
