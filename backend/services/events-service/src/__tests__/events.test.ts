import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "user-1", role: "organiser" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const validPayload = {
  name: "Freshman Orientation",
  purpose: "Welcome new students",
  description: "Campus tour and icebreakers",
  proposedDate: "2099-01-01",
  startTime: "09:00",
  endTime: "11:00",
  expectedAttendance: 50,
  venue: "Main Hall",
  accessibility: "Wheelchair ramp access",
  equipment: "Projector and 100 chairs",
  technicalSupport: "AV technician on-site",
};

function buildApp(mockSupabase: unknown, user: { id: string; role: string } = { id: "user-1", role: "organiser" }) {
  (globalThis as any).__mockSupabase = mockSupabase;
  (globalThis as any).__mockUser = user;
  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return app;
}

const coordinator = { id: "COORD-0001", role: "coordinator" };

/** Builds a mock supabase client covering the two `.from("events")` calls
 * every decision route makes (the authorizeCoordinatorReview lookup, then
 * the update), plus `.from("access_denials")` for the mismatch case. */
function buildReviewSupabase(options: {
  event: { id: number; status: string; coordinator_id: string | null } | null;
  updatedEvent?: Record<string, unknown>;
  updateError?: { message: string } | null;
  /** Top-level questions /approve checks when status is "Clarification
   * Requested" — defaults to one unresolved question, so callers that
   * don't care about this still exercise the "still outstanding" path. */
  openQuestions?: { id: number; resolved: boolean }[];
  /** The question /resolve looks up before updating it. */
  question?: { id: number; event_id: number; parent_id: number | null } | null;
  resolvedQuestion?: Record<string, unknown>;
}) {
  const {
    event,
    updatedEvent,
    updateError = null,
    openQuestions = [{ id: 1, resolved: false }],
    question,
    resolvedQuestion,
  } = options;

  const maybeSingle = vi.fn().mockResolvedValue({ data: event, error: null });
  const lookupEq = vi.fn().mockReturnValue({ maybeSingle });
  const lookupSelect = vi.fn().mockReturnValue({ eq: lookupEq });

  const single = vi.fn().mockResolvedValue({ data: updatedEvent ?? null, error: updateError });
  const updateSelect = vi.fn().mockReturnValue({ single });
  const updateEq = vi.fn().mockReturnValue({ select: updateSelect });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  const denialInsert = vi.fn().mockResolvedValue({ error: null });

  // request-clarification writes the thread's first question row via a
  // bare `await ...insert(...)` (no `.select()`); the new-question route
  // chains `.select().single()` off the same call. A real Promise with a
  // `.select` property attached satisfies both shapes.
  const clarificationInsert = vi.fn().mockImplementation(() => {
    const result = Promise.resolve({ error: null }) as Promise<{ error: null }> & {
      select: ReturnType<typeof vi.fn>;
    };
    result.select = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: { id: 99 }, error: null }),
    });
    return result;
  });

  // /approve's "any question still unresolved?" check:
  // .select("id, resolved").eq("event_id", id).is("parent_id", null)
  const clarificationIs = vi.fn().mockResolvedValue({ data: openQuestions, error: null });
  const clarificationEq = vi.fn().mockReturnValue({ is: clarificationIs });
  const clarificationListSelect = vi.fn().mockReturnValue({ eq: clarificationEq });

  // /resolve's question lookup: .select("id, event_id, parent_id").eq("id", id).maybeSingle()
  const questionMaybeSingle = vi.fn().mockResolvedValue({ data: question ?? null, error: null });
  const questionEq = vi.fn().mockReturnValue({ maybeSingle: questionMaybeSingle });
  const clarificationSelect = vi.fn().mockImplementation((columns: string) => {
    if (columns === "id, event_id, parent_id") return { eq: questionEq };
    return clarificationListSelect(columns);
  });

  // /resolve's write: .update({resolved:true}).eq("id", id).select(...).single()
  const resolveSingle = vi.fn().mockResolvedValue({ data: resolvedQuestion ?? null, error: null });
  const resolveSelect = vi.fn().mockReturnValue({ single: resolveSingle });
  const resolveEq = vi.fn().mockReturnValue({ select: resolveSelect });
  const clarificationUpdate = vi.fn().mockReturnValue({ eq: resolveEq });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "access_denials") return { insert: denialInsert };
    if (table === "event_clarifications") {
      return { insert: clarificationInsert, select: clarificationSelect, update: clarificationUpdate };
    }
    return { select: lookupSelect, update };
  });

  return {
    from,
    update,
    updateEq,
    updateSelect,
    denialInsert,
    clarificationInsert,
    clarificationListSelect,
    clarificationUpdate,
  };
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

  it("returns all events for a coordinator without filtering by organiser (E1-4.1)", async () => {
    const nonDraftEvents = [
      { id: 1, status: "Requested", organiser_id: "user-1" },
      { id: 2, status: "Planning", organiser_id: "user-2" },
    ];
    const eq = vi.fn();
    const neq = vi.fn().mockResolvedValue({ data: nonDraftEvents, error: null });
    const select = vi.fn().mockReturnValue({ eq, neq });
    const from = vi.fn().mockReturnValue({ select });

    const app = buildApp({ from }, coordinator);
    const res = await request(app).get("/api/events");

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(2);
    expect(eq).not.toHaveBeenCalledWith("organiser_id", expect.anything());
  });

  it("excludes drafts from a coordinator's list (E2-5.1 AC2)", async () => {
    const eq = vi.fn();
    const neq = vi.fn().mockResolvedValue({ data: [], error: null });
    const select = vi.fn().mockReturnValue({ eq, neq });
    const from = vi.fn().mockReturnValue({ select });

    const app = buildApp({ from }, coordinator);
    const res = await request(app).get("/api/events");

    expect(res.status).toBe(200);
    expect(neq).toHaveBeenCalledWith("status", "Draft");
  });

  it("does not exclude drafts from an organiser's own list (E2-5.1 AC1)", async () => {
    const eq = vi.fn().mockResolvedValue({
      data: [{ id: "d1", status: "Draft" }],
      error: null,
    });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });

    const app = buildApp({ from });
    const res = await request(app).get("/api/events");

    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].status).toBe("Draft");
  });
});

