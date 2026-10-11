import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { fetchCoordinators } from "../lib/usersClient.js";
import { sendNotifications } from "../lib/notificationsClient.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser;
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

vi.mock("../lib/usersClient.js", () => ({ fetchCoordinators: vi.fn() }));
vi.mock("../lib/notificationsClient.js", () => ({ sendNotifications: vi.fn() }));

const lead = { id: "LEAD-0001", role: "coordinator_lead" };
const coordinator = { id: "COORD-0001", role: "coordinator" };
const organiser = { id: "ORG-0001", role: "organiser" };

const COORDINATORS = [
  { id: "COORD-0001", name: "Coordinator One" },
  { id: "COORD-0002", name: "Coordinator Two" },
];

type Result = { data: unknown; error: unknown };

/**
 * A chainable stand-in for one supabase-js query. Every builder method
 * records its call and returns the query again; awaiting it, or ending
 * with maybeSingle()/single(), resolves to `result`.
 */
function query(result: Result = { data: null, error: null }) {
  const calls: [string, unknown[]][] = [];
  const q: Record<string, unknown> = { calls };
  for (const method of ["select", "eq", "neq", "is", "in", "order", "update", "insert"]) {
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

/** Hands out the queued queries for each table in call order. */
function buildSupabase(tables: Record<string, ReturnType<typeof query>[]>) {
  const queues = Object.fromEntries(Object.entries(tables).map(([table, list]) => [table, [...list]]));
  const from = vi.fn((table: string) => {
    const next = queues[table]?.shift();
    return next ?? query();
  });
  return { from };
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

beforeEach(() => {
  vi.mocked(fetchCoordinators).mockReset().mockResolvedValue({ status: "ok", coordinators: COORDINATORS });
  vi.mocked(sendNotifications).mockReset().mockResolvedValue(true);
});

const unassignedEvent = {
  id: 7,
  status: "Unassigned",
  organiser_id: "ORG-0001",
  coordinator_id: null,
  coordinator: null,
  submitted_details: { name: "Robotics Demo Day", proposedDate: "2099-09-28" },
};

const assignedEvent = {
  ...unassignedEvent,
  status: "Planning",
  coordinator_id: "COORD-0001",
  coordinator: { name: "Coordinator One" },
};

describe("GET /api/events/unassigned (E1-8)", () => {
  it("lists Unassigned requests with no coordinator, oldest submission first (AC1)", async () => {
    const events = [
      { id: 6, status: "Unassigned", submitted_details: { name: "Robotics Demo Day" }, created_at: "2026-10-01" },
    ];
    const eventsQuery = query({ data: events, error: null });
    const app = buildApp(buildSupabase({ events: [eventsQuery] }), lead);

    const res = await request(app).get("/api/events/unassigned");

    expect(res.status).toBe(200);
    expect(res.body.events).toEqual(events);
    expect(called(eventsQuery, "eq", "status", "Unassigned")).toBe(true);
    expect(called(eventsQuery, "is", "coordinator_id", null)).toBe(true);
    expect(called(eventsQuery, "order", "created_at", { ascending: true })).toBe(true);
    // The embedded columns carry what AC1 shows: event name and date
    // (submitted_details) and the submission date (created_at).
    const [, selectArgs] = eventsQuery.calls.find(([m]) => m === "select")!;
    expect(selectArgs[0]).toEqual(expect.stringContaining("submitted_details"));
    expect(selectArgs[0]).toEqual(expect.stringContaining("created_at"));
  });

  it.each([coordinator, organiser, { id: "VEN-0001", role: "venue_staff" }])(
    "denies and audits a %s opening the queue directly (AC3)",
    async (user) => {
      const denials = query({ data: null, error: null });
      const eventsQuery = query();
      const app = buildApp(buildSupabase({ access_denials: [denials], events: [eventsQuery] }), user);

      const res = await request(app).get("/api/events/unassigned");

      expect(res.status).toBe(403);
      expect(called(denials, "insert", {
        user_id: user.id,
        event_id: "unassigned_queue",
        reason: "unassigned_queue_role_not_allowed",
      })).toBe(true);
      expect(eventsQuery.calls).toHaveLength(0);
    },
  );
});

describe("Event Coordinator Lead read access (E1-8 AC2)", () => {
  it("lets the Lead open a submitted request from the queue", async () => {
    const eventsQuery = query({ data: { ...unassignedEvent, organiser_id: "ORG-0002" }, error: null });
    const app = buildApp(buildSupabase({ events: [eventsQuery] }), lead);

    const res = await request(app).get("/api/events/7");

    expect(res.status).toBe(200);
    expect(res.body.event.id).toBe(7);
  });

  it("does not let the Lead open someone's draft", async () => {
    const eventsQuery = query({ data: { ...unassignedEvent, status: "Draft" }, error: null });
    const app = buildApp(buildSupabase({ events: [eventsQuery] }), lead);

    const res = await request(app).get("/api/events/7");

    expect(res.status).toBe(403);
  });

  it("lists every submitted event for the Lead, without filtering by organiser", async () => {
    const eventsQuery = query({ data: [assignedEvent], error: null });
    const app = buildApp(buildSupabase({ events: [eventsQuery] }), lead);

    const res = await request(app).get("/api/events");

    expect(res.status).toBe(200);
    expect(called(eventsQuery, "neq", "status", "Draft")).toBe(true);
    expect(eventsQuery.calls.some(([m, a]) => m === "eq" && a[0] === "organiser_id")).toBe(false);
  });

  it("lets the Lead read the event history", async () => {
    const eventQuery = query({ data: { id: 7, status: "Requested", organiser_id: "ORG-0002", coordinator_id: "COORD-0001" }, error: null });
    const historyQuery = query({ data: [{ id: 1, field: "Coordinator" }], error: null });
    const app = buildApp(buildSupabase({ events: [eventQuery], event_history: [historyQuery] }), lead);

    const res = await request(app).get("/api/events/7/history");

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(1);
  });

  it("does not let the Lead edit a request's details", async () => {
    const eventQuery = query({ data: { ...unassignedEvent, organiser_id: "ORG-0002", status_before_clarification: null }, error: null });
    const app = buildApp(buildSupabase({ events: [eventQuery] }), lead);

    const res = await request(app).patch("/api/events/7").send({ name: "Changed" });

    expect(res.status).toBe(403);
    expect(eventQuery.calls.some(([m]) => m === "update")).toBe(false);
  });

  it.each(["approve", "reject", "request-clarification"])("does not let the Lead %s a request", async (action) => {
    const eventsQuery = query();
    const app = buildApp(buildSupabase({ events: [eventsQuery] }), lead);

    const res = await request(app).post(`/api/events/7/${action}`).send({ reason: "x", message: "x" });

    expect(res.status).toBe(403);
    expect(eventsQuery.calls).toHaveLength(0);
  });
});

describe("POST /api/events/:id/assign (E2-13)", () => {
  it("assigns the coordinator, moves the request to Requested and notifies both parties (AC1)", async () => {
    const lookup = query({ data: unassignedEvent, error: null });
    const updated = { id: 7, status: "Requested", coordinator_id: "COORD-0002", coordinator: { name: "Coordinator Two" } };
    const write = query({ data: updated, error: null });
    const history = query({ data: null, error: null });
    const app = buildApp(buildSupabase({ events: [lookup, write], event_history: [history] }), lead);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual(updated);
    expect(res.body.notificationsFailed).toBe(false);
    expect(called(write, "update", { status: "Requested", coordinator_id: "COORD-0002" })).toBe(true);
    // Only matches while still unassigned, so two Leads can't both assign it.
    expect(called(write, "eq", "status", "Unassigned")).toBe(true);
    expect(called(write, "is", "coordinator_id", null)).toBe(true);

    expect(called(history, "insert", [
      { event_id: 7, field: "Coordinator", old_value: null, new_value: "Coordinator Two", changed_by: "LEAD-0001" },
      { event_id: 7, field: "Status", old_value: "Unassigned", new_value: "Requested", changed_by: "LEAD-0001" },
    ])).toBe(true);

    const [notifications] = vi.mocked(sendNotifications).mock.calls[0];
    expect(notifications.map((n) => n.recipientId)).toEqual(["COORD-0002", "ORG-0001"]);
    expect(notifications.every((n) => n.link === "/events/7")).toBe(true);
  });

  it("blocks assigning an event that already has a coordinator (AC2)", async () => {
    const lookup = query({ data: { ...unassignedEvent, status: "Requested", coordinator_id: "COORD-0001" }, error: null });
    const write = query();
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/reassign/i);
    expect(write.calls).toHaveLength(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it("blocks assigning a request that isn't in the unassigned queue", async () => {
    const lookup = query({ data: { ...unassignedEvent, status: "Rejected" }, error: null });
    const write = query();
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(409);
    expect(write.calls).toHaveLength(0);
  });

  it("leaves the request Unassigned when no active coordinators exist (AC3)", async () => {
    vi.mocked(fetchCoordinators).mockResolvedValue({ status: "ok", coordinators: [] });
    const lookup = query({ data: unassignedEvent, error: null });
    const write = query();
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "COORD-0001" });

    expect(res.status).toBe(400);
    expect(write.calls).toHaveLength(0);
  });

  it("rejects a user who isn't an active coordinator", async () => {
    const lookup = query({ data: unassignedEvent, error: null });
    const write = query();
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "ORG-0002" });

    expect(res.status).toBe(400);
    expect(write.calls).toHaveLength(0);
  });

  it("requires a coordinator to be chosen", async () => {
    const app = buildApp(buildSupabase({}), lead);

    const res = await request(app).post("/api/events/7/assign").send({});

    expect(res.status).toBe(400);
  });

  it.each([coordinator, organiser])("blocks and audits a %s assigning directly via the API (AC4)", async (user) => {
    const denials = query();
    const lookup = query();
    const app = buildApp(buildSupabase({ access_denials: [denials], events: [lookup] }), user);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "COORD-0001" });

    expect(res.status).toBe(403);
    expect(lookup.calls).toHaveLength(0);
    expect(called(denials, "insert", { user_id: user.id, event_id: "7", reason: "assignment_role_not_allowed" })).toBe(true);
  });

  it("returns 409 when another Lead assigned it first", async () => {
    const lookup = query({ data: unassignedEvent, error: null });
    const write = query({ data: null, error: null });
    const history = query();
    const app = buildApp(buildSupabase({ events: [lookup, write], event_history: [history] }), lead);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(409);
    expect(history.calls).toHaveLength(0);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it("returns 502 when the coordinator list can't be loaded", async () => {
    vi.mocked(fetchCoordinators).mockResolvedValue({ status: "error" });
    const lookup = query({ data: unassignedEvent, error: null });
    const app = buildApp(buildSupabase({ events: [lookup] }), lead);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(502);
  });

  it("keeps the assignment when notifications fail, and says so", async () => {
    vi.mocked(sendNotifications).mockResolvedValue(false);
    const lookup = query({ data: unassignedEvent, error: null });
    const write = query({ data: { id: 7, status: "Requested" }, error: null });
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(200);
    expect(res.body.notificationsFailed).toBe(true);
  });

  it("treats a draft as not found", async () => {
    const lookup = query({ data: { ...unassignedEvent, status: "Draft" }, error: null });
    const app = buildApp(buildSupabase({ events: [lookup] }), lead);

    const res = await request(app).post("/api/events/7/assign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/events/:id/reassign (E2-12)", () => {
  it("hands the event to the new coordinator without changing its status, and records it (AC1/AC2)", async () => {
    const lookup = query({ data: assignedEvent, error: null });
    const updated = { ...assignedEvent, coordinator_id: "COORD-0002", coordinator: { name: "Coordinator Two" } };
    const write = query({ data: updated, error: null });
    const history = query();
    const app = buildApp(buildSupabase({ events: [lookup, write], event_history: [history] }), lead);

    const res = await request(app).post("/api/events/7/reassign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(200);
    expect(res.body.event.coordinator_id).toBe("COORD-0002");
    expect(called(write, "update", { coordinator_id: "COORD-0002" })).toBe(true);
    // Only matches while the previous coordinator is still assigned.
    expect(called(write, "eq", "coordinator_id", "COORD-0001")).toBe(true);
    expect(called(write, "eq", "status", "Planning")).toBe(true);

    // AC2: previous coordinator, new coordinator, by whom (changed_by); the
    // date and time is the row's changed_at default.
    expect(called(history, "insert", [
      {
        event_id: 7,
        field: "Coordinator",
        old_value: "Coordinator One",
        new_value: "Coordinator Two",
        changed_by: "LEAD-0001",
      },
    ])).toBe(true);
  });

  it("notifies the Organiser, the previous coordinator and the new coordinator (AC7)", async () => {
    const lookup = query({ data: assignedEvent, error: null });
    const write = query({ data: { id: 7 }, error: null });
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    await request(app).post("/api/events/7/reassign").send({ coordinatorId: "COORD-0002" });

    const [notifications] = vi.mocked(sendNotifications).mock.calls[0];
    expect(notifications.map((n) => n.recipientId)).toEqual(["ORG-0001", "COORD-0001", "COORD-0002"]);
  });

  it.each(["Requested", "Clarification Requested", "Planning", "Safety Review", "Confirmed"])(
    "allows reassigning an event in %s",
    async (status) => {
      const lookup = query({ data: { ...assignedEvent, status }, error: null });
      const write = query({ data: { id: 7, status }, error: null });
      const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

      const res = await request(app).post("/api/events/7/reassign").send({ coordinatorId: "COORD-0002" });

      expect(res.status).toBe(200);
    },
  );

  it.each(["Rejected", "Cancelled", "Completed"])("blocks reassigning a %s event with an explanation (AC3)", async (status) => {
    const lookup = query({ data: { ...assignedEvent, status }, error: null });
    const write = query();
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    const res = await request(app).post("/api/events/7/reassign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/closed events cannot be reassigned/i);
    expect(write.calls).toHaveLength(0);
  });

  it("sends an event with no coordinator to assignment instead (AC4)", async () => {
    const lookup = query({ data: unassignedEvent, error: null });
    const write = query();
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    const res = await request(app).post("/api/events/7/reassign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/assign/i);
    expect(write.calls).toHaveLength(0);
  });

  it("requires a different coordinator from the current one", async () => {
    const lookup = query({ data: assignedEvent, error: null });
    const write = query();
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    const res = await request(app).post("/api/events/7/reassign").send({ coordinatorId: "COORD-0001" });

    expect(res.status).toBe(400);
    expect(write.calls).toHaveLength(0);
  });

  it("only accepts an active coordinator", async () => {
    const lookup = query({ data: assignedEvent, error: null });
    const app = buildApp(buildSupabase({ events: [lookup] }), lead);

    const res = await request(app).post("/api/events/7/reassign").send({ coordinatorId: "TS-0001" });

    expect(res.status).toBe(400);
  });

  it.each([coordinator, organiser])("blocks a %s reassigning directly via the API (AC5)", async (user) => {
    const lookup = query();
    const app = buildApp(buildSupabase({ events: [lookup] }), user);

    const res = await request(app).post("/api/events/7/reassign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(403);
    expect(lookup.calls).toHaveLength(0);
  });

  it("returns 409 when the event changed under the Lead", async () => {
    const lookup = query({ data: assignedEvent, error: null });
    const write = query({ data: null, error: null });
    const app = buildApp(buildSupabase({ events: [lookup, write] }), lead);

    const res = await request(app).post("/api/events/7/reassign").send({ coordinatorId: "COORD-0002" });

    expect(res.status).toBe(409);
    expect(sendNotifications).not.toHaveBeenCalled();
  });

  it("blocks the previous coordinator's actions once reassigned (AC6)", async () => {
    // After the reassignment the row names COORD-0002, so COORD-0001's
    // approve hits the ownership check.
    const lookup = query({ data: { id: 7, status: "Requested", coordinator_id: "COORD-0002" }, error: null });
    const denials = query();
    const app = buildApp(buildSupabase({ events: [lookup], access_denials: [denials] }), coordinator);

    const res = await request(app).post("/api/events/7/approve");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/another coordinator/i);
  });

  it("lets the new coordinator act as soon as it's reassigned (AC6)", async () => {
    const lookup = query({ data: { id: 7, status: "Requested", coordinator_id: "COORD-0002" }, error: null });
    const write = query({ data: { id: 7, status: "Planning" }, error: null });
    const app = buildApp(buildSupabase({ events: [lookup, write] }), { id: "COORD-0002", role: "coordinator" });

    const res = await request(app).post("/api/events/7/approve");

    expect(res.status).toBe(200);
  });
});
