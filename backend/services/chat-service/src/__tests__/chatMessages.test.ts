import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { chatRouter } from "../routes/chatMessages.js";
import { validateMessageBody } from "../lib/validateChatMessage.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "ORG-0001", role: "organiser" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const organiser = { id: "ORG-0001", role: "organiser" };
const coordinator = { id: "COORD-0001", role: "coordinator" };

/** A supabase-js style query: every filter returns the query, and awaiting it yields `result`. */
function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "in", "order", "neq", "is", "update"]) q[method] = vi.fn(() => q);
  q.single = vi.fn().mockResolvedValue(result);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    status: "Planning",
    organiser_id: "ORG-0001",
    coordinator_id: "COORD-0001",
    submitted_details: { name: "Alumni Gala" },
    ...overrides,
  };
}

function buildApp(
  options: {
    user?: { id: string; role: string };
    eventStatus?: number;
    event?: Record<string, unknown> | null;
    messages?: Record<string, unknown>[];
    insertedMessage?: Record<string, unknown> | null;
    insertError?: boolean;
    eventsListStatus?: number;
    eventsList?: Record<string, unknown>[];
    notificationsStatus?: number;
  } = {},
) {
  const messagesSelect = query({ data: options.messages ?? [], error: null });
  const messagesUpdate = query({ data: null, error: null });
  const messagesInsert = vi.fn(() =>
    query({
      data: options.insertError
        ? null
        : options.insertedMessage === undefined
          ? {
              id: 900,
              event_id: 7,
              sender_id: (options.user ?? organiser).id,
              sender_role: (options.user ?? organiser).role,
              body: "Hello",
              read_at: null,
              created_at: "2026-01-01T00:00:00Z",
            }
          : options.insertedMessage,
      error: options.insertError ? { message: "boom" } : null,
    }),
  );

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "chat_messages") {
        return { select: messagesSelect.select, insert: messagesInsert, update: messagesUpdate.update };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };

  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("/api/events/") && !url.includes("/api/events?") && !url.endsWith("/api/events")) {
      const status = options.eventStatus ?? 200;
      if (status === 403 || status === 404) return { ok: false, status, json: async () => ({}) };
      if (!(status < 300)) return { ok: false, status, json: async () => ({}) };
      return { ok: true, status, json: async () => ({ event: options.event === undefined ? eventRow() : options.event }) };
    }
    if (url.endsWith("/api/events")) {
      const status = options.eventsListStatus ?? 200;
      if (!(status < 300)) return { ok: false, status, json: async () => ({}) };
      return { ok: true, status, json: async () => ({ events: options.eventsList ?? [] }) };
    }
    if (url.includes("/api/notifications")) {
      const status = options.notificationsStatus ?? 201;
      return { ok: status < 300, status, json: async () => ({}) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? organiser;

  const app = express();
  app.use(express.json());
  app.use("/api/chat", chatRouter);
  return { app, supabase, messagesInsert, messagesUpdate, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateMessageBody", () => {
  it("rejects an empty or blank body", () => {
    expect(validateMessageBody("").valid).toBe(false);
    expect(validateMessageBody("   ").valid).toBe(false);
    expect(validateMessageBody(undefined).valid).toBe(false);
  });

  it("trims and accepts a normal message", () => {
    const result = validateMessageBody("  Hello there  ");
    expect(result).toEqual({ valid: true, value: "Hello there" });
  });

  it("rejects a message over the length limit", () => {
    const result = validateMessageBody("x".repeat(2001));
    expect(result.valid).toBe(false);
  });
});

describe("role gate", () => {
  it("rejects a role that is neither organiser nor coordinator", async () => {
    const { app } = buildApp({ user: { id: "TS-0001", role: "technical_support" } });
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/chat/:eventId/messages", () => {
  it("rejects an invalid event id", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/chat/abc/messages");
    expect(res.status).toBe(400);
  });

  it("404s when the event doesn't exist", async () => {
    const { app } = buildApp({ eventStatus: 404 });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(404);
  });

  it("blocks an organiser who doesn't own the event", async () => {
    const { app } = buildApp({ event: eventRow({ organiser_id: "ORG-9999" }) });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(403);
  });

  it("blocks a coordinator who isn't the assigned one", async () => {
    const { app } = buildApp({
      user: { id: "COORD-9999", role: "coordinator" },
      event: eventRow({ coordinator_id: "COORD-0001" }),
    });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(403);
  });

  it("blocks an organiser whose event has no coordinator assigned yet", async () => {
    const { app } = buildApp({ event: eventRow({ coordinator_id: null }) });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(409);
  });

  it("returns history, unread count and canSend for the owning organiser", async () => {
    const { app } = buildApp({
      messages: [
        { id: 1, event_id: 7, sender_id: "COORD-0001", sender_role: "coordinator", body: "Hi", read_at: null, created_at: "2026-01-01T00:00:00Z" },
        { id: 2, event_id: 7, sender_id: "ORG-0001", sender_role: "organiser", body: "Hello back", read_at: null, created_at: "2026-01-02T00:00:00Z" },
      ],
    });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ id: 7, name: "Alumni Gala", status: "Planning", canSend: true });
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.messages).toEqual([
      { id: 1, senderId: "COORD-0001", senderRole: "coordinator", body: "Hi", createdAt: "2026-01-01T00:00:00Z", mine: false },
      { id: 2, senderId: "ORG-0001", senderRole: "organiser", body: "Hello back", createdAt: "2026-01-02T00:00:00Z", mine: true },
    ]);
  });

  it("allows history for a Confirmed event too", async () => {
    const { app } = buildApp({ event: eventRow({ status: "Confirmed" }) });
    const res = await request(app).get("/api/chat/7/messages");
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ status: "Confirmed", canSend: true });
  });

  it.each(["Unassigned", "Requested", "Clarification Requested", "Safety Review", "Completed", "Rejected", "Cancelled"])(
    "blocks the chat entirely once the event is %s",
    async (status) => {
      const { app } = buildApp({ event: eventRow({ status }) });
      const res = await request(app).get("/api/chat/7/messages");
      expect(res.status).toBe(409);
    },
  );
});

