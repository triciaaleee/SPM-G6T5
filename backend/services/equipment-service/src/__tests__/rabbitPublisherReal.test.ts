import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_NOW } from "./helpers/testClock.js";

const { connect, channel, connection } = vi.hoisted(() => {
  const channel = { assertExchange: vi.fn(async () => {}), publish: vi.fn(() => true) };
  const connection = { createChannel: vi.fn(async () => channel) };
  return { connect: vi.fn(async (..._a: unknown[]) => connection), channel, connection };
});
vi.mock("amqplib", () => ({ default: { connect } }));

const message = {
  type: "equipment.requested",
  eventId: 7,
  actorId: "COORD-0001",
  recipients: { userIds: ["U1"], roles: ["technical_support"] },
  data: { eventName: "Fest" },
};

async function load() {
  return import("../lib/rabbitPublisher.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("getPublisher without RABBITMQ_URL", () => {
  it("is an idle publisher that reports success and never connects", async () => {
    vi.stubEnv("RABBITMQ_URL", undefined);
    const { getPublisher } = await load();
    expect(await getPublisher().publish(message)).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });

  it("is created once and reused", async () => {
    vi.stubEnv("RABBITMQ_URL", undefined);
    const { getPublisher } = await load();
    expect(getPublisher()).toBe(getPublisher());
  });
});

describe("setPublisherForTest", () => {
  it("swaps the publisher in, and resets it when given undefined", async () => {
    vi.stubEnv("RABBITMQ_URL", undefined);
    const { getPublisher, setPublisherForTest } = await load();
    const fake = { publish: vi.fn(async () => true) };
    setPublisherForTest(fake);
    expect(getPublisher()).toBe(fake);
    setPublisherForTest(undefined);
    expect(getPublisher()).not.toBe(fake);
  });
});

describe("real publisher", () => {
  it("connects lazily, declares the topic exchange and publishes a persistent envelope", async () => {
    vi.stubEnv("RABBITMQ_URL", "amqp://broker");
    const { getPublisher } = await load();
    const publisher = getPublisher();
    expect(connect).not.toHaveBeenCalled();

    expect(await publisher.publish(message)).toBe(true);

    expect(connect).toHaveBeenCalledExactlyOnceWith("amqp://broker");
    expect(channel.assertExchange).toHaveBeenCalledExactlyOnceWith("connectsphere.events", "topic", { durable: true });
    const [exchange, key, body, options] = channel.publish.mock.calls[0] as unknown as [string, string, Buffer, object];
    expect(exchange).toBe("connectsphere.events");
    expect(key).toBe("equipment.requested");
    expect(options).toEqual({ persistent: true });
    const envelope = JSON.parse(body.toString("utf8"));
    expect(envelope).toEqual({
      messageId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      type: "equipment.requested",
      occurredAt: TEST_NOW.toISOString(),
      publisher: "equipment-service",
      actorId: "COORD-0001",
      eventId: 7,
      recipients: { userIds: ["U1"], roles: ["technical_support"] },
      data: { eventName: "Fest" },
    });
    expect(console.log).toHaveBeenCalledWith(`equipment-service: published "equipment.requested" to RabbitMQ (messageId=${envelope.messageId})`);
  });

  it("uses a caller-supplied messageId and generates a fresh one otherwise", async () => {
    vi.stubEnv("RABBITMQ_URL", "amqp://broker");
    const { getPublisher } = await load();
    const publisher = getPublisher();
    await publisher.publish({ ...message, messageId: "fixed-id" });
    await publisher.publish(message);
    await publisher.publish(message);
    const ids = channel.publish.mock.calls.map((c) => JSON.parse((c as unknown as [string, string, Buffer])[2].toString()).messageId);
    expect(ids[0]).toBe("fixed-id");
    expect(ids[1]).not.toBe(ids[2]);
  });

  it("reuses one connection and channel across publishes", async () => {
    vi.stubEnv("RABBITMQ_URL", "amqp://broker");
    const { getPublisher } = await load();
    const publisher = getPublisher();
    await publisher.publish(message);
    await publisher.publish(message);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connection.createChannel).toHaveBeenCalledTimes(1);
    expect(channel.publish).toHaveBeenCalledTimes(2);
  });

  it("returns false (never throws) when the broker is down, and reconnects next time", async () => {
    vi.stubEnv("RABBITMQ_URL", "amqp://broker");
    const { getPublisher } = await load();
    const publisher = getPublisher();
    connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    expect(await publisher.publish(message)).toBe(false);
    expect(console.error).toHaveBeenCalledWith('equipment-service: failed to publish "equipment.requested"', expect.any(Error));
    expect(channel.publish).not.toHaveBeenCalled();

    expect(await publisher.publish(message)).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("returns false when the channel rejects the publish", async () => {
    vi.stubEnv("RABBITMQ_URL", "amqp://broker");
    const { getPublisher } = await load();
    channel.publish.mockImplementationOnce(() => { throw new Error("channel closed"); });
    expect(await getPublisher().publish(message)).toBe(false);
  });
});
