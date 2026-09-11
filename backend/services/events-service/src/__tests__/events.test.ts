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

const validPayload = {
  name: "Freshman Orientation",
  purpose: "Welcome new students",
  description: "Campus tour and icebreakers",
  proposedDate: "2099-01-01",
  startTime: "09:00",
  endTime: "11:00",
  expectedAttendance: 50,
};

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
  const otherUsersEventId = "bbbbbbbb-0000-0000-0000-000000000001";

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

  it("denies access and logs when the id is not a valid UUID, without querying the DB", async () => {
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
    const ownedEventId = "aaaaaaaa-0000-0000-0000-000000000001";
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: ownedEventId,
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
    expect(res.body.event.id).toBe(ownedEventId);
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