describe("GET /api/events/:id", () => {
  const otherUsersEventId = "42";

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
    const res = await request(app).get(`/api/events/${otherUsersEventId}`);

    expect(res.status).toBe(403);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1", event_id: otherUsersEventId }),
    );
  });

  it("denies access and logs when the id is not a valid integer, without querying the DB", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const select = vi.fn();
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "access_denials") return { insert };
      return { select };
    });

    const app = buildApp({ from });
    const res = await request(app).get("/api/events/abc");

    expect(res.status).toBe(403);
    expect(select).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: "user-1", reason: "invalid_id_format" }),
    );
  });

  it("logs server-side but still returns 403 if the audit insert itself fails", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const insert = vi.fn().mockResolvedValue({ error: { message: "insert failed" } });
    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "access_denials") return { insert };
      return { select };
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const app = buildApp({ from });
    const res = await request(app).get(`/api/events/${otherUsersEventId}`);

    expect(res.status).toBe(403);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("allows a coordinator to access an event they did not organise (E1-4.1)", async () => {
    const eventId = "5";
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: Number(eventId),
        status: "Requested",
        submitted_details: {},
        coordinator_id: null,
        review_outcome: null,
        created_at: "2026-01-01",
        organiser_id: "someone-else",
      },
      error: null,
    });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });

    const app = buildApp({ from }, coordinator);
    const res = await request(app).get(`/api/events/${eventId}`);

    expect(res.status).toBe(200);
    expect(res.body.event.id).toBe(Number(eventId));
    expect(res.body.event.organiser_id).toBeUndefined();
  });

  it("returns the event when the caller owns it", async () => {
    const ownedEventId = "1";
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: Number(ownedEventId),
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
    const res = await request(app).get(`/api/events/${ownedEventId}`);

    expect(res.status).toBe(200);
    expect(res.body.event.id).toBe(Number(ownedEventId));
    expect(res.body.event.organiser_id).toBeUndefined();
  });
});

/**
 * E2-6: mocks the two lookups assignCoordinator makes (active coordinators,
 * most recently auto-assigned event) plus the actual events.insert(...).
 * `coordinators` is the round-robin order; `lastAssignedCoordinatorId`
 * simulates prior submissions having already rotated through some of them.
 */
function buildSubmitSupabase(options: {
  coordinators?: string[];
  lastAssignedCoordinatorId?: string | null;
  insertedEvent?: Record<string, unknown> | null;
  insertError?: { message: string } | null;
}) {
  const {
    coordinators = [],
    lastAssignedCoordinatorId = null,
    insertedEvent = null,
    insertError = null,
  } = options;

  const usersOrder = vi.fn().mockResolvedValue({
    data: coordinators.map((id) => ({ id })),
    error: null,
  });
  const usersEq = vi.fn().mockReturnValue({ order: usersOrder });
  const usersSelect = vi.fn().mockReturnValue({ eq: usersEq });

  const lastAssignedMaybeSingle = vi.fn().mockResolvedValue({
    data: lastAssignedCoordinatorId ? { coordinator_id: lastAssignedCoordinatorId } : null,
    error: null,
  });
  const lastAssignedLimit = vi.fn().mockReturnValue({ maybeSingle: lastAssignedMaybeSingle });
  const lastAssignedOrder = vi.fn().mockReturnValue({ limit: lastAssignedLimit });
  const lastAssignedNot = vi.fn().mockReturnValue({ order: lastAssignedOrder });
  const eventsSelect = vi.fn().mockReturnValue({ not: lastAssignedNot });

  const insertSingle = vi.fn().mockResolvedValue({ data: insertedEvent, error: insertError });
  const insertSelect = vi.fn().mockReturnValue({ single: insertSingle });
  const insert = vi.fn().mockReturnValue({ select: insertSelect });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "users") return { select: usersSelect };
    if (table === "events") return { select: eventsSelect, insert };
    return {};
  });

  return { from, insert };
}

