import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const channel = { assertExchange: vi.fn(), publish: vi.fn() };
const connect = vi.fn();
vi.mock("amqplib", () => ({ default: { connect: (...a: unknown[]) => connect(...a) } }));

import { getPublisher, setPublisherForTest } from "../lib/rabbitPublisher.js";

const msg = {
  type: "booking.requested",
  eventId: 7,
  actorId: "COORD-0001",
  recipients: { userIds: ["VEN-0001"], roles: [] as string[] },
  data: { venueName: "Grand Ballroom" },
};

describe("getPublisher", () => {
  const original = process.env.RABBITMQ_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    connect.mockResolvedValue({ createChannel: async () => channel });
    setPublisherForTest(undefined);
  });

  afterEach(() => {
    process.env.RABBITMQ_URL = original;
    if (original === undefined) delete process.env.RABBITMQ_URL;
    setPublisherForTest(undefined);
  });

  it("is a no-op that still reports success when RABBITMQ_URL is unset", async () => {
    delete process.env.RABBITMQ_URL;

    expect(await getPublisher().publish(msg)).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });

  it("publishes a persistent envelope to the topic exchange, keyed by type", async () => {
    process.env.RABBITMQ_URL = "amqp://test";

    expect(await getPublisher().publish(msg)).toBe(true);

    const [exchange, key, body, opts] = channel.publish.mock.calls[0];
    expect(exchange).toBe("connectsphere.events");
    expect(key).toBe("booking.requested");
    expect(opts).toEqual({ persistent: true });
    expect(JSON.parse(body.toString())).toMatchObject({
      type: "booking.requested",
      publisher: "venue-service",
      actorId: "COORD-0001",
      eventId: 7,
      recipients: msg.recipients,
      data: msg.data,
      messageId: expect.any(String),
      occurredAt: expect.any(String),
    });
  });

  it("declares the exchange durable, and logs each publish and each failure", async () => {
    process.env.RABBITMQ_URL = "amqp://test";
    await getPublisher().publish(msg);
    expect(channel.assertExchange).toHaveBeenCalledWith("connectsphere.events", "topic", { durable: true });
    const envelope = JSON.parse(channel.publish.mock.calls[0][2].toString());
    expect(console.log).toHaveBeenCalledWith(`venue-service: published "booking.requested" to RabbitMQ (messageId=${envelope.messageId})`);

    const boom = new Error("ECONNREFUSED");
    connect.mockRejectedValueOnce(boom);
    setPublisherForTest(undefined);
    await getPublisher().publish(msg);
    expect(console.error).toHaveBeenCalledWith('venue-service: failed to publish "booking.requested"', boom);
  });

  it("connects once and reuses the channel for later publishes", async () => {
    process.env.RABBITMQ_URL = "amqp://test";
    const publisher = getPublisher();

    await publisher.publish(msg);
    await publisher.publish(msg);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(channel.publish).toHaveBeenCalledTimes(2);
  });

  it("resolves false instead of throwing when the broker is down, then retries a fresh connection", async () => {
    process.env.RABBITMQ_URL = "amqp://test";
    connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const publisher = getPublisher();

    expect(await publisher.publish(msg)).toBe(false);
    expect(await publisher.publish(msg)).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("returns the same publisher on repeated calls until a test swaps it", () => {
    expect(getPublisher()).toBe(getPublisher());
  });
});
