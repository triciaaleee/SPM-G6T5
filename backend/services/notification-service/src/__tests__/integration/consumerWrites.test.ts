/**
 * Real-DB integration: what the RabbitMQ consumer's handler writes. The broker
 * and user-service aren't involved (the handler takes the message and the role
 * lookup as arguments), so this checks the handler against the real columns and
 * the real unique index, which the mocked unit suite can't.
 */
import "../../lib/env.js";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { handleInboundMessage } from "../../lib/notificationFromMessage.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { buildMsg, recipient, rowsFor, teardown } from "./helpers.js";

const deps = (resolveRoleUserIds: (role: string) => Promise<string[]> = async () => []) => ({
  supabase: supabaseAdmin,
  resolveRoleUserIds,
});

describe("consumer writes (real Supabase project)", () => {
  afterAll(teardown);

  it("saves every column, including a text actor id (migration 0032)", async () => {
    const msg = buildMsg({ recipients: { userIds: [recipient("columns")], roles: [] } });

    await handleInboundMessage(msg, deps());

    const rows = await rowsFor(msg.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: recipient("columns"),
      type: "booking.decided",
      title: "ZINT Hall — booking approved",
      body: "ZINT Hall is approved for ZINT Gala.",
      link: "/events/7",
      event_id: 7,
      message_id: msg.messageId,
      actor_id: "COORD-0003",
      read_at: null,
    });
    expect(new Date(rows[0].occurred_at).toISOString()).toBe("2026-10-10T08:15:00.000Z");
    expect(rows[0].created_at).toEqual(expect.any(String));
  });

  it("saves a message with no event and no actor", async () => {
    const msg = buildMsg({ eventId: null, actorId: null, recipients: { userIds: [recipient("nulls")], roles: [] } });

    await handleInboundMessage(msg, deps());

    expect((await rowsFor(msg.messageId))[0]).toMatchObject({ event_id: null, actor_id: null, link: null });
  });

  it("fans one message out to direct and role recipients, once each", async () => {
    const [a, b, lead] = [recipient("fan-a"), recipient("fan-b"), recipient("fan-lead")];
    const msg = buildMsg({ recipients: { userIds: [a, b], roles: ["coordinator_lead"] } });

    await handleInboundMessage(msg, deps(async () => [b, lead]));

    const rows = await rowsFor(msg.messageId);
    expect(rows.map((r) => r.recipient_id)).toEqual([a, b, lead]);
  });

  it("writes nothing more when the message is redelivered (M5)", async () => {
    const msg = buildMsg({ recipients: { userIds: [recipient("redelivered")], roles: [] } });

    await handleInboundMessage(msg, deps());
    await handleInboundMessage(msg, deps());

    expect(await rowsFor(msg.messageId)).toHaveLength(1);
  });

  it("the unique index refuses the same message twice for one recipient", async () => {
    const row = { recipient_id: recipient("unique"), type: "t", title: "t", body: "b", message_id: randomUUID() };

    expect((await supabaseAdmin.from("notifications").insert(row)).error).toBeNull();
    const second = await supabaseAdmin.from("notifications").insert(row);

    expect(second.error?.code).toBe("23505");
  });

  it("the unique index leaves rows with no message id alone", async () => {
    const row = { recipient_id: recipient("no-message-id"), type: "t", title: "t", body: "b", message_id: null };

    expect((await supabaseAdmin.from("notifications").insert(row)).error).toBeNull();
    expect((await supabaseAdmin.from("notifications").insert(row)).error).toBeNull();
  });

  it("throws on a message id that isn't a uuid, so the consumer dead-letters it", async () => {
    const msg = buildMsg({ messageId: "not-a-uuid" });
    await expect(handleInboundMessage(msg, deps())).rejects.toMatchObject({ code: "22P02" });
  });

  it("throws and writes nothing when a role lookup fails", async () => {
    const msg = buildMsg({ recipients: { userIds: [recipient("role-fail")], roles: ["coordinator_lead"] } });

    await expect(
      handleInboundMessage(msg, deps(() => Promise.reject(new Error("user-service is down")))),
    ).rejects.toThrow("user-service is down");

    expect(await rowsFor(msg.messageId)).toHaveLength(0);
  });

  it("writes nothing for a type with no template, or one nobody is notified about", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unknown = buildMsg({ type: "something.unknown" });
    const skipped = buildMsg({ type: "event.rescheduled" });

    await handleInboundMessage(unknown, deps());
    await handleInboundMessage(skipped, deps());

    expect(await rowsFor(unknown.messageId)).toHaveLength(0);
    expect(await rowsFor(skipped.messageId)).toHaveLength(0);
    warn.mockRestore();
  });
});