describe("POST /api/events", () => {
  it("creates the request with status Requested when a coordinator is available", async () => {
    const { from, insert } = buildSubmitSupabase({
      coordinators: ["COORD-0001"],
      insertedEvent: {
        id: "e2",
        status: "Requested",
        submitted_details: validPayload,
        coordinator_id: "COORD-0001",
        review_outcome: null,
        created_at: "2026-01-01",
      },
    });

    const app = buildApp({ from });
    const res = await request(app).post("/api/events").send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.event.status).toBe("Requested");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organiser_id: "user-1",
        status: "Requested",
        coordinator_id: "COORD-0001",
      }),
    );
  });

  it("flags the request Unassigned when no coordinators exist (E2-6 AC4)", async () => {
    const { from, insert } = buildSubmitSupabase({
      coordinators: [],
      insertedEvent: {
        id: "e3",
        status: "Unassigned",
        submitted_details: validPayload,
        coordinator_id: null,
        review_outcome: null,
        created_at: "2026-01-01",
      },
    });

    const app = buildApp({ from });
    const res = await request(app).post("/api/events").send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.event.status).toBe("Unassigned");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Unassigned", coordinator_id: null }),
    );
  });

  it("round-robins to the coordinator after whoever was assigned last (E2-6)", async () => {
    const { from, insert } = buildSubmitSupabase({
      coordinators: ["COORD-0001", "COORD-0002", "COORD-0003"],
      lastAssignedCoordinatorId: "COORD-0001",
      insertedEvent: { id: "e4", status: "Requested", coordinator_id: "COORD-0002" },
    });

    const app = buildApp({ from });
    await request(app).post("/api/events").send(validPayload);

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ coordinator_id: "COORD-0002" }));
  });

  it("wraps back to the first coordinator after the last one in rotation (E2-6)", async () => {
    const { from, insert } = buildSubmitSupabase({
      coordinators: ["COORD-0001", "COORD-0002"],
      lastAssignedCoordinatorId: "COORD-0002",
      insertedEvent: { id: "e5", status: "Requested", coordinator_id: "COORD-0001" },
    });

    const app = buildApp({ from });
    await request(app).post("/api/events").send(validPayload);

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ coordinator_id: "COORD-0001" }));
  });

  it("blocks submission and identifies every missing mandatory field", async () => {
    const from = vi.fn();
    const app = buildApp({ from });

    const res = await request(app).post("/api/events").send({});

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields)).toEqual(
      expect.arrayContaining([
        "name",
        "purpose",
        "description",
        "proposedDate",
        "startTime",
        "endTime",
        "expectedAttendance",
        "venue",
        "accessibility",
        "equipment",
        "technicalSupport",
      ]),
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("blocks submission when the proposed date is in the past", async () => {
    const from = vi.fn();
    const app = buildApp({ from });

    const res = await request(app)
      .post("/api/events")
      .send({ ...validPayload, proposedDate: "2000-01-01" });

    expect(res.status).toBe(400);
    expect(res.body.fields.proposedDate).toBeDefined();
  });

  it("blocks submission when expected attendance is zero or less", async () => {
    const from = vi.fn();
    const app = buildApp({ from });

    const res = await request(app)
      .post("/api/events")
      .send({ ...validPayload, expectedAttendance: 0 });

    expect(res.status).toBe(400);
    expect(res.body.fields.expectedAttendance).toBeDefined();
  });

  it("blocks submission when end time is at or before start time", async () => {
    const from = vi.fn();
    const app = buildApp({ from });

    const res = await request(app)
      .post("/api/events")
      .send({ ...validPayload, startTime: "10:00", endTime: "10:00" });

    expect(res.status).toBe(400);
    expect(res.body.fields.endTime).toBeDefined();
  });

  it.each(["venue", "accessibility", "equipment", "technicalSupport"])(
    "blocks submission when %s is left blank",
    async (field) => {
      const from = vi.fn();
      const app = buildApp({ from });

      const res = await request(app)
        .post("/api/events")
        .send({ ...validPayload, [field]: "" });

      expect(res.status).toBe(400);
      expect(res.body.fields[field]).toBeDefined();
      expect(from).not.toHaveBeenCalled();
    },
  );

  it("records requirement fields and the registration flag when provided", async () => {
    const { from, insert } = buildSubmitSupabase({
      coordinators: ["COORD-0001"],
      insertedEvent: {
        id: "e6",
        status: "Requested",
        submitted_details: {},
        coordinator_id: "COORD-0001",
        review_outcome: null,
        created_at: "2026-01-01",
      },
    });

    const app = buildApp({ from });
    const res = await request(app)
      .post("/api/events")
      .send({ ...validPayload, registrationNeeded: true });

    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        submitted_details: expect.objectContaining({
          venue: "Main Hall",
          accessibility: "Wheelchair ramp access",
          equipment: "Projector and 100 chairs",
          technicalSupport: "AV technician on-site",
          registrationNeeded: true,
        }),
      }),
    );
  });
});

describe("POST /api/events/:id/approve", () => {
  it("rejects non-coordinators", async () => {
    const { from } = buildReviewSupabase({ event: null });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).post("/api/events/1/approve");

    expect(res.status).toBe(403);
  });

  it("returns 404 when the event doesn't exist", async () => {
    const { from } = buildReviewSupabase({ event: null });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/999/approve");

    expect(res.status).toBe(404);
  });

  it("blocks and audits when the event is assigned to another coordinator", async () => {
    const { from, denialInsert } = buildReviewSupabase({
      event: { id: 1, status: "Requested", coordinator_id: "COORD-0002" },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/approve");

    expect(res.status).toBe(403);
    expect(denialInsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: coordinator.id, event_id: "1", reason: "coordinator_mismatch" }),
    );
  });

  it("blocks approval while a Rejected request", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Rejected", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/approve");

    expect(res.status).toBe(409);
  });

  it("blocks approval while clarification is outstanding", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Clarification Requested", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/approve");

    expect(res.status).toBe(409);
  });

  it("approves once every clarification question has been resolved", async () => {
    const { from, update } = buildReviewSupabase({
      event: { id: 1, status: "Clarification Requested", coordinator_id: coordinator.id },
      updatedEvent: { id: 1, status: "Planning" },
      openQuestions: [
        { id: 1, resolved: true },
        { id: 2, resolved: true },
      ],
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/approve");

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "Planning" }));
  });

  it("approves a Requested event, self-assigning an unassigned coordinator", async () => {
    const { from, update, updateEq } = buildReviewSupabase({
      event: { id: 1, status: "Requested", coordinator_id: null },
      updatedEvent: { id: 1, status: "Planning", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/approve");

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Planning");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Planning", coordinator_id: coordinator.id, decided_by: coordinator.id }),
    );
    expect(updateEq).toHaveBeenCalledWith("id", 1);
  });

  it("approves an Unassigned event, treating it like Requested (E2-6)", async () => {
    const { from, update } = buildReviewSupabase({
      event: { id: 2, status: "Unassigned", coordinator_id: null },
      updatedEvent: { id: 2, status: "Planning", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/2/approve");

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "Planning" }));
  });
});

