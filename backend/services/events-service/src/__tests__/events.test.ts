import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = { id: "user-1" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

function buildApp(mockSupabase: unknown) {
  (globalThis as any).__mockSupabase = mockSupabase;
  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return app;
}

describe("GET /api/events", () => {
  it("returns only the caller's events", async () => {
    const eq = vi.fn().mockResolvedValue({
      data: [{ id: "e1", status: "submitted" }],
      error: null,
    });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });

    const app = buildApp({ from });
    const res = await request(app).get("/api/events");

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(eq).toHaveBeenCalledWith("organiser_id", "user-1");
  });
});

describe("GET /api/events/:id", () => {
  it("denies access and logs when the event isn't owned by the caller", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const insert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "access_denials") return { insert };
      return { select };
    });

    const app = buildApp({ from });
    const res = await request(app).get("/api/events/other-users-event");

    expect(res.status).toBe(403);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1", event_id: "other-users-event" }),
    );
  });

  it("returns the event when the caller owns it", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: "e1",
        status: "approved",
        submitted_details: {},
        coordinator_id: "coord-1",
        review_outcome: "approved",
        created_at: "2026-01-01",
        organiser_id: "user-1",
      },
      error: null,
    });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });

    const app = buildApp({ from });
    const res = await request(app).get("/api/events/e1");

    expect(res.status).toBe(200);
    expect(res.body.event.id).toBe("e1");
    expect(res.body.event.organiser_id).toBeUndefined();
  });
});