describe("POST /api/chat/:eventId/read", () => {
  it("marks the other party's unread messages read", async () => {
    const { app, messagesUpdate } = buildApp();
    const res = await request(app).post("/api/chat/7/read");
    expect(res.status).toBe(204);
    expect(messagesUpdate.eq).toHaveBeenCalledWith("event_id", 7);
    expect(messagesUpdate.neq).toHaveBeenCalledWith("sender_id", "ORG-0001");
    expect(messagesUpdate.is).toHaveBeenCalledWith("read_at", null);
  });

  it("blocks access the same way as the history endpoint", async () => {
    const { app } = buildApp({ event: eventRow({ organiser_id: "ORG-9999" }) });
    const res = await request(app).post("/api/chat/7/read");
    expect(res.status).toBe(403);
  });
});

describe("POST /api/chat/:eventId/messages", () => {
  it("rejects a blank message", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/chat/7/messages").send({ body: "   " });
    expect(res.status).toBe(400);
  });

  it("blocks sending once the event is closed", async () => {
    const { app } = buildApp({ event: eventRow({ status: "Rejected" }) });
    const res = await request(app).post("/api/chat/7/messages").send({ body: "Still there?" });
    expect(res.status).toBe(409);
  });

  it("records the message and notifies the assigned coordinator when the organiser sends", async () => {
    const { app, messagesInsert, fetchMock } = buildApp();
    const res = await request(app)
      .post("/api/chat/7/messages")
      .set("Authorization", "Bearer token123")
      .send({ body: "What time does setup start?" });

    expect(res.status).toBe(201);
    expect(messagesInsert).toHaveBeenCalledWith({
      event_id: 7,
      sender_id: "ORG-0001",
      sender_role: "organiser",
      body: "What time does setup start?",
    });
    expect(res.body.message).toMatchObject({ senderId: "ORG-0001", senderRole: "organiser", mine: true });
    expect(res.body.notified).toBe(true);

    const notifyCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/notifications"));
    expect(notifyCall).toBeDefined();
    const sentBody = JSON.parse((notifyCall![1] as RequestInit).body as string);
    expect(sentBody.notifications[0]).toMatchObject({ recipientId: "COORD-0001", type: "chat_message" });
  });

  it("notifies the organiser when the coordinator sends", async () => {
    const { app, fetchMock } = buildApp({ user: coordinator, insertedMessage: { id: 901, event_id: 7, sender_id: "COORD-0001", sender_role: "coordinator", body: "Setup is at 9am", read_at: null, created_at: "2026-01-01T00:00:00Z" } });
    const res = await request(app).post("/api/chat/7/messages").send({ body: "Setup is at 9am" });

    expect(res.status).toBe(201);
    const notifyCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/notifications"));
    const sentBody = JSON.parse((notifyCall![1] as RequestInit).body as string);
    expect(sentBody.notifications[0]).toMatchObject({ recipientId: "ORG-0001", type: "chat_message" });
  });

  it("reports notified:false when notification-service fails, without failing the send", async () => {
    const { app } = buildApp({ notificationsStatus: 500 });
    const res = await request(app).post("/api/chat/7/messages").send({ body: "Hello" });
    expect(res.status).toBe(201);
    expect(res.body.notified).toBe(false);
  });
});

