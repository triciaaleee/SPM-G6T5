import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { chatRouter, sendLimiter } from "../routes/chatMessages.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { createFakeSupabase } from "./helpers/fakeSupabase.js";

// Complements chatMessages.test.ts: error branches, the unauthenticated guard,
// message truncation, fallbacks and thread ordering.

vi.mock("../middleware/auth.js", async () => ({
  requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  },
}));

const organiser = { id: "ORG-0001", role: "organiser" };
const coordinator = { id: "COORD-0001", role: "coordinator" };

const eventRow = (o: Record<string, unknown> = {}) => ({
  id: 7,
  status: "Planning",
  organiser_id: "ORG-0001",
  coordinator_id: "COORD-0001",
  submitted_details: { name: "Alumni Gala" },
  ...o,
});

function setup(
  o: {
    user?: { id: string; role: string } | undefined;
    noSupabase?: boolean;
    event?: Record<string, unknown>;
    eventHttp?: number;
    listHttp?: number;
    events?: Record<string, unknown>[];
    select?: { data: unknown; error: unknown };
    update?: { data: unknown; error: unknown };
    insert?: { data: unknown; error: unknown };
    fetchThrows?: boolean;
    nullData?: boolean;
    failWhen?: (q: { columns: string; head: boolean; limit: number | null }) => { message: string } | null;
  } = {},
) {
  const fake = createFakeSupabase({
    nullData: o.nullData,
    selectErrorWhen: o.failWhen,
    messages: (o.select?.data as Record<string, any>[] | null | undefined) ?? [],
    selectError: (o.select?.error as { message: string } | null | undefined) ?? null,
    updateError: (o.update?.error as { message: string } | null | undefined) ?? null,
    insertResult: o.insert ? { data: o.insert.data, error: o.insert.error as { message: string } | null } : undefined,
  });
  const { sel, upd, insert } = fake;
  (globalThis as any).__mockSupabase = o.noSupabase ? undefined : fake.supabase;
  (globalThis as any).__mockUser = "user" in o ? o.user : organiser;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (o.fetchThrows) throw new Error("down");
      if (url.endsWith("/api/events")) {
        const status = o.listHttp ?? 200;
        return { ok: status < 300, status, json: async () => ({ events: o.events ?? [] }) };
      }
      const status = o.eventHttp ?? 200;
      return { ok: status < 300, status, json: async () => ({ event: o.event ?? eventRow() }) };
    }),
  );

  const publish = vi.fn().mockResolvedValue(true);
  setPublisherForTest({ publish });

  const app = express();
  app.use(express.json());
  app.use("/api/chat", chatRouter);
  return { app, insert, publish, sel, upd };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setPublisherForTest(undefined);
  sendLimiter.reset();
});

const listEvent = (o: Record<string, unknown> = {}) => ({
  id: 1,
  status: "Planning",
  coordinator_id: "COORD-0001",
  coordinator: { name: "Cora" },
  organiser: { name: "Olly" },
  submitted_details: { name: "Gala" },
  created_at: "2026-01-01T00:00:00Z",
  ...o,
});

describe("role gate", () => {
  it.each(["attendee", "venue_staff", "technical_support"])("403s the %s role on every route", async (role) => {
    const { app } = setup({ user: { id: "U", role } });
    expect((await request(app).get("/api/chat/threads")).status).toBe(403);
    expect((await request(app).get("/api/chat/7/messages")).status).toBe(403);
    expect((await request(app).post("/api/chat/7/read")).status).toBe(403);
    expect((await request(app).post("/api/chat/7/messages").send({ body: "x" })).status).toBe(403);
  });

  it("403s when no user is attached at all", async () => {
    const { app } = setup({ user: undefined });
    expect((await request(app).get("/api/chat/threads")).status).toBe(403);
  });
});

describe("unauthenticated guard (supabase / user missing)", () => {
  it("401s each route when the supabase client is missing", async () => {
    const { app } = setup({ noSupabase: true });
    expect((await request(app).get("/api/chat/threads")).status).toBe(401);
    expect((await request(app).get("/api/chat/7/messages")).status).toBe(401);
    expect((await request(app).post("/api/chat/7/read")).status).toBe(401);
    expect((await request(app).post("/api/chat/7/messages").send({ body: "x" })).status).toBe(401);
  });
});

