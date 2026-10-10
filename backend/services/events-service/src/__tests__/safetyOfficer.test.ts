import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser;
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const safetyOfficer = { id: "SAF-0001", role: "safety_officer" };
const coordinator = { id: "COORD-0001", role: "coordinator" };
const organiser = { id: "ORG-0001", role: "organiser" };
const lead = { id: "LEAD-0001", role: "coordinator_lead" };

type Result = { data: unknown; error: unknown };

/**
 * A chainable stand-in for one supabase-js query: every builder method
 * records its call and returns the query; awaiting it, or ending with
 * maybeSingle()/single(), resolves to `result`.
 */
function query(result: Result = { data: null, error: null }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = { calls };
  for (const method of ["select", "eq", "neq", "is", "in", "order", "limit", "update", "insert"]) {
    q[method] = vi.fn((...args: unknown[]) => {
      calls.push([method, args]);
      return q;
    });
  }
  q.maybeSingle = vi.fn(() => Promise.resolve(result));
  q.single = vi.fn(() => Promise.resolve(result));
  q.then = (resolve: (r: Result) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q as Record<string, any> & { calls: [string, unknown[]][] };
}

function buildSupabase(tables: Record<string, ReturnType<typeof query>[]>) {
  const queues = Object.fromEntries(Object.entries(tables).map(([table, list]) => [table, [...list]]));
  return { from: vi.fn((table: string) => queues[table]?.shift() ?? query()) };
}

function buildApp(supabase: unknown, user: { id: string; role: string }) {
  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = user;
  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return app;
}

function called(q: ReturnType<typeof query>, method: string, ...args: unknown[]): boolean {
  return q.calls.some(([m, a]) => m === method && JSON.stringify(a) === JSON.stringify(args));
}

function event(id: number, proposedDate: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: "Safety Review",
    organiser_id: "ORG-0001",
    coordinator_id: "COORD-0001",
    submitted_details: { name: `Event ${id}`, proposedDate, startTime: "10:00", expectedAttendance: 180 },
    ...overrides,
  };
}

const submission = {
  id: 3,
  event_id: 7,
  equipment_placement: "Speakers on stands either side of the stage, cables taped down.",
  crowd_movement: "Entry by the north doors, exit by the south doors.",
  emergency_access: "Both fire exits kept clear; marshals at each.",
  venue_restrictions: "No naked flames.",
  submitted_at: "2026-10-09T08:00:00Z",
  submitted_by_user: { name: "Coordinator One" },
};

describe("GET /api/events/safety-queue (E1-10)", () => {
  it("lists only events in Safety Review, soonest event first, with when each was submitted (AC1/AC3)", async () => {
    const events = query({ data: [event(8, "2026-12-01"), event(7, "2026-11-14")], error: null });
    const submissions = query({
      data: [
        { event_id: 7, submitted_at: "2026-10-09T08:00:00Z" },
        { event_id: 7, submitted_at: "2026-10-01T08:00:00Z" },
      ],
      error: null,
    });
    const app = buildApp(buildSupabase({ events: [events], event_safety_submissions: [submissions] }), safetyOfficer);

    const res = await request(app).get("/api/events/safety-queue");

    expect(res.status).toBe(200);
    expect(called(events, "eq", "status", "Safety Review")).toBe(true);
    expect(res.body.events.map((e: { id: number }) => e.id)).toEqual([7, 8]);
    // The latest submission's time, not an earlier one.
    expect(res.body.events[0].safety_submitted_at).toBe("2026-10-09T08:00:00Z");
    expect(res.body.events[1].safety_submitted_at).toBeNull();
  });

  it("returns an empty queue without looking up submissions", async () => {
    const submissions = query();
    const app = buildApp(
      buildSupabase({ events: [query({ data: [], error: null })], event_safety_submissions: [submissions] }),
      safetyOfficer,
    );

    const res = await request(app).get("/api/events/safety-queue");

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(submissions.calls).toHaveLength(0);
  });

  it.each([coordinator, organiser, lead])("denies and audits a %s opening the queue directly (AC5)", async (user) => {
    const denials = query();
    const events = query();
    const app = buildApp(buildSupabase({ access_denials: [denials], events: [events] }), user);

    const res = await request(app).get("/api/events/safety-queue");

    expect(res.status).toBe(403);
    expect(events.calls).toHaveLength(0);
    expect(called(denials, "insert", {
      user_id: user.id,
      event_id: "safety_queue",
      reason: "safety_check_role_not_allowed",
    })).toBe(true);
  });
});