describe("POST /api/events/:id/reject", () => {
  it("requires a reason", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Requested", coordinator_id: null },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/reject").send({});

    expect(res.status).toBe(400);
  });

  it("blocks rejection once an event has moved into Planning", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Planning", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/reject").send({ reason: "No venue available" });

    expect(res.status).toBe(409);
  });

  it("rejects a request with a reason, recording it as the review outcome", async () => {
    const { from, update } = buildReviewSupabase({
      event: { id: 1, status: "Requested", coordinator_id: coordinator.id },
      updatedEvent: { id: 1, status: "Rejected", review_outcome: "No venue available" },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/reject").send({ reason: "No venue available" });

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Rejected");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Rejected", review_outcome: "No venue available" }),
    );
  });

  it("allows rejecting a request that has an outstanding clarification (AC3)", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Clarification Requested", coordinator_id: coordinator.id },
      updatedEvent: { id: 1, status: "Rejected" },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/reject").send({ reason: "No venue found at all" });

    expect(res.status).toBe(200);
  });
});

describe("POST /api/events/:id/request-clarification", () => {
  it("requires a message", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Requested", coordinator_id: null },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/request-clarification").send({});

    expect(res.status).toBe(400);
  });

  it("only allows requesting clarification while pending review", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Clarification Requested", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app)
      .post("/api/events/1/request-clarification")
      .send({ message: "What time will setup start?" });

    expect(res.status).toBe(409);
  });

  it("sets status to Clarification Requested with the message as the review outcome", async () => {
    const { from, update, clarificationInsert } = buildReviewSupabase({
      event: { id: 1, status: "Requested", coordinator_id: null },
      updatedEvent: { id: 1, status: "Clarification Requested" },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app)
      .post("/api/events/1/request-clarification")
      .send({ message: "What time will setup start?" });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Clarification Requested",
        review_outcome: "What time will setup start?",
        coordinator_id: coordinator.id,
      }),
    );
    // AC3: this first ask seeds the thread the clarification popup renders.
    expect(clarificationInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 1,
        author_id: coordinator.id,
        author_role: "coordinator",
        message: "What time will setup start?",
      }),
    );
  });

  it("allows a post-approval follow-up question from Planning, remembering the prior status", async () => {
    const { from, update } = buildReviewSupabase({
      event: { id: 1, status: "Planning", coordinator_id: coordinator.id },
      updatedEvent: { id: 1, status: "Clarification Requested" },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app)
      .post("/api/events/1/request-clarification")
      .send({ message: "Actually, can you confirm the headcount?" });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Clarification Requested",
        status_before_clarification: "Planning",
      }),
    );
  });
});

/** Builds a mock supabase client for the clarification-thread routes: a
 * lookup on "events" (organiser_id/coordinator_id/status), plus an
 * "event_clarifications" table supporting select().eq().order() (list),
 * insert().select().single() (new question/reply), and a plain select
 * ().eq().maybeSingle() lookup (finding the parent question for a reply). */
function buildClarificationSupabase(options: {
  event: { id: number; status: string; organiser_id: string; coordinator_id: string | null } | null;
  list?: unknown[];
  listError?: { message: string } | null;
  question?: { id: number; event_id: number; parent_id: number | null; resolved?: boolean } | null;
  inserted?: Record<string, unknown>;
  insertError?: { message: string } | null;
}) {
  const { event, list = [], listError = null, question, inserted, insertError = null } = options;

  const eventMaybeSingle = vi.fn().mockResolvedValue({ data: event, error: null });
  const eventEq = vi.fn().mockReturnValue({ maybeSingle: eventMaybeSingle });
  const eventSelect = vi.fn().mockReturnValue({ eq: eventEq });

  const order = vi.fn().mockResolvedValue({ data: list, error: listError });
  const listEq = vi.fn().mockReturnValue({ order });

  const questionMaybeSingle = vi.fn().mockResolvedValue({ data: question ?? null, error: null });
  const questionEq = vi.fn().mockReturnValue({ maybeSingle: questionMaybeSingle });

  const clarificationSelect = vi.fn().mockImplementation((columns: string) => {
    if (columns === "id, event_id, parent_id, resolved") return { eq: questionEq };
    return { eq: listEq };
  });

  const insertSingle = vi.fn().mockResolvedValue({ data: inserted ?? null, error: insertError });
  const insertSelect = vi.fn().mockReturnValue({ single: insertSingle });
  const insert = vi.fn().mockReturnValue({ select: insertSelect });

  const denialInsert = vi.fn().mockResolvedValue({ error: null });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "access_denials") return { insert: denialInsert };
    if (table === "event_clarifications") return { select: clarificationSelect, insert };
    return { select: eventSelect };
  });

  return { from, insert, denialInsert };
}

describe("GET /api/events/:id/clarifications", () => {
  it("returns the thread in chronological order for the organiser who owns it", async () => {
    const thread = [
      { id: 1, parent_id: null, author_id: coordinator.id, author_role: "coordinator", message: "Q1", created_at: "2026-01-01" },
      { id: 2, parent_id: 1, author_id: "user-1", author_role: "organiser", message: "A1", created_at: "2026-01-02" },
    ];
    const { from } = buildClarificationSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: "user-1", coordinator_id: coordinator.id },
      list: thread,
    });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).get("/api/events/1/clarifications");

    expect(res.status).toBe(200);
    expect(res.body.clarifications).toEqual(thread);
  });

  it("denies a non-owning organiser", async () => {
    const { from, denialInsert } = buildClarificationSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: "someone-else", coordinator_id: null },
    });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).get("/api/events/1/clarifications");

    expect(res.status).toBe(403);
    expect(denialInsert).toHaveBeenCalled();
  });

  it("allows any coordinator to view, even one not assigned", async () => {
    const { from } = buildClarificationSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: "user-1", coordinator_id: "COORD-0002" },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).get("/api/events/1/clarifications");

    expect(res.status).toBe(200);
  });
});