describe("event id validation", () => {
  it.each(["abc", "0", "-3", "1.5"])("400s event id %s on all three event routes", async (id) => {
    const { app } = setup();
    expect((await request(app).get(`/api/chat/${id}/messages`)).status).toBe(400);
    expect((await request(app).post(`/api/chat/${id}/read`)).status).toBe(400);
    expect((await request(app).post(`/api/chat/${id}/messages`).send({ body: "x" })).status).toBe(400);
  });
});

describe("events-service failures", () => {
  it("502s history when events-service errors", async () => {
    const { app } = setup({ eventHttp: 500 });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(502);
  });

  it("502s when events-service is unreachable", async () => {
    const { app } = setup({ fetchThrows: true });
    expect((await request(app).post("/api/chat/7/messages").send({ body: "x" })).status).toBe(502);
  });

  it("502s the inbox when the events list errors", async () => {
    const { app } = setup({ listHttp: 500 });
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Failed to load events");
  });
});

describe("access rules", () => {
  it("409s a coordinator-less event for an organiser even when the status is enabled", async () => {
    const { app } = setup({ event: eventRow({ coordinator_id: null }) });
    expect((await request(app).get("/api/chat/7/messages")).status).toBe(409);
  });

  it.each(["Draft", "Unassigned", "Requested", "Clarification Requested", "Safety Review", "Rejected", "Completed", "Cancelled"])(
    "409s a %s event",
    async (status) => {
      const { app } = setup({ event: eventRow({ status }) });
      const res = await request(app).get("/api/chat/7/messages");
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/isn't available/);
    },
  );

  it.each(["Planning", "Confirmed", "Needs Review"])("allows %s", async (status) => {
    const { app } = setup({ event: eventRow({ status }) });
    expect((await request(app).get("/api/chat/7/messages")).status).toBe(200);
  });

  it("allows the assigned coordinator", async () => {
    const { app } = setup({ user: coordinator });
    expect((await request(app).get("/api/chat/7/messages")).status).toBe(200);
  });

  it("403s the wrong coordinator before checking the status", async () => {
    const { app } = setup({ user: { id: "COORD-9999", role: "coordinator" }, event: eventRow({ status: "Rejected" }) });
    expect((await request(app).get("/api/chat/7/messages")).status).toBe(403);
  });
});

describe("GET /:eventId/messages", () => {
  it("500s when the messages query fails", async () => {
    const { app } = setup({ select: { data: null, error: { message: "boom" } } });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to load messages");
  });

  it("treats null data as no messages", async () => {
    const { app } = setup({ select: { data: null, error: null } });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.body.messages).toEqual([]);
    expect(res.body.unreadCount).toBe(0);
  });

  it("falls back to 'Event #id' when the event has no name", async () => {
    const { app } = setup({ event: eventRow({ submitted_details: {} }) });
    expect((await request(app).get("/api/chat/7/messages")).body.event.name).toBe("Event #7");
  });

  it("falls back to 'Event #id' when submitted_details is null", async () => {
    const { app } = setup({ event: eventRow({ submitted_details: null }) });
    expect((await request(app).get("/api/chat/7/messages")).body.event.name).toBe("Event #7");
  });

  it("flags only the other party's unread messages as unread and marks mine", async () => {
    const row = (id: number, sender: string, read: string | null) => ({
      id,
      event_id: 7,
      sender_id: sender,
      sender_role: sender === "ORG-0001" ? "organiser" : "coordinator",
      body: `m${id}`,
      read_at: read,
      created_at: `2026-01-0${id}T00:00:00Z`,
    });
    const { app } = setup({
      select: { data: [row(1, "COORD-0001", null), row(2, "COORD-0001", "2026-01-05T00:00:00Z"), row(3, "ORG-0001", null)], error: null },
    });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.messages.map((m: any) => m.mine)).toEqual([false, false, true]);
    // sender internals (read_at, event_id) are not leaked
    expect(res.body.messages[0]).not.toHaveProperty("read_at");
    expect(res.body.messages[0]).not.toHaveProperty("event_id");
  });
});

