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

function buildApp(options: { user?: { id: string; role: string }; rows?: unknown[]; unread?: number } = {}) {
  const listQuery = query({ data: options.rows ?? [row], error: null });
  const countQuery = query({ data: null, count: options.unread ?? 1, error: null });
  const updateQuery = query({ data: null, error: null });

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
