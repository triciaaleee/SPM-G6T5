/**
 * Real-DB integration test for chat-service. Runs the real Express router, the
 * real auth middleware and real JWT verification against the real (shared dev)
 * Supabase project. Only events-service is stubbed: a tiny local HTTP server
 * stands in for it (EVENTS_SERVICE_URL), because chat-service never reads the
 * events table itself and starting the whole events-service is out of scope.
 *
 * Seeds throwaway users ("ZINT-" id prefix, which can never collide with a
 * generate_user_id()-issued id) and one events row. Everything is deleted in
 * afterAll regardless of outcome (chat_messages cascade off the event row).
 * Run via `npx vitest run --config vitest.integration.config.ts`.
 */
import "../../lib/env.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatRouter, sendLimiter } from "../../routes/chatMessages.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { setPublisherForTest } from "../../lib/rabbitPublisher.js";
import { createFakePublisher } from "../../lib/rabbitPublisher.fake.js";

const STAMP = Date.now();
const ORG_ID = `ZINT-ORG-${STAMP}`;
const COORD_ID = `ZINT-COORD-${STAMP}`;
const OTHER_COORD_ID = `ZINT-OCOORD-${STAMP}`;
const OTHER_ORG_ID = `ZINT-OORG-${STAMP}`;

const token = (id: string, role: string) => jwt.sign({ sub: id, role }, process.env.JWT_SECRET!, { expiresIn: "10m" });
const orgAuth = `Bearer ${token(ORG_ID, "organiser")}`;
const coordAuth = `Bearer ${token(COORD_ID, "coordinator")}`;

let eventId: number;
let eventStatus = "Planning";
let eventCoordinator: string | null = COORD_ID;
let stub: http.Server;
let eventsRequests: { url: string; auth: string | undefined }[] = [];
const publisher = createFakePublisher();

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/chat", chatRouter);
  return app;
}

async function seedUser(id: string, role: string) {
  const { error } = await supabaseAdmin.from("users").insert({
    id,
    name: `Integration ${role}`,
    email: `${id.toLowerCase()}@example.com`,
    password_hash: "unused-placeholder",
    role,
  });
  if (error) throw new Error(`seed user ${id}: ${error.message}`);
}