describe("POST /:eventId/read", () => {
  it("500s when the update fails", async () => {
    const { app } = setup({ update: { data: null, error: { message: "boom" } } });
    const res = await request(app).post("/api/chat/7/read");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to mark messages read");
  });

  it("only updates unread messages from the other party for this event", async () => {
    const { app, upd } = setup();
    const res = await request(app).post("/api/chat/7/read");
    expect(res.status).toBe(204);
    expect(upd.update).toHaveBeenCalledWith({ read_at: expect.any(String) });
    expect(upd.eq).toHaveBeenCalledWith("event_id", 7);
    expect(upd.neq).toHaveBeenCalledWith("sender_id", "ORG-0001");
    expect(upd.is).toHaveBeenCalledWith("read_at", null);
  });

  it("409s for a non-chat status", async () => {
    const { app, upd } = setup({ event: eventRow({ status: "Safety Review" }) });
    expect((await request(app).post("/api/chat/7/read")).status).toBe(409);
    expect(upd.update).not.toHaveBeenCalled();
  });
});

describe("POST /:eventId/messages", () => {
  const saved = (o: Record<string, unknown> = {}) => ({
    id: 1,
    event_id: 7,
    sender_id: "ORG-0001",
    sender_role: "organiser",
    body: "Hello",
    read_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...o,
  });

  it("500s when the insert errors, and does not notify", async () => {
    const { app, publish } = setup({ insert: { data: null, error: { message: "boom" } } });
    const res = await request(app).post("/api/chat/7/messages").send({ body: "Hello" });
    expect(res.status).toBe(500);
    expect(publish).not.toHaveBeenCalled();
  });

  it("500s when the insert returns no row", async () => {
    const { app } = setup({ insert: { data: null, error: null } });
    expect((await request(app).post("/api/chat/7/messages").send({ body: "Hello" })).status).toBe(500);
  });

  it("400s when the JSON body is missing the body field", async () => {
    const { app, insert } = setup();
    const res = await request(app).post("/api/chat/7/messages").send({});
    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });

  it("400s when no body is sent at all", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/chat/7/messages")).status).toBe(400);
  });

  it("400s a non-string body", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/chat/7/messages").send({ body: 123 })).status).toBe(400);
  });

  it("accepts exactly 2000 characters and rejects 2001", async () => {
    const ok = setup({ insert: { data: saved(), error: null } });
    expect((await request(ok.app).post("/api/chat/7/messages").send({ body: "a".repeat(2000) })).status).toBe(201);
    const tooLong = setup();
    expect((await request(tooLong.app).post("/api/chat/7/messages").send({ body: "a".repeat(2001) })).status).toBe(400);
  });

  it("does not insert when the body is invalid (checks run before write)", async () => {
    const { app, insert } = setup();
    await request(app).post("/api/chat/7/messages").send({ body: "   " });
    expect(insert).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied sender_id / sender_role", async () => {
    const { app, insert } = setup({ insert: { data: saved(), error: null } });
    await request(app).post("/api/chat/7/messages").send({ body: "Hello", sender_id: "COORD-0001", sender_role: "coordinator" });
    expect(insert).toHaveBeenCalledWith({ event_id: 7, sender_id: "ORG-0001", sender_role: "organiser", body: "Hello" });
  });

  it("truncates the notification preview to 140 chars plus an ellipsis", async () => {
    const { app, publish } = setup({ insert: { data: saved(), error: null } });
    await request(app).post("/api/chat/7/messages").send({ body: "x".repeat(300) });
    const preview = publish.mock.calls[0][0].data.preview as string;
    expect(preview).toBe(`${"x".repeat(140)}…`);
  });

  it("keeps a message of exactly 140 chars untruncated", async () => {
    const { app, publish } = setup({ insert: { data: saved(), error: null } });
    await request(app).post("/api/chat/7/messages").send({ body: "y".repeat(140) });
    expect(publish.mock.calls[0][0].data.preview).toBe("y".repeat(140));
  });

  it("publishes message.sent with the event name, falling back to 'Event #id'", async () => {
    const { app, publish } = setup({ event: eventRow({ submitted_details: {} }), insert: { data: saved(), error: null } });
    await request(app).post("/api/chat/7/messages").send({ body: "Hello" });
    expect(publish).toHaveBeenCalledWith({
      type: "message.sent",
      eventId: 7,
      actorId: "ORG-0001",
      recipients: { userIds: ["COORD-0001"], roles: [] },
      data: { eventName: "Event #7", preview: "Hello", senderRole: "organiser" },
    });
  });

  it("trims whitespace before storing", async () => {
    const { app, insert } = setup({ insert: { data: saved(), error: null } });
    await request(app).post("/api/chat/7/messages").send({ body: "  Hello  " });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ body: "Hello" }));
  });
});

