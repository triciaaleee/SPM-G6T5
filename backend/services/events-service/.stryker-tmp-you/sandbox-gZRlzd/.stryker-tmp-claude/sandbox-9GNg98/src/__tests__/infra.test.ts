// @ts-nocheck
// 
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Each test imports the module fresh: env.ts, supabaseAdmin.ts and getPublisher() all act at import time or cache. */
beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.doUnmock("dotenv");
  vi.doUnmock("@supabase/supabase-js");
  vi.doUnmock("amqplib");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("lib/env", () => {
  it("loads the shared backend/.env, relative to the service folder", async () => {
    const config = vi.fn();
    vi.doMock("dotenv", () => ({ default: { config } }));
    await import("../lib/env.js");
    expect(config).toHaveBeenCalledExactlyOnceWith({ path: "../../.env" });
  });
});

describe("lib/supabaseAdmin", () => {
  it("builds a service-role client with sessions switched off", async () => {
    const createClient = vi.fn().mockReturnValue({ marker: "client" });
    vi.doMock("@supabase/supabase-js", () => ({ createClient }));
    vi.stubEnv("SUPABASE_URL", "http://db.example");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    const { supabaseAdmin } = await import("../lib/supabaseAdmin.js");
    expect(supabaseAdmin).toEqual({ marker: "client" });
    expect(createClient).toHaveBeenCalledWith("http://db.example", "service-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it("falls back to empty strings when the env vars are unset", async () => {
    const createClient = vi.fn().mockReturnValue({});
    vi.doMock("@supabase/supabase-js", () => ({ createClient }));
    vi.stubEnv("SUPABASE_URL", undefined as never);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined as never);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await import("../lib/supabaseAdmin.js");
    expect(createClient.mock.calls[0].slice(0, 2)).toEqual(["", ""]);
  });
});

describe("lib/rabbitPublisher", () => {
  const msg = {
    type: "request.submitted",
    eventId: 3,
    actorId: "ORG-1",
    recipients: { userIds: ["ORG-1"], roles: [] },
    data: { eventName: "Gala" },
  };

  function mockAmqp(options: { connectError?: Error; confirmError?: Error } = {}) {
    const publish = vi.fn((_ex, _key, _buf, _opts, cb: (err?: Error) => void) => cb(options.confirmError));
    const channel = { assertExchange: vi.fn().mockResolvedValue(undefined), publish };
    const connection = { createConfirmChannel: vi.fn().mockResolvedValue(channel) };
    const connect = options.connectError
      ? vi.fn().mockRejectedValue(options.connectError)
      : vi.fn().mockResolvedValue(connection);
    vi.doMock("amqplib", () => ({ default: { connect } }));
    return { connect, connection, channel, publish };
  }

  it("is a silent no-op that reports success when RABBITMQ_URL is unset", async () => {
    delete process.env.RABBITMQ_URL;
    const { connect } = mockAmqp();
    const { getPublisher } = await import("../lib/rabbitPublisher.js");
    expect(await getPublisher().publish(msg)).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });

  it("returns the same publisher on every call and honours a test override", async () => {
    delete process.env.RABBITMQ_URL;
    mockAmqp();
    const { getPublisher, setPublisherForTest } = await import("../lib/rabbitPublisher.js");
    expect(getPublisher()).toBe(getPublisher());
    const fake = { publish: vi.fn() };
    setPublisherForTest(fake);
    expect(getPublisher()).toBe(fake);
    setPublisherForTest(undefined);
    expect(getPublisher()).not.toBe(fake);
  });

  it("connects once, declares the topic exchange and publishes a confirmed, persistent envelope", async () => {
    vi.stubEnv("RABBITMQ_URL", "amqp://broker");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const logged = vi.spyOn(console, "log");
    const { connect, channel, publish } = mockAmqp();
    const { getPublisher } = await import("../lib/rabbitPublisher.js");
    const publisher = getPublisher();

    expect(await publisher.publish(msg)).toBe(true);
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/^events-service: published "request\.submitted" to RabbitMQ \(messageId=[0-9a-f-]{36}\)$/));
    expect(await publisher.publish({ ...msg, messageId: "m-1", occurredAt: "2026-01-01T00:00:00Z" })).toBe(true);

    expect(connect).toHaveBeenCalledExactlyOnceWith("amqp://broker");
    expect(channel.assertExchange).toHaveBeenCalledExactlyOnceWith("connectsphere.events", "topic", { durable: true });
    const [exchange, key, body, options] = publish.mock.calls[0];
    expect([exchange, key, options]).toEqual(["connectsphere.events", "request.submitted", { persistent: true }]);
    const first = JSON.parse(body.toString());
    expect(first).toMatchObject({ type: "request.submitted", publisher: "events-service", actorId: "ORG-1", eventId: 3, data: { eventName: "Gala" } });
    expect(first.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(first.occurredAt))).toBe(false);
    const second = JSON.parse(publish.mock.calls[1][2].toString());
    expect(second).toMatchObject({ messageId: "m-1", occurredAt: "2026-01-01T00:00:00Z" });
  });

  it("returns false and retries on a fresh connection after a connect failure", async () => {
    vi.stubEnv("RABBITMQ_URL", "amqp://broker");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { connect } = mockAmqp({ connectError: new Error("ECONNREFUSED") });
    const { getPublisher } = await import("../lib/rabbitPublisher.js");
    const publisher = getPublisher();
    expect(await publisher.publish(msg)).toBe(false);
    expect(await publisher.publish(msg)).toBe(false);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("returns false when the broker doesn't confirm the message", async () => {
    vi.stubEnv("RABBITMQ_URL", "amqp://broker");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockAmqp({ confirmError: new Error("nack") });
    const { getPublisher } = await import("../lib/rabbitPublisher.js");
    expect(await getPublisher().publish(msg)).toBe(false);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('"request.submitted"'), expect.any(Error));
  });
});