describe("chat-service integration (real Supabase project, stubbed events-service)", () => {
  beforeAll(async () => {
    await seedUser(ORG_ID, "organiser");
    await seedUser(COORD_ID, "coordinator");
    await seedUser(OTHER_COORD_ID, "coordinator");
    await seedUser(OTHER_ORG_ID, "organiser");

    const { data, error } = await supabaseAdmin
      .from("events")
      .insert({
        organiser_id: ORG_ID,
        coordinator_id: COORD_ID,
        status: "Planning",
        submitted_details: { name: "Integration Gala" },
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`seed event: ${error?.message}`);
    eventId = data.id;

    stub = http.createServer((req, res) => {
      eventsRequests.push({ url: req.url ?? "", auth: req.headers.authorization });
      res.setHeader("Content-Type", "application/json");
      const event = {
        id: eventId,
        status: eventStatus,
        organiser_id: ORG_ID,
        coordinator_id: eventCoordinator,
        submitted_details: { name: "Integration Gala" },
      };
      if (req.url === `/api/events/${eventId}`) {
        res.end(JSON.stringify({ event }));
      } else if (req.url === "/api/events") {
        res.end(
          JSON.stringify({
            events: [
              {
                ...event,
                coordinator: { name: "Integration coordinator" },
                organiser: { name: "Integration organiser" },
                created_at: new Date().toISOString(),
              },
            ],
          }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    process.env.EVENTS_SERVICE_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
    setPublisherForTest(publisher);
  });

  afterAll(async () => {
    setPublisherForTest(undefined);
    await new Promise<void>((resolve) => (stub ? stub.close(() => resolve()) : resolve()));
    if (eventId) await supabaseAdmin.from("events").delete().eq("id", eventId);
    await supabaseAdmin.from("users").delete().in("id", [ORG_ID, COORD_ID, OTHER_COORD_ID, OTHER_ORG_ID]);
  });

  it("rejects requests with no / bad token before touching events-service", async () => {
    const app = buildApp();
    eventsRequests = [];
    expect((await request(app).get(`/api/chat/${eventId}/messages`)).status).toBe(401);
    expect((await request(app).get(`/api/chat/${eventId}/messages`).set("Authorization", "Bearer junk")).status).toBe(401);
    expect(eventsRequests).toHaveLength(0);
  });

  it("starts with an empty thread", async () => {
    const res = await request(buildApp()).get(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.event).toMatchObject({ id: eventId, name: "Integration Gala", status: "Planning" });
    expect(res.body).toMatchObject({ hasMore: false, nextBefore: null });
  });

  it("forwards the caller's own bearer token to events-service", async () => {
    eventsRequests = [];
    await request(buildApp()).get(`/api/chat/${eventId}/messages`).set("Authorization", coordAuth);
    expect(eventsRequests[0]).toEqual({ url: `/api/events/${eventId}`, auth: coordAuth });
  });

  it("persists a message the organiser sends and notifies the coordinator", async () => {
    const res = await request(buildApp())
      .post(`/api/chat/${eventId}/messages`)
      .set("Authorization", orgAuth)
      .send({ body: "  Is the stage ready?  " });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatchObject({ body: "Is the stage ready?", senderId: ORG_ID, senderRole: "organiser", mine: true });
    expect(res.body.notified).toBe(true);

    const { data } = await supabaseAdmin.from("chat_messages").select("*").eq("event_id", eventId);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ sender_id: ORG_ID, sender_role: "organiser", body: "Is the stage ready?", read_at: null });

    expect(publisher.published.at(-1)).toMatchObject({
      type: "message.sent",
      eventId,
      actorId: ORG_ID,
      recipients: { userIds: [COORD_ID], roles: [] },
    });
  });

  it("shows the coordinator the message as unread, then marks it read", async () => {
    const app = buildApp();
    const before = await request(app).get(`/api/chat/${eventId}/messages`).set("Authorization", coordAuth);
    expect(before.body.unreadCount).toBe(1);
    expect(before.body.messages[0].mine).toBe(false);

    const threads = await request(app).get("/api/chat/threads").set("Authorization", coordAuth);
    expect(threads.status).toBe(200);
    expect(threads.body.threads).toHaveLength(1);
    expect(threads.body.threads[0]).toMatchObject({
      eventId,
      unreadCount: 1,
      otherParty: "Integration organiser",
      lastMessage: { body: "Is the stage ready?", senderId: ORG_ID },
    });

    expect((await request(app).post(`/api/chat/${eventId}/read`).set("Authorization", coordAuth)).status).toBe(204);

    const after = await request(app).get(`/api/chat/${eventId}/messages`).set("Authorization", coordAuth);
    expect(after.body.unreadCount).toBe(0);
    const { data } = await supabaseAdmin.from("chat_messages").select("read_at").eq("event_id", eventId);
    expect(data![0].read_at).not.toBeNull();
  });

  it("does not mark the sender's own messages read when the sender opens the thread", async () => {
    await request(buildApp()).post(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth).send({ body: "Second" });
    await request(buildApp()).post(`/api/chat/${eventId}/read`).set("Authorization", orgAuth);
    const { data } = await supabaseAdmin.from("chat_messages").select("body, read_at").eq("event_id", eventId).eq("body", "Second");
    expect(data![0].read_at).toBeNull();
  });

  it("lets the coordinator reply and orders history oldest-first", async () => {
    const app = buildApp();
    const sent = await request(app).post(`/api/chat/${eventId}/messages`).set("Authorization", coordAuth).send({ body: "Yes, ready." });
    expect(sent.status).toBe(201);
    expect(publisher.published.at(-1)?.recipients.userIds).toEqual([ORG_ID]);

    const history = await request(app).get(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth);
    expect(history.body.messages.map((m: any) => m.body)).toEqual(["Is the stage ready?", "Second", "Yes, ready."]);
  });

  it("blocks a non-participating coordinator and organiser", async () => {
    const app = buildApp();
    const otherCoord = `Bearer ${token(OTHER_COORD_ID, "coordinator")}`;
    const otherOrg = `Bearer ${token(OTHER_ORG_ID, "organiser")}`;
    expect((await request(app).get(`/api/chat/${eventId}/messages`).set("Authorization", otherCoord)).status).toBe(403);
    expect((await request(app).get(`/api/chat/${eventId}/messages`).set("Authorization", otherOrg)).status).toBe(403);
    expect((await request(app).post(`/api/chat/${eventId}/messages`).set("Authorization", otherCoord).send({ body: "hi" })).status).toBe(403);
    const threads = await request(app).get("/api/chat/threads").set("Authorization", otherCoord);
    expect(threads.body.threads).toEqual([]);
  });

  it("blocks sending to another role (attendee) with 403", async () => {
    const res = await request(buildApp())
      .post(`/api/chat/${eventId}/messages`)
      .set("Authorization", `Bearer ${token("A-1", "attendee")}`)
      .send({ body: "hi" });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid body without writing", async () => {
    const app = buildApp();
    const { count: before } = await supabaseAdmin.from("chat_messages").select("*", { count: "exact", head: true }).eq("event_id", eventId);
    expect((await request(app).post(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth).send({ body: "   " })).status).toBe(400);
    expect((await request(app).post(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth).send({ body: "a".repeat(2001) })).status).toBe(400);
    const { count: after } = await supabaseAdmin.from("chat_messages").select("*", { count: "exact", head: true }).eq("event_id", eventId);
    expect(after).toBe(before);
  });

  it("stores messages with HTML-like content verbatim (no server-side escaping)", async () => {
    const res = await request(buildApp())
      .post(`/api/chat/${eventId}/messages`)
      .set("Authorization", orgAuth)
      .send({ body: "<script>alert(1)</script>" });
    expect(res.status).toBe(201);
    expect(res.body.message.body).toBe("<script>alert(1)</script>");
  });

  it("hides the thread and blocks sending while the event is outside Planning/Confirmed, but keeps the messages", async () => {
    const app = buildApp();
    eventStatus = "Safety Review";
    expect((await request(app).get(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth)).status).toBe(409);
    expect((await request(app).post(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth).send({ body: "x" })).status).toBe(409);
    expect((await request(app).get("/api/chat/threads").set("Authorization", orgAuth)).body.threads).toEqual([]);

    eventStatus = "Confirmed";
    const back = await request(app).get(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth);
    expect(back.status).toBe(200);
    expect(back.body.messages.length).toBeGreaterThanOrEqual(3);
    eventStatus = "Planning";
  });

  it("keeps chat open while the event is in Needs Review", async () => {
    const app = buildApp();
    eventStatus = "Needs Review";
    expect((await request(app).get(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth)).status).toBe(200);
    expect((await request(app).post(`/api/chat/${eventId}/messages`).set("Authorization", coordAuth).send({ body: "Settling the venue change" })).status).toBe(201);
    expect((await request(app).get("/api/chat/threads").set("Authorization", orgAuth)).body.threads).toHaveLength(1);
    eventStatus = "Planning";
  });

  it("pages real history newest-first with a working cursor and whole-thread unread count", async () => {
    const app = buildApp();
    const all = await request(app).get(`/api/chat/${eventId}/messages?limit=200`).set("Authorization", orgAuth);
    const total = all.body.messages.length;
    expect(total).toBeGreaterThanOrEqual(4);

    const first = await request(app).get(`/api/chat/${eventId}/messages?limit=2`).set("Authorization", orgAuth);
    expect(first.body.messages.map((m: any) => m.id)).toEqual(all.body.messages.slice(-2).map((m: any) => m.id));
    expect(first.body.hasMore).toBe(true);
    expect(first.body.unreadCount).toBe(all.body.unreadCount);

    const older = await request(app)
      .get(`/api/chat/${eventId}/messages?limit=2&before=${first.body.nextBefore}`)
      .set("Authorization", orgAuth);
    expect(older.body.messages.map((m: any) => m.id)).toEqual(all.body.messages.slice(-4, -2).map((m: any) => m.id));
    expect(older.body.messages.every((m: any) => m.id < first.body.nextBefore)).toBe(true);
  });

  it("rate-limits sends per user with a 429 and Retry-After", async () => {
    const app = buildApp();
    process.env.CHAT_SEND_LIMIT_PER_MINUTE = "1";
    sendLimiter.reset();
    try {
      expect((await request(app).post(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth).send({ body: "one" })).status).toBe(201);
      const blocked = await request(app).post(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth).send({ body: "two" });
      expect(blocked.status).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
      const { data } = await supabaseAdmin.from("chat_messages").select("body").eq("event_id", eventId).eq("body", "two");
      expect(data).toHaveLength(0);
    } finally {
      delete process.env.CHAT_SEND_LIMIT_PER_MINUTE;
      sendLimiter.reset();
    }
  });

  it("409s for the organiser when no coordinator is assigned", async () => {
    eventCoordinator = null;
    const res = await request(buildApp()).get(`/api/chat/${eventId}/messages`).set("Authorization", orgAuth);
    expect(res.status).toBe(409);
    eventCoordinator = COORD_ID;
  });

  it("the database itself refuses a blank body (check constraint backs up the API)", async () => {
    const { error } = await supabaseAdmin.from("chat_messages").insert({ event_id: eventId, sender_id: ORG_ID, sender_role: "organiser", body: "   " });
    expect(error).not.toBeNull();
  });

  it("the database refuses a sender_role outside organiser/coordinator", async () => {
    const { error } = await supabaseAdmin.from("chat_messages").insert({ event_id: eventId, sender_id: ORG_ID, sender_role: "attendee", body: "x" });
    expect(error).not.toBeNull();
  });

  it("the database refuses a message for a non-existent event (FK)", async () => {
    const { error } = await supabaseAdmin.from("chat_messages").insert({ event_id: 2147483000, sender_id: ORG_ID, sender_role: "organiser", body: "x" });
    expect(error).not.toBeNull();
  });
});
