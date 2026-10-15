import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

const decisions = [
  {
    id: 1,
    outcome: "Rejected",
    reason: "Fire exit blocked by staging",
    submission_id: 10,
    officer: { name: "Sam Safety" },
    created_at: "2026-10-01T02:00:00Z",
  },
  {
    id: 2,
    outcome: "Approved",
    reason: null,
    submission_id: 11,
    officer: { name: "Sam Safety" },
    created_at: "2026-10-03T02:00:00Z",
  },
];

function buildApp(
  options: {
    user?: { id: string; role: string };
    event?: { id: number; status: string; organiser_id: string; coordinator_id: string | null } | null;
    reviewsError?: { message: string } | null;
  } = {},
) {
  const event =
    options.event === undefined
      ? { id: 7, status: "Planning", organiser_id: "ORG-0001", coordinator_id: "COORD-0001" }
      : options.event;

  const reviewsOrder = vi.fn().mockResolvedValue({
    data: options.reviewsError ? null : decisions,
    error: options.reviewsError ?? null,
  });
  const reviewsEq = vi.fn(() => ({ order: reviewsOrder }));
  const accessDenialInsert = vi.fn().mockResolvedValue({ error: null });

  (globalThis as any).__mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === "access_denials") return { insert: accessDenialInsert };
      if (table === "event_safety_reviews") return { select: vi.fn(() => ({ eq: reviewsEq })) };
      // loadEventForClarification: .select(...).eq().maybeSingle()
      return {
        select: vi.fn(() => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: event, error: null }) }) })),
      };
    }),
  };
  (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return { app, reviewsEq, reviewsOrder, accessDenialInsert };
}

function get(app: express.Express, id: number | string = 7) {
  return request(app).get(`/api/events/${id}/safety-reviews`).set("Authorization", "Bearer t");
}

describe("GET /api/events/:id/safety-reviews (E3-12/13/14)", () => {
  it("lists the event's safety decisions oldest first, with the officer's name and reason", async () => {
    const { app, reviewsEq, reviewsOrder } = buildApp();
    const res = await get(app);

    expect(res.status).toBe(200);
    expect(res.body.safetyReviews).toEqual(decisions);
    expect(reviewsEq).toHaveBeenCalledWith("event_id", 7);
    expect(reviewsOrder).toHaveBeenCalledWith("created_at", { ascending: true });
  });

  it("is visible to the owning organiser", async () => {
    const { app } = buildApp({ user: { id: "ORG-0001", role: "organiser" } });
    expect((await get(app)).status).toBe(200);
  });

  it("is visible to the Event Coordinator Lead", async () => {
    const { app } = buildApp({ user: { id: "LEAD-0001", role: "coordinator_lead" } });
    expect((await get(app)).status).toBe(200);
  });

  it("blocks another organiser and records the attempt", async () => {
    const { app, accessDenialInsert } = buildApp({ user: { id: "ORG-0002", role: "organiser" } });
    expect((await get(app)).status).toBe(403);
    expect(accessDenialInsert).toHaveBeenCalled();
  });

  it.each(["venue_staff", "technical_support", "attendee"])("blocks the %s role", async (role) => {
    const { app } = buildApp({ user: { id: "USR-0001", role } });
    expect((await get(app)).status).toBe(403);
  });

  it("returns 404 for a malformed event id", async () => {
    const { app } = buildApp();
    expect((await get(app, "abc")).status).toBe(404);
  });

  it("returns 403 for an unknown event", async () => {
    const { app } = buildApp({ event: null });
    expect((await get(app)).status).toBe(403);
  });

  it("returns 500 when the decisions can't be loaded", async () => {
    const { app } = buildApp({ reviewsError: { message: "boom" } });
    expect((await get(app)).status).toBe(500);
  });
});
