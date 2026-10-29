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
  const reloaded = { ...event, status: "Confirmed", submitted_details: { name: "Spring Gala" } };
  const eventsSelect = vi.fn().mockImplementation(() => ({
    eq: () => ({
      maybeSingle: vi.fn().mockResolvedValue({ data: event, error: null }),
      single: vi.fn().mockResolvedValue({ data: reloaded, error: null }),
    }),
  }));
  const rpc = vi.fn().mockResolvedValue({
    data: options.rpcError ? null : options.reviewId === undefined ? 901 : options.reviewId,
    error: options.rpcError ?? null,
  });

  (globalThis as any).__mockSupabase = {
    from: vi.fn(() => ({ select: eventsSelect })),
    rpc,
  };
  (globalThis as any).__mockUser = options.user ?? safetyOfficer;

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

function approve(app: express.Express, id: number | string = 7, body: unknown = {}) {
  return request(app).post(`/api/events/${id}/safety-review/approve`).set("Authorization", "Bearer t").send(body as object);
}

describe("POST /api/events/:id/safety-review/approve (E3-12)", () => {
  it("AC1: moves a Safety Review event to Confirmed, records the decision and notifies the coordinator and organiser", async () => {
    const { app, rpc, publish } = buildApp();
    const res = await approve(app);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Confirmed");
    expect(res.body.reviewId).toBe(901);
    expect(rpc).toHaveBeenCalledWith("approve_event_safety_review", {
      p_event_id: 7,
      p_officer_id: safetyOfficer.id,
      p_reason: null,
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "safety.decided",
        recipients: { userIds: ["COORD-0001", "ORG-0001"], roles: [] },
        data: expect.objectContaining({ outcome: "approved" }),
      }),
    );
  });

  it("passes a trimmed comment through as the decision's reason", async () => {
    const { app, rpc } = buildApp();
    await approve(app, 7, { reason: "  Looks good, approved.  " });

    expect(rpc).toHaveBeenCalledWith("approve_event_safety_review", {
      p_event_id: 7,
      p_officer_id: safetyOfficer.id,
      p_reason: "Looks good, approved.",
    });
  });

  it.each(["Draft", "Unassigned", "Requested", "Clarification Requested", "Planning", "Confirmed", "Rejected", "Cancelled", "Completed"])(
    "AC2: blocks an event in %s",
    async (status) => {
      const { app, rpc } = buildApp({ event: { id: 7, status, coordinator_id: "COORD-0001", organiser_id: "ORG-0001" } });
      const res = await approve(app);

      expect(res.status).toBe(409);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("AC3: blocks any role other than safety_officer", async () => {
    const { app, rpc } = buildApp({ user: { id: "COORD-0001", role: "coordinator" } });
    const res = await approve(app);

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 409 when the event left Safety Review between the check and the write", async () => {
    const { app } = buildApp({ reviewId: null });
    expect((await approve(app)).status).toBe(409);
  });

  it("returns 500 when the decision can't be written", async () => {
    const { app } = buildApp({ rpcError: { message: "boom" } });
    expect((await approve(app)).status).toBe(500);
  });

  it("returns 404 for a malformed event id", async () => {
    const { app } = buildApp();
    const res = await approve(app, "abc");
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown event", async () => {
    const { app } = buildApp({ event: null });
    expect((await approve(app)).status).toBe(404);
  });

  it("still returns the approved event when notifications fail", async () => {
    const { app } = buildApp({ notificationsFail: true });
    const res = await approve(app);
    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Confirmed");
  });

  it("AC4: a resubmission's fresh approval doesn't depend on any earlier decision", async () => {
    // A second approve call (new submission after a prior reject/changes-requested) is just
    // another call into approve_event_safety_review — no state carries over in this layer.
    const { app, rpc } = buildApp({ reviewId: 905 });
    const res = await approve(app);

    expect(res.status).toBe(200);
    expect(res.body.reviewId).toBe(905);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/events/safety-review-queue (E1-10)", () => {
  function buildQueueApp(
    options: {
      user?: { id: string; role: string };
      events?: { id: number; status: string }[];
      submissions?: { event_id: number; equipment_placement: string; crowd_movement: string; emergency_access: string; venue_restrictions: string; submitted_at: string }[];
    } = {},
  ) {
    const events = options.events ?? [{ id: 7, status: "Safety Review" }];
    const submissions = options.submissions ?? [];

    const eventsQuery = {
      eq: () => ({
        order: vi.fn().mockResolvedValue({ data: events, error: null }),
      }),
    };
    const submissionsQuery = {
      in: () => ({
        order: vi.fn().mockResolvedValue({ data: submissions, error: null }),
      }),
    };

    (globalThis as any).__mockSupabase = {
      from: vi.fn((table: string) =>
        table === "access_denials"
          ? { insert: vi.fn().mockResolvedValue({ error: null }) }
          : { select: vi.fn(() => (table === "event_safety_submissions" ? submissionsQuery : eventsQuery)) },
      ),
      rpc: vi.fn(),
    };
    (globalThis as any).__mockUser = options.user ?? safetyOfficer;

    const app = express();
    app.use(express.json());
    app.use("/api/events", eventsRouter);
    return { app };
  }

  it("AC1: lists events in Safety Review with their latest safety notes", async () => {
    const { app } = buildQueueApp({
      events: [{ id: 7, status: "Safety Review" }],
      submissions: [
        {
          event_id: 7,
          equipment_placement: "Back of hall",
          crowd_movement: "Single file",
          emergency_access: "East exit clear",
          venue_restrictions: "None known",
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const res = await request(app).get("/api/events/safety-review-queue").set("Authorization", "Bearer t");

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].safetyNotes).toEqual({
      equipmentPlacement: "Back of hall",
      crowdMovement: "Single file",
      emergencyAccess: "East exit clear",
      venueRestrictions: "None known",
    });
  });

  it("E3-4 AC4: uses only the most recent submission when an event was resubmitted", async () => {
    const { app } = buildQueueApp({
      // The route relies on the query being ordered newest-first (submitted_at desc)
      // and keeps the first submission it sees per event — mirror that order here.
      submissions: [
        {
          event_id: 7,
          equipment_placement: "new",
          crowd_movement: "new",
          emergency_access: "new",
          venue_restrictions: "new",
          submitted_at: "2026-02-01T00:00:00Z",
        },
        {
          event_id: 7,
          equipment_placement: "old",
          crowd_movement: "old",
          emergency_access: "old",
          venue_restrictions: "old",
          submitted_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const res = await request(app).get("/api/events/safety-review-queue").set("Authorization", "Bearer t");

    expect(res.body.events[0].safetyNotes.equipmentPlacement).toBe("new");
  });

  it("AC5: blocks any role other than safety_officer", async () => {
    const { app } = buildQueueApp({ user: { id: "COORD-0001", role: "coordinator" } });
    const res = await request(app).get("/api/events/safety-review-queue").set("Authorization", "Bearer t");
    expect(res.status).toBe(403);
  });
});