describe("POST /api/events/:id/clarifications", () => {
  it("rejects non-coordinators", async () => {
    const { from } = buildReviewSupabase({ event: null });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).post("/api/events/1/clarifications").send({ message: "Any AV needs?" });

    expect(res.status).toBe(403);
  });

  it("requires clarification to already be outstanding", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Requested", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/clarifications").send({ message: "Any AV needs?" });

    expect(res.status).toBe(409);
  });

  it("requires a message", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Clarification Requested", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/clarifications").send({});

    expect(res.status).toBe(400);
  });

  it("adds a follow-up question while clarification is outstanding", async () => {
    const { from, update } = buildReviewSupabase({
      event: { id: 1, status: "Clarification Requested", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/clarifications").send({ message: "Any AV needs?" });

    expect(res.status).toBe(201);
    // Adding a follow-up question doesn't itself redecide the event.
    expect(update).not.toHaveBeenCalled();
  });
});

describe("POST /api/events/:id/clarifications/:questionId/replies", () => {
  it("allows the owning organiser to reply", async () => {
    const { from, insert } = buildClarificationSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: "user-1", coordinator_id: coordinator.id },
      question: { id: 5, event_id: 1, parent_id: null },
      inserted: { id: 9, parent_id: 5, author_id: "user-1", author_role: "organiser", message: "9am", created_at: "2026-01-03" },
    });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).post("/api/events/1/clarifications/5/replies").send({ message: "9am" });

    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: 1, parent_id: 5, author_id: "user-1", author_role: "organiser", message: "9am" }),
    );
  });

  it("denies an organiser who doesn't own the event", async () => {
    const { from } = buildClarificationSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: "someone-else", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).post("/api/events/1/clarifications/5/replies").send({ message: "9am" });

    expect(res.status).toBe(403);
  });

  it("blocks replies once the request is no longer awaiting clarification", async () => {
    const { from } = buildClarificationSupabase({
      event: { id: 1, status: "Planning", organiser_id: "user-1", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).post("/api/events/1/clarifications/5/replies").send({ message: "9am" });

    expect(res.status).toBe(409);
  });

  it("404s when the question doesn't belong to this event", async () => {
    const { from } = buildClarificationSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: "user-1", coordinator_id: coordinator.id },
      question: { id: 5, event_id: 2, parent_id: null },
    });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).post("/api/events/1/clarifications/5/replies").send({ message: "9am" });

    expect(res.status).toBe(404);
  });

  it("blocks replies once the question itself has been resolved", async () => {
    const { from } = buildClarificationSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: "user-1", coordinator_id: coordinator.id },
      question: { id: 5, event_id: 1, parent_id: null, resolved: true },
    });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).post("/api/events/1/clarifications/5/replies").send({ message: "9am" });

    expect(res.status).toBe(409);
  });
});

describe("POST /api/events/:id/clarifications/:questionId/resolve", () => {
  it("rejects non-coordinators", async () => {
    const { from } = buildReviewSupabase({ event: null });
    const app = buildApp({ from }, { id: "user-1", role: "organiser" });

    const res = await request(app).post("/api/events/1/clarifications/5/resolve");

    expect(res.status).toBe(403);
  });

  it("requires clarification to be outstanding", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Requested", coordinator_id: coordinator.id },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/clarifications/5/resolve");

    expect(res.status).toBe(409);
  });

  it("404s when the question doesn't belong to this event", async () => {
    const { from } = buildReviewSupabase({
      event: { id: 1, status: "Clarification Requested", coordinator_id: coordinator.id },
      question: { id: 5, event_id: 2, parent_id: null },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/clarifications/5/resolve");

    expect(res.status).toBe(404);
  });

  it("marks the question resolved", async () => {
    const { from, clarificationUpdate } = buildReviewSupabase({
      event: { id: 1, status: "Clarification Requested", coordinator_id: coordinator.id },
      question: { id: 5, event_id: 1, parent_id: null },
      resolvedQuestion: { id: 5, parent_id: null, resolved: true },
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).post("/api/events/1/clarifications/5/resolve");

    expect(res.status).toBe(200);
    expect(res.body.clarification.resolved).toBe(true);
    expect(clarificationUpdate).toHaveBeenCalledWith({ resolved: true });
  });
});

/**
 * E2-10: mocks the lookup on "events" (status/organiser_id/submitted_details),
 * the update().select().single() that saves the response, the "find the open
 * question to reply to" lookup, and the event_clarifications insert.
 */
function buildPatchSupabase(options: {
  event:
    | {
        id: number;
        status: string;
        organiser_id: string;
        submitted_details: Record<string, unknown>;
        status_before_clarification?: string | null;
      }
    | null;
  updatedEvent?: Record<string, unknown>;
  openQuestion?: { id: number } | null;
}) {
  const { event, updatedEvent, openQuestion = null } = options;

  const lookupMaybeSingle = vi.fn().mockResolvedValue({ data: event, error: null });
  const lookupEq = vi.fn().mockReturnValue({ maybeSingle: lookupMaybeSingle });
  const lookupSelect = vi.fn().mockReturnValue({ eq: lookupEq });

  const updateSingle = vi.fn().mockResolvedValue({ data: updatedEvent ?? null, error: null });
  const updateSelect = vi.fn().mockReturnValue({ single: updateSingle });
  const updateEq = vi.fn().mockReturnValue({ select: updateSelect });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  const openQuestionMaybeSingle = vi.fn().mockResolvedValue({ data: openQuestion, error: null });
  const openQuestionLimit = vi.fn().mockReturnValue({ maybeSingle: openQuestionMaybeSingle });
  const openQuestionOrder = vi.fn().mockReturnValue({ limit: openQuestionLimit });
  const openQuestionEqResolved = vi.fn().mockReturnValue({ order: openQuestionOrder });
  const openQuestionIs = vi.fn().mockReturnValue({ eq: openQuestionEqResolved });
  const openQuestionEqEventId = vi.fn().mockReturnValue({ is: openQuestionIs });
  const openQuestionSelect = vi.fn().mockReturnValue({ eq: openQuestionEqEventId });

  const clarificationInsert = vi.fn().mockResolvedValue({ error: null });
  const denialInsert = vi.fn().mockResolvedValue({ error: null });
  const historyInsert = vi.fn().mockResolvedValue({ error: null });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "event_clarifications") return { select: openQuestionSelect, insert: clarificationInsert };
    if (table === "access_denials") return { insert: denialInsert };
    if (table === "event_history") return { insert: historyInsert };
    return { select: lookupSelect, update };
  });

  return { from, update, clarificationInsert, historyInsert };
}