describe("GET /api/events/:id/safety-check (E1-10)", () => {
  it("returns the event and the coordinator's latest safety notes (AC2)", async () => {
    const events = query({ data: event(7, "2026-11-14"), error: null });
    const notes = query({ data: submission, error: null });
    const app = buildApp(buildSupabase({ events: [events], event_safety_submissions: [notes] }), safetyOfficer);

    const res = await request(app).get("/api/events/7/safety-check");

    expect(res.status).toBe(200);
    expect(res.body.event.submitted_details.expectedAttendance).toBe(180);
    expect(res.body.safetyNotes).toEqual({
      id: 3,
      equipmentPlacement: submission.equipment_placement,
      crowdMovement: submission.crowd_movement,
      emergencyAccess: submission.emergency_access,
      venueRestrictions: submission.venue_restrictions,
      submittedAt: submission.submitted_at,
      submittedBy: "Coordinator One",
    });
    expect(called(notes, "order", "submitted_at", { ascending: false })).toBe(true);
    expect(called(notes, "limit", 1)).toBe(true);
  });

  it("returns null notes when none were recorded", async () => {
    const app = buildApp(
      buildSupabase({
        events: [query({ data: event(7, "2026-11-14"), error: null })],
        event_safety_submissions: [query({ data: null, error: null })],
      }),
      safetyOfficer,
    );

    const res = await request(app).get("/api/events/7/safety-check");

    expect(res.status).toBe(200);
    expect(res.body.safetyNotes).toBeNull();
  });

  it.each(["Planning", "Confirmed", "Requested", "Rejected"])(
    "refuses the check for an event in %s (AC3)",
    async (status) => {
      const notes = query();
      const app = buildApp(
        buildSupabase({
          events: [query({ data: event(7, "2026-11-14", { status }), error: null })],
          event_safety_submissions: [notes],
        }),
        safetyOfficer,
      );

      const res = await request(app).get("/api/events/7/safety-check");

      expect(res.status).toBe(409);
      expect(notes.calls).toHaveLength(0);
    },
  );

  it("404s an unknown event", async () => {
    const app = buildApp(buildSupabase({ events: [query({ data: null, error: null })] }), safetyOfficer);

    const res = await request(app).get("/api/events/999/safety-check");

    expect(res.status).toBe(404);
  });

  it.each([coordinator, organiser, lead])("denies and audits a %s opening the check directly (AC5)", async (user) => {
    const denials = query();
    const events = query();
    const app = buildApp(buildSupabase({ access_denials: [denials], events: [events] }), user);

    const res = await request(app).get("/api/events/7/safety-check");

    expect(res.status).toBe(403);
    expect(events.calls).toHaveLength(0);
    expect(called(denials, "insert", {
      user_id: user.id,
      event_id: "7",
      reason: "safety_check_role_not_allowed",
    })).toBe(true);
  });
});

describe("Safety Officer access to the event itself (E1-10 AC2/AC4)", () => {
  it("can open an event that's in Safety Review", async () => {
    const app = buildApp(buildSupabase({ events: [query({ data: event(7, "2026-11-14"), error: null })] }), safetyOfficer);

    const res = await request(app).get("/api/events/7");

    expect(res.status).toBe(200);
  });

  it.each(["Planning", "Confirmed", "Draft"])("can't open an event in %s", async (status) => {
    const app = buildApp(
      buildSupabase({ events: [query({ data: event(7, "2026-11-14", { status }), error: null })] }),
      safetyOfficer,
    );

    const res = await request(app).get("/api/events/7");

    expect(res.status).toBe(403);
  });

  it("can't edit the event's details", async () => {
    const lookup = query({ data: { ...event(7, "2026-11-14"), status_before_clarification: null }, error: null });
    const app = buildApp(buildSupabase({ events: [lookup] }), safetyOfficer);

    const res = await request(app).patch("/api/events/7").send({ name: "Changed" });

    expect(res.status).toBe(403);
    expect(lookup.calls.some(([m]) => m === "update")).toBe(false);
  });

  it.each(["approve", "reject", "request-clarification", "assign", "reassign"])(
    "can't use the %s action",
    async (action) => {
      const events = query({ data: event(7, "2026-11-14"), error: null });
      const app = buildApp(buildSupabase({ events: [events] }), safetyOfficer);

      const res = await request(app)
        .post(`/api/events/7/${action}`)
        .send({ reason: "x", message: "x", coordinatorId: "COORD-0002" });

      expect(res.status).toBe(403);
      expect(events.calls.some(([m]) => m === "update")).toBe(false);
    },
  );

  it("isn't listed any events of its own", async () => {
    const events = query({ data: [], error: null });
    const app = buildApp(buildSupabase({ events: [events] }), safetyOfficer);

    await request(app).get("/api/events");

    expect(called(events, "eq", "organiser_id", "SAF-0001")).toBe(true);
  });
});
