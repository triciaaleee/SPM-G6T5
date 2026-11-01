import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { notificationsRouter } from "../routes/notifications.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "COORD-0001", role: "coordinator" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

/** The instant vitest.setup.ts freezes `Date` at. */
const FROZEN_NOW = "2026-10-28T04:00:00.000Z";

/** A supabase-js style query: every filter returns the query, and awaiting it yields `result`. */
function query(result: Record<string, unknown>) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "is", "order", "limit", "update", "lt"]) q[method] = vi.fn(() => q);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

const row = {
  id: 3,
  type: "venue_unavailable",
  title: "Alternative venue needed for Nut Festival",
  body: "Great Lawn is unavailable 13 Oct 2026 (all day): Resurfacing.",
  link: "/events/7",
  event_id: 7,
  read_at: null,
  created_at: "2026-10-08T01:00:00Z",
};

function buildApp(
  options: {
    user?: { id: string; role: string };
    rows?: unknown[];
    unread?: number;
    listResult?: Record<string, unknown>;
    countResult?: Record<string, unknown>;
    updateResult?: Record<string, unknown>;
  } = {},
) {
  const listQuery = query(options.listResult ?? { data: options.rows ?? [row], error: null });
  const countQuery = query(options.countResult ?? { data: null, count: options.unread ?? 1, error: null });
  const updateQuery = query(options.updateResult ?? { data: null, error: null });

  // GET makes two .from("notifications") calls: the list, then the unread count.
  let selects = 0;
  const supabase = {
    from: vi.fn(() => ({
      select: (...args: unknown[]) => (selects++ === 0 ? listQuery : countQuery).select(...args),
      update: updateQuery.update,
    })),
  };

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
  return { app, supabase, listQuery, countQuery, updateQuery };
}

describe("GET /api/notifications", () => {
  it("returns the caller's latest five notifications and the unread count", async () => {
    const { app, listQuery, countQuery } = buildApp({ unread: 4 });

    const res = await request(app).get("/api/notifications");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      notifications: [
        {
          id: 3,
          type: "venue_unavailable",
          title: row.title,
          body: row.body,
          link: "/events/7",
          eventId: 7,
          read: false,
          createdAt: row.created_at,
        },
      ],
      nextCursor: null,
      unreadCount: 4,
    });
    expect(listQuery.eq).toHaveBeenCalledWith("recipient_id", "COORD-0001");
    expect(listQuery.limit).toHaveBeenCalledWith(5);
    expect(countQuery.is).toHaveBeenCalledWith("read_at", null);
  });

  it("caps the limit", async () => {
    const { app, listQuery } = buildApp();
    await request(app).get("/api/notifications?limit=500");
    expect(listQuery.limit).toHaveBeenCalledWith(50);
  });

  it("pages with `before`, applying `.lt` and omitting the unread count", async () => {
    const { app, listQuery, countQuery } = buildApp({ rows: [row] });

    const res = await request(app).get("/api/notifications?before=10");

    expect(res.status).toBe(200);
    expect(listQuery.lt).toHaveBeenCalledWith("id", 10);
    expect(countQuery.select).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      notifications: [
        {
          id: 3,
          type: "venue_unavailable",
          title: row.title,
          body: row.body,
          link: "/events/7",
          eventId: 7,
          read: false,
          createdAt: row.created_at,
        },
      ],
      nextCursor: null,
    });
  });

  it("returns a nextCursor when a full page comes back", async () => {
    const rows = [row, { ...row, id: 2 }, { ...row, id: 1 }, { ...row, id: 0 }, { ...row, id: -1 }];
    const { app } = buildApp({ rows });

    const res = await request(app).get("/api/notifications?limit=5");

    expect(res.body.nextCursor).toBe(-1);
  });
});

describe("POST /api/notifications/read", () => {
  it("marks only the caller's unread notifications as read", async () => {
    const { app, updateQuery } = buildApp();

    const res = await request(app).post("/api/notifications/read");

    expect(res.status).toBe(204);
    expect(updateQuery.update).toHaveBeenCalledWith({ read_at: expect.any(String) });
    expect(updateQuery.eq).toHaveBeenCalledWith("recipient_id", "COORD-0001");
    expect(updateQuery.is).toHaveBeenCalledWith("read_at", null);
  });
});

describe("POST /api/notifications/:id/read", () => {
  it("marks only the caller's own notification as read", async () => {
    const { app, updateQuery } = buildApp();

    const res = await request(app).post("/api/notifications/3/read");

    expect(res.status).toBe(204);
    expect(updateQuery.update).toHaveBeenCalledWith({ read_at: expect.any(String) });
    expect(updateQuery.eq).toHaveBeenCalledWith("id", 3);
    expect(updateQuery.eq).toHaveBeenCalledWith("recipient_id", "COORD-0001");
    expect(updateQuery.is).toHaveBeenCalledWith("read_at", null);
  });

  it("returns 400 for a non-numeric id", async () => {
    const { app, updateQuery } = buildApp();

    const res = await request(app).post("/api/notifications/not-a-number/read");

    expect(res.status).toBe(400);
    expect(updateQuery.update).not.toHaveBeenCalled();
  });
});