describe("GET /api/chat/threads", () => {
  it("returns an empty inbox when nothing is eligible", async () => {
    const { app } = buildApp({ eventsList: [] });
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(200);
    expect(res.body.threads).toEqual([]);
  });

  it("hides an organiser's events with no coordinator assigned", async () => {
    const { app } = buildApp({
      eventsList: [
        { id: 1, status: "Unassigned", coordinator_id: null, coordinator: null, organiser: { name: "Organiser One" }, submitted_details: { name: "Draft Fair" }, created_at: "2026-01-01T00:00:00Z" },
        { id: 2, status: "Planning", coordinator_id: "COORD-0001", coordinator: { name: "Jonas" }, organiser: { name: "Organiser One" }, submitted_details: { name: "Alumni Gala" }, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
    expect(res.body.threads[0]).toMatchObject({ eventId: 2, otherParty: "Jonas" });
  });

  it("only includes events in Planning or Confirmed, for either role", async () => {
    const { app } = buildApp({
      eventsList: [
        { id: 1, status: "Requested", coordinator_id: "COORD-0001", coordinator: { name: "Jonas" }, organiser: { name: "Organiser One" }, submitted_details: { name: "Too early" }, created_at: "2026-01-01T00:00:00Z" },
        { id: 2, status: "Confirmed", coordinator_id: "COORD-0001", coordinator: { name: "Jonas" }, organiser: { name: "Organiser One" }, submitted_details: { name: "Confirmed Gala" }, created_at: "2026-01-01T00:00:00Z" },
        { id: 3, status: "Safety Review", coordinator_id: "COORD-0001", coordinator: { name: "Jonas" }, organiser: { name: "Organiser One" }, submitted_details: { name: "Under review" }, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
    expect(res.body.threads[0]).toMatchObject({ eventId: 2, status: "Confirmed" });
  });

  it("only includes a coordinator's own assigned events", async () => {
    const { app } = buildApp({
      user: coordinator,
      eventsList: [
        { id: 1, status: "Planning", coordinator_id: "COORD-0001", coordinator: { name: "Benny" }, organiser: { name: "Organiser One" }, submitted_details: { name: "Mine" }, created_at: "2026-01-01T00:00:00Z" },
        { id: 2, status: "Planning", coordinator_id: "COORD-0002", coordinator: { name: "Jonas" }, organiser: { name: "Organiser Two" }, submitted_details: { name: "Not mine" }, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
    expect(res.body.threads[0]).toMatchObject({ eventId: 1, otherParty: "Organiser One" });
  });

  it("computes the last message and unread count per thread", async () => {
    const { app } = buildApp({
      eventsList: [
        { id: 7, status: "Planning", coordinator_id: "COORD-0001", coordinator: { name: "Jonas" }, organiser: { name: "Organiser One" }, submitted_details: { name: "Alumni Gala" }, created_at: "2026-01-01T00:00:00Z" },
      ],
      messages: [
        { id: 2, event_id: 7, sender_id: "COORD-0001", sender_role: "coordinator", body: "Second", read_at: null, created_at: "2026-01-02T00:00:00Z" },
        { id: 1, event_id: 7, sender_id: "COORD-0001", sender_role: "coordinator", body: "First", read_at: null, created_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(200);
    expect(res.body.threads[0]).toMatchObject({
      eventId: 7,
      unreadCount: 2,
      lastMessage: { body: "Second", senderId: "COORD-0001" },
    });
  });
});