describe("GET /threads", () => {
  it("500s when the chat_messages query fails", async () => {
    const { app } = setup({ events: [listEvent()], select: { data: null, error: { message: "boom" } } });
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to load chat messages");
  });

  it("treats null message data as no messages", async () => {
    const { app } = setup({ events: [listEvent()], select: { data: null, error: null } });
    const res = await request(app).get("/api/chat/threads");
    expect(res.body.threads[0].lastMessage).toBeNull();
    expect(res.body.threads[0].unreadCount).toBe(0);
  });

  it("falls back to 'Event #id' for an unnamed event", async () => {
    const { app } = setup({ events: [listEvent({ submitted_details: {} })] });
    expect((await request(app).get("/api/chat/threads")).body.threads[0].eventName).toBe("Event #1");
  });

  it("shows the coordinator's name to an organiser and the organiser's name to a coordinator", async () => {
    const org = setup({ events: [listEvent()] });
    expect((await request(org.app).get("/api/chat/threads")).body.threads[0].otherParty).toBe("Cora");
    const coord = setup({ user: coordinator, events: [listEvent()] });
    expect((await request(coord.app).get("/api/chat/threads")).body.threads[0].otherParty).toBe("Olly");
  });

  it("sorts threads by most recent activity, using event creation time when there are no messages", async () => {
    const msg = (event_id: number, created_at: string) => ({
      id: event_id,
      event_id,
      sender_id: "COORD-0001",
      sender_role: "coordinator",
      body: "b",
      read_at: null,
      created_at,
    });
    const { app } = setup({
      events: [
        listEvent({ id: 1, created_at: "2026-01-01T00:00:00Z" }),
        listEvent({ id: 2, created_at: "2026-01-02T00:00:00Z" }),
        listEvent({ id: 3, created_at: "2026-01-03T00:00:00Z" }),
      ],
      select: { data: [msg(1, "2026-02-01T00:00:00Z")], error: null },
    });
    const ids = (await request(app).get("/api/chat/threads")).body.threads.map((t: any) => t.eventId);
    expect(ids).toEqual([1, 3, 2]);
  });

  it("uses the newest message as lastMessage (rows arrive newest-first)", async () => {
    const m = (id: number, body: string, created_at: string) => ({
      id,
      event_id: 1,
      sender_id: "COORD-0001",
      sender_role: "coordinator",
      body,
      read_at: null,
      created_at,
    });
    const { app } = setup({
      events: [listEvent()],
      select: { data: [m(2, "newest", "2026-01-02T00:00:00Z"), m(1, "older", "2026-01-01T00:00:00Z")], error: null },
    });
    const t = (await request(app).get("/api/chat/threads")).body.threads[0];
    expect(t.lastMessage.body).toBe("newest");
    expect(t.unreadCount).toBe(2);
  });

  it("never counts my own messages as unread", async () => {
    const { app } = setup({
      events: [listEvent()],
      select: {
        data: [{ id: 1, event_id: 1, sender_id: "ORG-0001", sender_role: "organiser", body: "mine", read_at: null, created_at: "2026-01-02T00:00:00Z" }],
        error: null,
      },
    });
    expect((await request(app).get("/api/chat/threads")).body.threads[0].unreadCount).toBe(0);
  });

  it("queries messages only for eligible event ids", async () => {
    const { app, sel } = setup({
      events: [listEvent({ id: 1 }), listEvent({ id: 2, status: "Rejected" }), listEvent({ id: 3, coordinator_id: null })],
    });
    await request(app).get("/api/chat/threads");
    expect(sel.in).toHaveBeenCalledWith("event_id", [1]);
  });
});