describe("GET /api/notifications: query and paging details", () => {
  it("reads the notifications table with the exact columns, newest first", async () => {
    const { app, supabase, listQuery, countQuery } = buildApp();

    await request(app).get("/api/notifications");

    expect(supabase.from.mock.calls).toEqual([["notifications"], ["notifications"]]);
    expect(listQuery.select).toHaveBeenCalledWith("id, type, title, body, link, event_id, actor_id, occurred_at, read_at, created_at");
    expect(listQuery.order.mock.calls).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    expect(listQuery.lt).not.toHaveBeenCalled();
    expect(countQuery.select).toHaveBeenCalledWith("id", { count: "exact", head: true });
    expect(countQuery.eq).toHaveBeenCalledWith("recipient_id", "COORD-0001");
  });

  it("maps a read notification with its audit fields", async () => {
    const { app } = buildApp({ rows: [{ ...row, actor_id: "ORG-0001", occurred_at: "2026-10-08T00:59:00Z", read_at: "2026-10-08T02:00:00Z" }] });

    const res = await request(app).get("/api/notifications");

    expect(res.body.notifications[0]).toMatchObject({ actorId: "ORG-0001", occurredAt: "2026-10-08T00:59:00Z", read: true });
  });

  it.each([
    ["limit=abc"],
    ["limit=0"],
    ["limit=-1"],
    ["limit=1.5"],
    ["limit="],
    ["limit=3&limit=4"],
  ])("falls back to the default limit for %s", async (qs) => {
    const { app, listQuery } = buildApp();
    await request(app).get(`/api/notifications?${qs}`);
    expect(listQuery.limit).toHaveBeenCalledWith(5);
  });

  it.each([
    ["1", 1],
    ["50", 50],
    ["51", 50],
  ])("honours limit=%s as %i", async (value, expected) => {
    const { app, listQuery } = buildApp();
    await request(app).get(`/api/notifications?limit=${value}`);
    expect(listQuery.limit).toHaveBeenCalledWith(expected);
  });

  it.each([["abc"], ["0"], ["-5"], ["1.5"], [""], ["1e30"], ["3&before=4"]])("ignores before=%s and treats it as the first page", async (value) => {
    const { app, listQuery, countQuery } = buildApp({ unread: 2 });

    const res = await request(app).get(`/api/notifications?before=${value}`);

    expect(res.status).toBe(200);
    expect(listQuery.lt).not.toHaveBeenCalled();
    expect(countQuery.select).toHaveBeenCalled();
    expect(res.body.unreadCount).toBe(2);
  });

  it("accepts before=1, the smallest id", async () => {
    const { app, listQuery } = buildApp();
    await request(app).get("/api/notifications?before=1");
    expect(listQuery.lt).toHaveBeenCalledWith("id", 1);
  });

  it("has no nextCursor on a short page", async () => {
    const { app } = buildApp({ rows: [row] });
    const res = await request(app).get("/api/notifications?limit=2");
    expect(res.body.nextCursor).toBeNull();
  });

  it("reads missing rows and a missing count as empty", async () => {
    const { app } = buildApp({ listResult: { data: null, error: null }, countResult: { count: null, error: null } });

    const res = await request(app).get("/api/notifications");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notifications: [], nextCursor: null, unreadCount: 0 });
  });

  it("returns 500 when the list query fails", async () => {
    const { app } = buildApp({ listResult: { data: null, error: { message: "boom" } } });
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load notifications" });
  });

  it("returns 500 when the unread count fails", async () => {
    const { app } = buildApp({ countResult: { count: null, error: { message: "boom" } } });
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load notifications" });
  });
});

describe("POST /api/notifications/read: details", () => {
  it("stamps read_at with the current time, on the notifications table", async () => {
    const { app, supabase, updateQuery } = buildApp();
    await request(app).post("/api/notifications/read");
    expect(supabase.from).toHaveBeenCalledWith("notifications");
    expect(updateQuery.update).toHaveBeenCalledWith({ read_at: FROZEN_NOW });
  });

  it("returns 500 when the update fails", async () => {
    const { app } = buildApp({ updateResult: { data: null, error: { message: "boom" } } });
    const res = await request(app).post("/api/notifications/read");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to mark notifications as read" });
  });
});

describe("POST /api/notifications/:id/read: details", () => {
  it("stamps read_at with the current time, on the notifications table", async () => {
    const { app, supabase, updateQuery } = buildApp();
    await request(app).post("/api/notifications/1/read");
    expect(supabase.from).toHaveBeenCalledWith("notifications");
    expect(updateQuery.update).toHaveBeenCalledWith({ read_at: FROZEN_NOW });
    expect(updateQuery.eq).toHaveBeenCalledWith("id", 1);
  });

  // 1e30 is an integer to JavaScript, but it doesn't fit the bigint id column, so it must never reach Postgres.
  it.each([["0"], ["-1"], ["1.5"], ["1e30"], ["9007199254740992"]])("returns 400 for id %s", async (id) => {
    const { app, updateQuery } = buildApp();

    const res = await request(app).post(`/api/notifications/${id}/read`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "id must be a positive integer" });
    expect(updateQuery.update).not.toHaveBeenCalled();
  });

  it("returns 500 when the update fails", async () => {
    const { app } = buildApp({ updateResult: { data: null, error: { message: "boom" } } });
    const res = await request(app).post("/api/notifications/3/read");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to mark notification as read" });
  });
});