describe("POST /api/events/draft", () => {
  it("saves an incomplete draft without validating mandatory fields (E2-4 AC1)", async () => {
    const insertSingle = vi.fn().mockResolvedValue({
      data: { id: "d1", status: "Draft", submitted_details: { name: "Half-planned mixer" } },
      error: null,
    });
    const insertSelect = vi.fn().mockReturnValue({ single: insertSingle });
    const insert = vi.fn().mockReturnValue({ select: insertSelect });
    const from = vi.fn().mockReturnValue({ insert });

    const app = buildApp({ from });
    const res = await request(app).post("/api/events/draft").send({ name: "Half-planned mixer" });

    expect(res.status).toBe(201);
    expect(res.body.event.status).toBe("Draft");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        organiser_id: "user-1",
        status: "Draft",
        submitted_details: expect.objectContaining({ name: "Half-planned mixer", venue: "" }),
      }),
    );
    // A draft hasn't reached the review pipeline yet — no coordinator lookup.
    expect(from).not.toHaveBeenCalledWith("users");
  });

  it("saves a completely empty draft", async () => {
    const insertSingle = vi.fn().mockResolvedValue({ data: { id: "d2", status: "Draft" }, error: null });
    const insertSelect = vi.fn().mockReturnValue({ single: insertSingle });
    const insert = vi.fn().mockReturnValue({ select: insertSelect });
    const from = vi.fn().mockReturnValue({ insert });

    const app = buildApp({ from });
    const res = await request(app).post("/api/events/draft").send({});

    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Draft",
        submitted_details: expect.objectContaining({ name: "", expectedAttendance: null }),
      }),
    );
  });
});

/** Builds a mock supabase client for PATCH /api/events/:id/draft: a lookup
 * on "events" (id/status/organiser_id) plus the update().eq().select().single(). */
function buildDraftPatchSupabase(options: {
  event: { id: number; status: string; organiser_id: string } | null;
  updatedEvent?: Record<string, unknown>;
}) {
  const { event, updatedEvent } = options;

  const lookupMaybeSingle = vi.fn().mockResolvedValue({ data: event, error: null });
  const lookupEq = vi.fn().mockReturnValue({ maybeSingle: lookupMaybeSingle });
  const lookupSelect = vi.fn().mockReturnValue({ eq: lookupEq });

  const updateSingle = vi.fn().mockResolvedValue({ data: updatedEvent ?? null, error: null });
  const updateSelect = vi.fn().mockReturnValue({ single: updateSingle });
  const updateEq = vi.fn().mockReturnValue({ select: updateSelect });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  const denialInsert = vi.fn().mockResolvedValue({ error: null });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "access_denials") return { insert: denialInsert };
    return { select: lookupSelect, update };
  });

  return { from, update, denialInsert };
}

