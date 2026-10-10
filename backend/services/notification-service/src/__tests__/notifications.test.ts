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
  for (const method of ["select", "eq", "is", "order", "limit", "update"]) q[method] = vi.fn(() => q);
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
  read_at: null,
  created_at: "2026-10-08T01:00:00Z",
};

function buildApp(options: { user?: { id: string; role: string }; rows?: unknown[]; unread?: number; insertError?: unknown } = {}) {
  const listQuery = query({ data: options.rows ?? [row], error: null });
  const countQuery = query({ data: null, count: options.unread ?? 1, error: null });
  const updateQuery = query({ data: null, error: null });
  const insert = vi.fn().mockResolvedValue({ error: options.insertError ?? null });

  // GET makes two .from("notifications") calls: the list, then the unread count.
  let selects = 0;
  const supabase = {
    from: vi.fn(() => ({
      select: (...args: unknown[]) => (selects++ === 0 ? listQuery : countQuery).select(...args),
      update: updateQuery.update,
      insert,
    })),
  };

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

  const app = express();
  app.use(express.json());
  app.use("/api/notifications", notificationsRouter);
  return { app, supabase, listQuery, countQuery, updateQuery, insert };
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
          read: false,
          createdAt: row.created_at,
        },
      ],
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

describe("POST /api/notifications", () => {
  const venueStaff = { id: "VEN-0001", role: "venue_staff" };
  const valid = { recipientId: "COORD-0001", type: "venue_unavailable", title: "Title", body: "Body", link: "/events/7" };

  it("creates notifications for other users", async () => {
    const { app, insert } = buildApp({ user: venueStaff });

    const res = await request(app).post("/api/notifications").send({ notifications: [valid] });

    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledWith([
      { recipient_id: "COORD-0001", type: "venue_unavailable", title: "Title", body: "Body", link: "/events/7" },
    ]);
  });

  it("lets the Event Coordinator Lead notify about assignments (E2-13, E2-12)", async () => {
    const { app, insert } = buildApp({ user: { id: "LEAD-0001", role: "coordinator_lead" } });

    const res = await request(app)
      .post("/api/notifications")
      .send({ notifications: [{ ...valid, type: "event_assigned" }] });

    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalled();
  });

  it("rejects attendees", async () => {
    const { app, insert } = buildApp({ user: { id: "ATT-0001", role: "attendee" } });

    const res = await request(app).post("/api/notifications").send({ notifications: [valid] });

    expect(res.status).toBe(403);
    expect(insert).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty batch", { notifications: [] }],
    ["a missing recipient", { notifications: [{ ...valid, recipientId: "" }] }],
    ["an off-site link", { notifications: [{ ...valid, link: "https://evil.example" }] }],
    ["a protocol-relative link", { notifications: [{ ...valid, link: "//evil.example" }] }],
  ])("returns 400 for %s", async (_label, body) => {
    const { app, insert } = buildApp({ user: venueStaff });

    const res = await request(app).post("/api/notifications").send(body);

    expect(res.status).toBe(400);
    expect(insert).not.toHaveBeenCalled();
  });
});