// Added after the first mutation run (Stryker): each test pins a behaviour the
// surviving mutants showed was unasserted.
describe("mutation-killing assertions", () => {
  const msgRow = (o: Record<string, unknown>) => ({
    id: 1,
    event_id: 1,
    sender_id: "COORD-0001",
    sender_role: "coordinator",
    body: "b",
    read_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...o,
  });

  it("skips the chat_messages query entirely when no thread is eligible", async () => {
    const { app } = setup({ events: [listEvent({ status: "Rejected" })] });
    const res = await request(app).get("/api/chat/threads");
    expect(res.body).toEqual({ threads: [] });
    expect((globalThis as any).__mockSupabase.from).not.toHaveBeenCalled();
  });

  it("does not report a canSend flag on threads or history", async () => {
    const t = setup({ events: [listEvent()] });
    expect((await request(t.app).get("/api/chat/threads")).body.threads[0]).not.toHaveProperty("canSend");
    const h = setup();
    expect((await request(h.app).get("/api/chat/7/messages")).body.event).not.toHaveProperty("canSend");
  });

  it("asks for each thread's latest message only, and a bounded newest-first page of history", async () => {
    const t = setup({ events: [listEvent()] });
    await request(t.app).get("/api/chat/threads");
    expect(t.sel.order).toHaveBeenCalledWith("id", { ascending: false });
    expect(t.sel.limit).toHaveBeenCalledWith(1);
    const h = setup();
    await request(h.app).get("/api/chat/7/messages");
    expect(h.sel.order).toHaveBeenCalledWith("id", { ascending: false });
    expect(h.sel.limit).toHaveBeenCalledWith(51);
  });

  it("does not count already-read messages as unread in the inbox", async () => {
    const { app } = setup({
      events: [listEvent()],
      select: { data: [msgRow({ id: 2, read_at: "2026-01-02T00:00:00Z" }), msgRow({ id: 1 })], error: null },
    });
    expect((await request(app).get("/api/chat/threads")).body.threads[0].unreadCount).toBe(1);
  });

  it("counts unread in history from the other party only (distinct counts)", async () => {
    const { app } = setup({
      select: {
        data: [
          msgRow({ id: 1, event_id: 7 }),
          msgRow({ id: 2, event_id: 7 }),
          msgRow({ id: 3, event_id: 7 }),
          msgRow({ id: 4, event_id: 7, sender_id: "ORG-0001", sender_role: "organiser" }),
        ],
        error: null,
      },
    });
    expect((await request(app).get("/api/chat/7/messages")).body.unreadCount).toBe(3);
  });

  it("500s when the insert reports an error even if a row came back", async () => {
    const { app } = setup({ insert: { data: msgRow({}), error: { message: "partial" } } });
    expect((await request(app).post("/api/chat/7/messages").send({ body: "Hello" })).status).toBe(500);
  });
});

// Second mutation pass: pin the exact error bodies and query shapes.
describe("exact error bodies and query shapes", () => {
  const COLS = "id, event_id, sender_id, sender_role, body, read_at, created_at";

  it("role gate body", async () => {
    const { app } = setup({ user: { id: "U", role: "attendee" } });
    const res = await request(app).get("/api/chat/threads");
    expect(res.body).toEqual({ error: "Access denied" });
  });

  it("unauthenticated bodies on every route", async () => {
    const { app } = setup({ noSupabase: true });
    for (const res of [
      await request(app).get("/api/chat/threads"),
      await request(app).get("/api/chat/7/messages"),
      await request(app).post("/api/chat/7/read"),
      await request(app).post("/api/chat/7/messages").send({ body: "x" }),
    ]) {
      expect(res.body).toEqual({ error: "Unauthenticated" });
    }
  });

  it("invalid id bodies on every event route", async () => {
    const { app } = setup();
    for (const res of [
      await request(app).get("/api/chat/abc/messages"),
      await request(app).post("/api/chat/abc/read"),
      await request(app).post("/api/chat/abc/messages").send({ body: "x" }),
    ]) {
      expect(res.body).toEqual({ error: "A valid event id is required" });
    }
  });

  it("access error bodies are passed through on all three event routes", async () => {
    const cases: [() => ReturnType<typeof setup>, number, string][] = [
      [() => setup({ eventHttp: 404 }), 404, "Event not found"],
      [() => setup({ eventHttp: 500 }), 502, "Failed to load the event"],
      [() => setup({ event: eventRow({ coordinator_id: null }) }), 409, "No coordinator has been assigned to this event yet."],
      [() => setup({ event: eventRow({ organiser_id: "SOMEONE-ELSE" }) }), 403, "Access denied"],
      [() => setup({ user: coordinator, event: eventRow({ coordinator_id: "COORD-9999" }) }), 403, "Access denied"],
      [() => setup({ event: eventRow({ status: "Rejected" }) }), 409, "Chat isn't available for this event right now."],
    ];
    for (const [make, status, error] of cases) {
      const { app } = make();
      for (const res of [
        await request(app).get("/api/chat/7/messages"),
        await request(app).post("/api/chat/7/read"),
        await request(app).post("/api/chat/7/messages").send({ body: "x" }),
      ]) {
        expect(res.status).toBe(status);
        expect(res.body).toEqual({ error });
      }
    }
  });

  it("a coordinator-less event is refused for a coordinator as Access denied", async () => {
    const { app } = setup({ user: coordinator, event: eventRow({ coordinator_id: null }) });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
  });

  it("validation error bodies", async () => {
    const { app } = setup();
    expect((await request(app).post("/api/chat/7/messages").send({ body: "" })).body).toEqual({ error: "Message cannot be empty." });
    expect((await request(app).post("/api/chat/7/messages").send({ body: "a".repeat(2001) })).body).toEqual({
      error: "Message is too long (max 2000 characters).",
    });
  });

  it("send failure body", async () => {
    const { app } = setup({ insert: { data: null, error: { message: "x" } } });
    expect((await request(app).post("/api/chat/7/messages").send({ body: "Hello" })).body).toEqual({ error: "Failed to send the message" });
  });

  it("history selects the documented columns for this event", async () => {
    const { app, sel } = setup();
    await request(app).get("/api/chat/7/messages");
    expect(sel.select).toHaveBeenCalledWith(COLS, undefined);
    expect(sel.eq).toHaveBeenCalledWith("event_id", 7);
  });

  it("inbox selects the documented columns", async () => {
    const { app, sel } = setup({ events: [listEvent()] });
    await request(app).get("/api/chat/threads");
    expect(sel.select).toHaveBeenCalledWith(COLS, undefined);
    expect(sel.select).toHaveBeenCalledWith("event_id", undefined);
  });
});

