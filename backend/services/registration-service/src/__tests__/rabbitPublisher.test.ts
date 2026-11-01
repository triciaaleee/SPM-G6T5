import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const channel = { assertExchange: vi.fn(), publish: vi.fn(), on: vi.fn() };
const connection = { createChannel: vi.fn(), on: vi.fn() };
const connect = vi.fn();

vi.mock("amqplib", () => ({ default: { connect: (...args: unknown[]) => connect(...args) } }));

import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";
import { getPublisher, setPublisherForTest, type OutboundMessage } from "../lib/rabbitPublisher.js";

const msg: OutboundMessage = {
  type: "registration.confirmed",
  eventId: 7,
  actorId: "ATT-1",
  recipients: { userIds: ["ATT-1"], roles: [] },
  data: { eventName: "Gala" },
};

beforeEach(() => {
  vi.clearAllMocks();
  connect.mockResolvedValue(connection);
  connection.createChannel.mockResolvedValue(channel);
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
    expect(key).toBe("registration.confirmed");
    expect(opts).toEqual({ persistent: true });
    const envelope = JSON.parse(buf.toString());
    expect(envelope).toEqual({
      messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      type: "registration.confirmed",
      occurredAt: "2026-10-28T04:00:00.000Z",
      publisher: "registration-service",
      actorId: "ATT-1",
      eventId: 7,
      recipients: msg.recipients,
      data: msg.data,
    });
    expect(console.log).toHaveBeenCalledWith(
      `registration-service: published "registration.confirmed" to RabbitMQ (messageId=${envelope.messageId})`,
    );
  });

  it("reuses the connection and channel across publishes", async () => {
    const pub = getPublisher();
    await pub.publish(msg);
    await pub.publish(msg);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(channel.publish).toHaveBeenCalledTimes(2);
  });

  it("returns false (never throws) when the broker is unreachable, then retries a fresh connection", async () => {
    const failure = new Error("ECONNREFUSED");
    connect.mockRejectedValueOnce(failure);
    const pub = getPublisher();
    expect(await pub.publish(msg)).toBe(false);
    expect(console.error).toHaveBeenCalledWith('registration-service: failed to publish "registration.confirmed"', failure);
    expect(await pub.publish(msg)).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("returns false when channel.publish throws and starts again next time", async () => {
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

  // amqplib emits "error" when the broker drops; with no listener Node throws it and the whole service dies.
  it.each([
    ["connection", connection, "registration-service: RabbitMQ connection error"],
    ["channel", channel, "registration-service: RabbitMQ channel error"],
  ])("logs a %s error instead of crashing", async (_name, emitter, logged) => {
    await getPublisher().publish(msg);
    const listener = emitter.on.mock.calls.find(([event]) => event === "error")?.[1];
    expect(listener).toBeTypeOf("function");
    const err = new Error("ECONNRESET");
    listener(err);
    expect(console.error).toHaveBeenCalledWith(logged, err);
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
  it("records what was published, without a live broker (M12)", async () => {
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
