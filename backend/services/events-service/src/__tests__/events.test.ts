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
}) {
  const { event, updatedEvent, updateError = null } = options;

  const maybeSingle = vi.fn().mockResolvedValue({ data: event, error: null });
  const lookupEq = vi.fn().mockReturnValue({ maybeSingle });
  const lookupSelect = vi.fn().mockReturnValue({ eq: lookupEq });

  const single = vi.fn().mockResolvedValue({ data: updatedEvent ?? null, error: updateError });
  const updateSelect = vi.fn().mockReturnValue({ single });
  const updateEq = vi.fn().mockReturnValue({ select: updateSelect });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  const denialInsert = vi.fn().mockResolvedValue({ error: null });

  const from = vi.fn().mockImplementation((table: string) => {
    if (table === "access_denials") return { insert: denialInsert };
    return { select: lookupSelect, update };
  });

  return { from, update, updateEq, updateSelect, denialInsert };
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

describe("POST /api/events", () => {
  it("creates the request with status Requested when all fields are valid", async () => {
    const single = vi.fn().mockResolvedValue({
      data: {
        id: "e2",
        status: "Requested",
        submitted_details: validPayload,
        coordinator_id: null,
        review_outcome: null,
        created_at: "2026-01-01",
      },
      error: null,
    });
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert });

    const app = buildApp({ from });
    const res = await request(app).post("/api/events").send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.event.status).toBe("Requested");
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ organiser_id: "user-1", status: "Requested" }),
    );
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
    const { from, update } = buildReviewSupabase({
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
  });
});