describe("history paging", () => {
  const rows = (n: number, o: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      event_id: 7,
      sender_id: "COORD-0001",
      sender_role: "coordinator",
      body: `m${i + 1}`,
      read_at: null,
      created_at: "2026-01-01T00:00:00Z",
      ...o,
    }));
  const get = (app: any, qs = "") => request(app).get(`/api/chat/7/messages${qs}`);

  it("returns the newest 50 oldest-first, with hasMore and a cursor", async () => {
    const { app } = setup({ select: { data: rows(120), error: null } });
    const res = await get(app);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].id).toBe(71);
    expect(res.body.messages[49].id).toBe(120);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextBefore).toBe(71);
  });

  it("pages backwards with before and ends with hasMore:false", async () => {
    const { app } = setup({ select: { data: rows(120), error: null } });
    const second = await get(app, "?before=71&limit=50");
    expect(second.body.messages.map((m: any) => m.id)[0]).toBe(21);
    expect(second.body.messages).toHaveLength(50);
    expect(second.body.hasMore).toBe(true);
    const last = await get(app, "?before=21&limit=50");
    expect(last.body.messages).toHaveLength(20);
    expect(last.body.messages[0].id).toBe(1);
    expect(last.body.hasMore).toBe(false);
    expect(last.body.nextBefore).toBeNull();
  });

  it("reports hasMore:false when the thread is exactly one page", async () => {
    const { app } = setup({ select: { data: rows(50), error: null } });
    const res = await get(app);
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextBefore).toBeNull();
  });

  it("honours an explicit limit up to 200", async () => {
    const { app } = setup({ select: { data: rows(300), error: null } });
    expect((await get(app, "?limit=7")).body.messages).toHaveLength(7);
    expect((await get(app, "?limit=200")).body.messages).toHaveLength(200);
    expect((await get(app, "?limit=1")).body.messages).toHaveLength(1);
  });

  it.each(["0", "201", "-1", "abc", "1.5", ""])("400s limit=%j", async (limit) => {
    const { app } = setup();
    const res = await get(app, `?limit=${limit}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "limit must be a whole number between 1 and 200" });
  });

  it.each(["0", "-4", "abc", "2.5", ""])("400s before=%j", async (before) => {
    const { app } = setup();
    const res = await get(app, `?before=${before}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "before must be a positive message id" });
  });

  it("validates paging before calling events-service", async () => {
    const { app } = setup();
    await get(app, "?limit=0");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("counts unread across the whole thread, not just the returned page", async () => {
    const { app } = setup({ select: { data: rows(120), error: null } });
    const res = await get(app, "?limit=5");
    expect(res.body.messages).toHaveLength(5);
    expect(res.body.unreadCount).toBe(120);
  });

  it("500s when the queries fail", async () => {
    const { app } = setup({ select: { data: null, error: { message: "boom" } } });
    expect((await get(app)).status).toBe(500);
  });
});