describe("PATCH /api/events/:id/draft", () => {
  const owner = { id: "ORG-0001", role: "organiser" };

  it("saves progress on an owned draft without validating it (E2-4 AC1/AC2)", async () => {
    const { from, update } = buildDraftPatchSupabase({
      event: { id: 1, status: "Draft", organiser_id: owner.id },
      updatedEvent: { id: 1, status: "Draft" },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1/draft").send({ name: "Still deciding" });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      submitted_details: expect.objectContaining({ name: "Still deciding", venue: "" }),
    });
  });

  it("denies a non-owner", async () => {
    const { from, denialInsert } = buildDraftPatchSupabase({
      event: { id: 1, status: "Draft", organiser_id: "someone-else" },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1/draft").send({ name: "Snooping" });

    expect(res.status).toBe(403);
    expect(denialInsert).toHaveBeenCalled();
  });

  it("refuses to touch a request that's already been submitted", async () => {
    const { from } = buildDraftPatchSupabase({
      event: { id: 1, status: "Requested", organiser_id: owner.id },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1/draft").send({ name: "Too late" });

    expect(res.status).toBe(409);
  });
});

/** Builds a mock supabase client for DELETE /api/events/:id/draft: a lookup
 * on "events" (id/status/organiser_id) plus delete().eq(). */
function buildDraftDeleteSupabase(options: {
  event: { id: number; status: string; organiser_id: string } | null;
  deleteError?: { message: string } | null;
}) {
  const { event, deleteError = null } = options;

  const lookupMaybeSingle = vi.fn().mockResolvedValue({ data: event, error: null });
  const lookupEq = vi.fn().mockReturnValue({ maybeSingle: lookupMaybeSingle });
  const lookupSelect = vi.fn().mockReturnValue({ eq: lookupEq });

  const deleteEq = vi.fn().mockResolvedValue({ error: deleteError });
  const del = vi.fn().mockReturnValue({ eq: deleteEq });

  const denialInsert = vi.fn().mockResolvedValue({ error: null });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "access_denials") return { insert: denialInsert };
    return { select: lookupSelect, delete: del };
  });

  return { from, delete: del, deleteEq, denialInsert };
}

describe("DELETE /api/events/:id/draft", () => {
  const owner = { id: "ORG-0001", role: "organiser" };

  it("deletes an owned draft (E2-5.2 AC1)", async () => {
    const { from, delete: del, deleteEq } = buildDraftDeleteSupabase({
      event: { id: 1, status: "Draft", organiser_id: owner.id },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).delete("/api/events/1/draft");

    expect(res.status).toBe(204);
    expect(del).toHaveBeenCalled();
    expect(deleteEq).toHaveBeenCalledWith("id", 1);
  });

  it("denies a non-owner", async () => {
    const { from, denialInsert } = buildDraftDeleteSupabase({
      event: { id: 1, status: "Draft", organiser_id: "someone-else" },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).delete("/api/events/1/draft");

    expect(res.status).toBe(403);
    expect(denialInsert).toHaveBeenCalled();
  });

  it("refuses to delete a request that's already been submitted", async () => {
    const { from } = buildDraftDeleteSupabase({
      event: { id: 1, status: "Requested", organiser_id: owner.id },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).delete("/api/events/1/draft");

    expect(res.status).toBe(409);
  });

  it("denies access to a non-existent draft", async () => {
    const { from } = buildDraftDeleteSupabase({ event: null });
    const app = buildApp({ from }, owner);

    const res = await request(app).delete("/api/events/999/draft");

    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/events/:id (submitting a draft)", () => {
  const owner = { id: "ORG-0001", role: "organiser" };

  /** Extends buildPatchSupabase's "events" mock with the two lookups
   * assignCoordinator makes, so a Draft's submit-and-assign path can be
   * exercised the same way POST /'s buildSubmitSupabase does. */
  function buildDraftSubmitSupabase(options: {
    event: { id: number; status: string; organiser_id: string; submitted_details: Record<string, unknown> };
    coordinators?: string[];
    updatedEvent?: Record<string, unknown>;
  }) {
    const { event, coordinators = [], updatedEvent } = options;

    const lookupMaybeSingle = vi.fn().mockResolvedValue({ data: event, error: null });
    const lookupEq = vi.fn().mockReturnValue({ maybeSingle: lookupMaybeSingle });

    const lastAssignedMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const lastAssignedLimit = vi.fn().mockReturnValue({ maybeSingle: lastAssignedMaybeSingle });
    const lastAssignedOrder = vi.fn().mockReturnValue({ limit: lastAssignedLimit });
    const lastAssignedNot = vi.fn().mockReturnValue({ order: lastAssignedOrder });

    const eventsSelect = vi.fn().mockImplementation((columns: string) => {
      if (columns.startsWith("coordinator_id")) return { not: lastAssignedNot };
      return { eq: lookupEq };
    });

    const usersOrder = vi.fn().mockResolvedValue({ data: coordinators.map((id) => ({ id })), error: null });
    const usersEq = vi.fn().mockReturnValue({ order: usersOrder });
    const usersSelect = vi.fn().mockReturnValue({ eq: usersEq });

    const updateSingle = vi.fn().mockResolvedValue({ data: updatedEvent ?? null, error: null });
    const updateSelect = vi.fn().mockReturnValue({ single: updateSingle });
    const updateEq = vi.fn().mockReturnValue({ select: updateSelect });
    const update = vi.fn().mockReturnValue({ eq: updateEq });

    const historyInsert = vi.fn().mockResolvedValue({ error: null });

    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "users") return { select: usersSelect };
      if (table === "event_history") return { insert: historyInsert };
      return { select: eventsSelect, update };
    });

    return { from, update };
  }

  it("still enforces E2-1 validation when submitting a draft (AC3)", async () => {
    const { from } = buildDraftSubmitSupabase({
      event: { id: 1, status: "Draft", organiser_id: owner.id, submitted_details: {} },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send({});

    expect(res.status).toBe(400);
  });

  it("assigns a coordinator and moves a valid draft to Requested (AC3)", async () => {
    const { from, update } = buildDraftSubmitSupabase({
      event: { id: 1, status: "Draft", organiser_id: owner.id, submitted_details: {} },
      coordinators: ["COORD-0001"],
      updatedEvent: { id: 1, status: "Requested", coordinator_id: "COORD-0001" },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Requested");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Requested", coordinator_id: "COORD-0001" }),
    );
  });

  it("flags it Unassigned instead when no coordinators exist", async () => {
    const { from, update } = buildDraftSubmitSupabase({
      event: { id: 1, status: "Draft", organiser_id: owner.id, submitted_details: {} },
      coordinators: [],
      updatedEvent: { id: 1, status: "Unassigned", coordinator_id: null },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Unassigned", coordinator_id: null }),
    );
  });
});

describe("PATCH /api/events/:id", () => {
  const owner = { id: "ORG-0001", role: "organiser" };

  it("requires the caller to be the owning organiser", async () => {
    const { from } = buildPatchSupabase({
      event: {
        id: 1,
        status: "Clarification Requested",
        organiser_id: "ORG-0002",
        submitted_details: {},
      },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(403);
  });

  it("blocks direct edits once the request has been rejected (AC2)", async () => {
    const { from } = buildPatchSupabase({
      event: { id: 1, status: "Rejected", organiser_id: owner.id, submitted_details: {} },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(409);
  });

  it("allows a direct edit while still in Planning (AGENTS.md: only Confirmed locks it down)", async () => {
    const oldDetails = { ...validPayload, venue: "Old Hall" };
    const { from, update, historyInsert } = buildPatchSupabase({
      event: { id: 1, status: "Planning", organiser_id: owner.id, submitted_details: oldDetails },
      updatedEvent: { id: 1, status: "Planning" },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      submitted_details: expect.objectContaining({ venue: validPayload.venue }),
    });
    expect(historyInsert).toHaveBeenCalled();
  });

  it("validates the payload like a fresh submission", async () => {
    const { from } = buildPatchSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: owner.id, submitted_details: {} },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send({});

    expect(res.status).toBe(400);
  });

  it("saves the response, clears the flag, and posts the diff as a reply to the open question", async () => {
    const oldDetails = { ...validPayload, venue: "Old Hall" };
    const { from, update, clarificationInsert } = buildPatchSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: owner.id, submitted_details: oldDetails },
      updatedEvent: { id: 1, status: "Requested" },
      openQuestion: { id: 9 },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Requested");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Requested", submitted_details: expect.objectContaining({ venue: "Main Hall" }) }),
    );
    expect(clarificationInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 1,
        parent_id: 9,
        author_id: owner.id,
        author_role: "organiser",
        message: expect.stringContaining("Venue changed from 'Old Hall' to 'Main Hall'"),
      }),
    );
  });

  it("skips posting a reply when nothing actually changed", async () => {
    const { from, clarificationInsert } = buildPatchSupabase({
      event: {
        id: 1,
        status: "Clarification Requested",
        organiser_id: owner.id,
        submitted_details: { ...validPayload, registrationNeeded: false },
      },
      updatedEvent: { id: 1, status: "Requested" },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
    expect(clarificationInsert).not.toHaveBeenCalled();
  });

  it("posts a new top-level entry when there's no open question to reply to", async () => {
    const oldDetails = { ...validPayload, venue: "Old Hall" };
    const { from, clarificationInsert } = buildPatchSupabase({
      event: { id: 1, status: "Clarification Requested", organiser_id: owner.id, submitted_details: oldDetails },
      updatedEvent: { id: 1, status: "Requested" },
      openQuestion: null,
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
    expect(clarificationInsert).toHaveBeenCalledWith(expect.objectContaining({ parent_id: null }));
  });

  it("restores status to Planning when the clarification was a post-approval follow-up", async () => {
    const { from, update } = buildPatchSupabase({
      event: {
        id: 1,
        status: "Clarification Requested",
        organiser_id: owner.id,
        submitted_details: validPayload,
        status_before_clarification: "Planning",
      },
      updatedEvent: { id: 1, status: "Planning" },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Planning");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Planning", status_before_clarification: null }),
    );
  });

  it("saves a direct edit from Requested immediately, with no status change or clarification post (E2-7 AC1)", async () => {
    const oldDetails = { ...validPayload, venue: "Old Hall" };
    const { from, update, clarificationInsert, historyInsert } = buildPatchSupabase({
      event: { id: 1, status: "Requested", organiser_id: owner.id, submitted_details: oldDetails },
      updatedEvent: { id: 1, status: "Requested", submitted_details: validPayload },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ submitted_details: expect.objectContaining({ venue: "Main Hall" }) });
    expect(clarificationInsert).not.toHaveBeenCalled();
    expect(historyInsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          event_id: 1,
          field: "Venue",
          old_value: "Old Hall",
          new_value: "Main Hall",
          changed_by: owner.id,
        }),
      ]),
    );
  });

  it("allows a direct edit from Unassigned too (E2-7 AC1)", async () => {
    const { from } = buildPatchSupabase({
      event: { id: 1, status: "Unassigned", organiser_id: owner.id, submitted_details: validPayload },
      updatedEvent: { id: 1, status: "Unassigned" },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
  });

  it("doesn't write history when a direct edit changes nothing", async () => {
    const { from, historyInsert } = buildPatchSupabase({
      event: {
        id: 1,
        status: "Requested",
        organiser_id: owner.id,
        submitted_details: { ...validPayload, registrationNeeded: false },
      },
      updatedEvent: { id: 1, status: "Requested" },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).patch("/api/events/1").send(validPayload);

    expect(res.status).toBe(200);
    expect(historyInsert).not.toHaveBeenCalled();
  });
});

describe("GET /api/events/:id/history", () => {
  const owner = { id: "ORG-0001", role: "organiser" };

  function buildHistorySupabase(options: {
    event: { id: number; status: string; organiser_id: string; coordinator_id: string | null } | null;
    history?: unknown[];
  }) {
    const { event, history = [] } = options;

    const eventMaybeSingle = vi.fn().mockResolvedValue({ data: event, error: null });
    const eventEq = vi.fn().mockReturnValue({ maybeSingle: eventMaybeSingle });
    const eventSelect = vi.fn().mockReturnValue({ eq: eventEq });

    const historyOrder = vi.fn().mockResolvedValue({ data: history, error: null });
    const historyEq = vi.fn().mockReturnValue({ order: historyOrder });
    const historySelect = vi.fn().mockReturnValue({ eq: historyEq });

    const denialInsert = vi.fn().mockResolvedValue({ error: null });

    const from = vi.fn().mockImplementation((table: string) => {
      if (table === "event_history") return { select: historySelect };
      if (table === "access_denials") return { insert: denialInsert };
      return { select: eventSelect };
    });

    return { from };
  }

  it("returns the history for the owning organiser", async () => {
    const { from } = buildHistorySupabase({
      event: { id: 1, status: "Requested", organiser_id: owner.id, coordinator_id: null },
      history: [{ id: 1, field: "Venue", old_value: "Old Hall", new_value: "Main Hall" }],
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).get("/api/events/1/history");

    expect(res.status).toBe(200);
    expect(res.body.history).toHaveLength(1);
  });

  it("denies access to a non-owner, non-coordinator", async () => {
    const { from } = buildHistorySupabase({
      event: { id: 1, status: "Requested", organiser_id: "ORG-0002", coordinator_id: null },
    });
    const app = buildApp({ from }, owner);

    const res = await request(app).get("/api/events/1/history");

    expect(res.status).toBe(403);
  });

  it("is visible to any coordinator", async () => {
    const { from } = buildHistorySupabase({
      event: { id: 1, status: "Requested", organiser_id: owner.id, coordinator_id: null },
      history: [],
    });
    const app = buildApp({ from }, coordinator);

    const res = await request(app).get("/api/events/1/history");

    expect(res.status).toBe(200);
  });
});
