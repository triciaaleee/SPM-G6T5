// @ts-nocheck
// 
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

const safetyOfficer = { id: "SAF-0001", role: "safety_officer" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildApp(
  options: {
    user?: { id: string; role: string };
    event?: { id: number; status: string; coordinator_id: string | null; organiser_id: string | null } | null;
    reviewId?: number | null;
    rpcError?: { message: string } | null;
    notificationsFail?: boolean;
  } = {},
) {
  const event =
    options.event === undefined
      ? { id: 7, status: "Safety Review", coordinator_id: "COORD-0001", organiser_id: "ORG-0001" }
      : options.event;

  // authorizeSafetyOfficerReview: .select("id, status, coordinator_id, organiser_id").eq().maybeSingle()
  // the reload afterwards:        .select(EVENT_COLUMNS).eq().single()
  const reloaded = { ...event, status: "Planning", submitted_details: { name: "Spring Gala" } };
  const eventsSelect = vi.fn().mockImplementation(() => ({
    eq: () => ({
      maybeSingle: vi.fn().mockResolvedValue({ data: event, error: null }),
      single: vi.fn().mockResolvedValue({ data: reloaded, error: null }),
    }),
  }));
  const rpc = vi.fn().mockResolvedValue({
    data: options.rpcError ? null : options.reviewId === undefined ? 902 : options.reviewId,
    error: options.rpcError ?? null,
  });

  (globalThis as any).__mockSupabase = {
    from: vi.fn(() => ({ select: eventsSelect })),
    rpc,
  };
  (globalThis as any).__mockUser = options.user ?? safetyOfficer;

  // Nothing else should be called: a rejection must not touch venue-service
  // or equipment-service (bookings and reservations stay).
  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const publish = vi.fn().mockResolvedValue(!options.notificationsFail);
  setPublisherForTest({ publish });

  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return { app, rpc, fetchMock, publish };
}

function reject(app: express.Express, id: number | string = 7, body: unknown = { reason: "Fire exit blocked by staging" }) {
  return request(app).post(`/api/events/${id}/safety-review/reject`).set("Authorization", "Bearer t").send(body as object);
}

describe("POST /api/events/:id/safety-review/reject (E3-13)", () => {
  it("AC1: returns a Safety Review event to Planning and records the decision with the officer and reason", async () => {
    const { app, rpc } = buildApp();
    const res = await reject(app);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Planning");
    expect(res.body.reviewId).toBe(902);
    expect(rpc).toHaveBeenCalledWith("reject_event_safety_review", {
      p_event_id: 7,
      p_officer_id: safetyOfficer.id,
      p_reason: "Fire exit blocked by staging",
    });
  });

  it("AC1: notifies only the assigned coordinator, with the reason", async () => {
    const { app, publish } = buildApp();
    await reject(app);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "safety.decided",
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: expect.objectContaining({
          outcome: "rejected",
          reason: "Fire exit blocked by staging",
          eventName: "Spring Gala",
        }),
      }),
    );
  });

  it("trims the reason before recording it", async () => {
    const { app, rpc } = buildApp();
    await reject(app, 7, { reason: "  Crowd plan missing  " });

    expect(rpc).toHaveBeenCalledWith("reject_event_safety_review", expect.objectContaining({ p_reason: "Crowd plan missing" }));
  });

  it("publishes the full reason without truncation for a long reason", async () => {
    const { app, rpc, publish } = buildApp();
    const longReason = "x".repeat(2000);
    await reject(app, 7, { reason: longReason });

    expect(rpc).toHaveBeenCalledWith("reject_event_safety_review", expect.objectContaining({ p_reason: longReason }));
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: longReason }) }),
    );
  });

  it.each([{}, { reason: "" }, { reason: "   " }, { reason: 42 }])("AC2: blocks a rejection without a reason (%j)", async (body) => {
    const { app, rpc, fetchMock } = buildApp();
    const res = await reject(app, 7, body);

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a reason over 2000 characters", async () => {
    const { app, rpc } = buildApp();
    const res = await reject(app, 7, { reason: "x".repeat(2001) });

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["Draft", "Unassigned", "Requested", "Clarification Requested", "Planning", "Confirmed", "Rejected", "Cancelled", "Completed"])(
    "AC3: blocks an event in %s",
    async (status) => {
      const { app, rpc, fetchMock } = buildApp({ event: { id: 7, status, coordinator_id: "COORD-0001", organiser_id: "ORG-0001" } });
      const res = await reject(app);

      expect(res.status).toBe(409);
      expect(rpc).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["coordinator", "organiser", "coordinator_lead", "venue_staff", "technical_support", "attendee"])(
    "AC3: blocks the %s role",
    async (role) => {
      const { app, rpc } = buildApp({ user: { id: "USR-0001", role } });
      const res = await reject(app);

      expect(res.status).toBe(403);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("returns 409 when the event left Safety Review between the check and the write", async () => {
    const { app, fetchMock } = buildApp({ reviewId: null });
    expect((await reject(app)).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 500 when the decision can't be written", async () => {
    const { app } = buildApp({ rpcError: { message: "boom" } });
    expect((await reject(app)).status).toBe(500);
  });

  it("returns 404 for a malformed event id", async () => {
    const { app } = buildApp();
    expect((await reject(app, "abc")).status).toBe(404);
  });

  it("returns 404 for an unknown event", async () => {
    const { app } = buildApp({ event: null });
    expect((await reject(app)).status).toBe(404);
  });

  it("still returns the rejected event when the notification fails", async () => {
    const { app } = buildApp({ notificationsFail: true });
    const res = await reject(app);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Planning");
  });
});