describe("Needs Review", () => {
  const sent = { id: 1, event_id: 7, sender_id: "ORG-0001", sender_role: "organiser", body: "Hi", read_at: null, created_at: "2026-01-01T00:00:00Z" };

  it("lets either party read and send while the event is in Needs Review", async () => {
    const org = setup({ event: eventRow({ status: "Needs Review" }), insert: { data: sent, error: null } });
    expect((await request(org.app).get("/api/chat/7/messages")).status).toBe(200);
    expect((await request(org.app).post("/api/chat/7/messages").send({ body: "Hi" })).status).toBe(201);
    const coord = setup({ user: coordinator, event: eventRow({ status: "Needs Review" }) });
    expect((await request(coord.app).get("/api/chat/7/messages")).status).toBe(200);
    expect((await request(coord.app).post("/api/chat/7/read")).status).toBe(204);
  });

  it("lists a Needs Review event in the inbox", async () => {
    const { app } = setup({ events: [listEvent({ status: "Needs Review" })] });
    const res = await request(app).get("/api/chat/threads");
    expect(res.body.threads).toHaveLength(1);
    expect(res.body.threads[0].status).toBe("Needs Review");
  });
});

describe("inbox query shape", () => {
  const m = (id: number, event_id: number, o: Record<string, unknown> = {}) => ({
    id,
    event_id,
    sender_id: "COORD-0001",
    sender_role: "coordinator",
    body: `b${id}`,
    read_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...o,
  });

  it("takes each thread's latest message and counts unread per thread without loading history", async () => {
    const { app, sel } = setup({
      events: [listEvent({ id: 1 }), listEvent({ id: 2, created_at: "2026-01-02T00:00:00Z" })],
      select: { data: [m(1, 1), m(2, 1), m(3, 2, { read_at: "2026-01-09T00:00:00Z" }), m(4, 2)], error: null },
    });
    const res = await request(app).get("/api/chat/threads");
    const byId = Object.fromEntries(res.body.threads.map((t: any) => [t.eventId, t]));
    expect(byId[1]).toMatchObject({ unreadCount: 2, lastMessage: { body: "b2" } });
    expect(byId[2]).toMatchObject({ unreadCount: 1, lastMessage: { body: "b4" } });
    expect(sel.limit).toHaveBeenCalledTimes(2);
    expect(sel.limit).toHaveBeenCalledWith(1);
    expect(sel.in).toHaveBeenCalledWith("event_id", [1, 2]);
    expect(sel.neq).toHaveBeenCalledWith("sender_id", "ORG-0001");
    expect(sel.is).toHaveBeenCalledWith("read_at", null);
  });

  it("a thread with no messages has no last message and zero unread", async () => {
    const { app } = setup({ events: [listEvent()], select: { data: [], error: null } });
    const t = (await request(app).get("/api/chat/threads")).body.threads[0];
    expect(t.lastMessage).toBeNull();
    expect(t.unreadCount).toBe(0);
  });
});

describe("send rate limit", () => {
  const sent = { id: 1, event_id: 7, sender_id: "ORG-0001", sender_role: "organiser", body: "Hello", read_at: null, created_at: "2026-01-01T00:00:00Z" };
  const send = (app: any) => request(app).post("/api/chat/7/messages").send({ body: "Hello" });

  afterEach(() => {
    delete process.env.CHAT_SEND_LIMIT_PER_MINUTE;
  });

  it("429s with Retry-After once a user passes the per-minute cap, and does not write", async () => {
    process.env.CHAT_SEND_LIMIT_PER_MINUTE = "3";
    const { app, insert } = setup({ insert: { data: sent, error: null } });
    for (let i = 0; i < 3; i++) expect((await send(app)).status).toBe(201);
    const blocked = await send(app);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({ error: "You are sending messages too quickly. Please wait a moment and try again." });
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(insert).toHaveBeenCalledTimes(3);
  });

  it("allows 30 per minute by default and blocks the 31st", async () => {
    const { app } = setup({ insert: { data: sent, error: null } });
    for (let i = 0; i < 30; i++) expect((await send(app)).status).toBe(201);
    expect((await send(app)).status).toBe(429);
  });

  it("limits per user, not globally", async () => {
    process.env.CHAT_SEND_LIMIT_PER_MINUTE = "1";
    const org = setup({ insert: { data: sent, error: null } });
    expect((await send(org.app)).status).toBe(201);
    expect((await send(org.app)).status).toBe(429);
    const coord = setup({ user: coordinator, insert: { data: { ...sent, sender_id: "COORD-0001", sender_role: "coordinator" }, error: null } });
    expect((await send(coord.app)).status).toBe(201);
  });

  it("falls back to the default when the env value is not a number", async () => {
    process.env.CHAT_SEND_LIMIT_PER_MINUTE = "lots";
    const { app } = setup({ insert: { data: sent, error: null } });
    for (let i = 0; i < 30; i++) expect((await send(app)).status).toBe(201);
    expect((await send(app)).status).toBe(429);
  });

  it("does not rate-limit reading or marking read", async () => {
    process.env.CHAT_SEND_LIMIT_PER_MINUTE = "1";
    const { app } = setup({ insert: { data: sent, error: null } });
    await send(app);
    await send(app);
    expect((await request(app).get("/api/chat/7/messages")).status).toBe(200);
    expect((await request(app).post("/api/chat/7/read")).status).toBe(204);
    expect((await request(app).get("/api/chat/threads")).status).toBe(200);
  });
});

describe("null results from supabase", () => {
  it("history returns an empty page and zero unread", async () => {
    const { app } = setup({ nullData: true });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ messages: [], unreadCount: 0, hasMore: false, nextBefore: null });
  });

  it("inbox shows threads with no messages", async () => {
    const { app } = setup({ nullData: true, events: [listEvent()] });
    const t = (await request(app).get("/api/chat/threads")).body.threads[0];
    expect(t).toMatchObject({ lastMessage: null, unreadCount: 0 });
  });
});

describe("partial query failures", () => {
  it("inbox 500s when only a latest-message query fails", async () => {
    const { app } = setup({ events: [listEvent()], failWhen: ({ limit }) => (limit === 1 ? { message: "boom" } : null) });
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load chat messages" });
  });

  it("inbox 500s when only the unread query fails", async () => {
    const { app } = setup({ events: [listEvent()], failWhen: ({ columns }) => (columns === "event_id" ? { message: "boom" } : null) });
    expect((await request(app).get("/api/chat/threads")).status).toBe(500);
  });

  it("inbox 500s when only one of several latest-message queries fails", async () => {
    let seen = 0;
    const { app } = setup({
      events: [listEvent({ id: 1 }), listEvent({ id: 2 })],
      failWhen: ({ limit }) => (limit === 1 && ++seen === 2 ? { message: "boom" } : null),
    });
    expect((await request(app).get("/api/chat/threads")).status).toBe(500);
  });

  it("history 500s when only the page query fails", async () => {
    const { app } = setup({ failWhen: ({ head }) => (head ? null : { message: "boom" }) });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load messages" });
  });

  it("history 500s when only the unread count query fails", async () => {
    const { app } = setup({ failWhen: ({ head }) => (head ? { message: "boom" } : null) });
    expect((await request(app).get("/api/chat/7/messages")).status).toBe(500);
  });

  it("history asks for an exact head-only count of unread rows", async () => {
    const { app, sel } = setup();
    await request(app).get("/api/chat/7/messages");
    expect(sel.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(sel.neq).toHaveBeenCalledWith("sender_id", "ORG-0001");
    expect(sel.is).toHaveBeenCalledWith("read_at", null);
  });

  it("history applies the before cursor with lt on id", async () => {
    const { app, sel } = setup();
    await request(app).get("/api/chat/7/messages?before=40");
    expect(sel.lt).toHaveBeenCalledWith("id", 40);
  });

  it("history without before does not apply a cursor", async () => {
    const { app, sel } = setup();
    await request(app).get("/api/chat/7/messages");
    expect(sel.lt).not.toHaveBeenCalled();
  });
});
