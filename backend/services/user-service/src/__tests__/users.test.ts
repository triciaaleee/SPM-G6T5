import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { usersRouter } from "../routes/users.js";

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return {
    requireAuth: applyMock,
    requireAuthOrInternal: applyMock,
  };
});

function buildApp(user: { id: string; role: string }, result: { data: unknown; error: unknown } = { data: [], error: null }) {
  const order = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  (globalThis as any).__mockSupabase = { from };
  (globalThis as any).__mockUser = user;

  const app = express();
  app.use(express.json());
  app.use("/api/users", usersRouter);
  return { app, from, select, eq };
}

const lead = { id: "LEAD-0001", role: "coordinator_lead" };

describe("GET /api/users/me", () => {
  it("returns the caller's own identity from their verified token", async () => {
    const { app } = buildApp({ id: "ORG-0001", role: "organiser" });

    const res = await request(app).get("/api/users/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { id: "ORG-0001", role: "organiser" } });
  });

  it("reflects whatever role the token carries, not just organiser", async () => {
    const { app } = buildApp({ id: "COORD-0002", role: "coordinator" });

    const res = await request(app).get("/api/users/me");

    expect(res.body.user).toEqual({ id: "COORD-0002", role: "coordinator" });
  });
});

describe("GET /api/users?role=coordinator (E2-13 / E2-12)", () => {
  it("lists coordinators' ids and names for the Event Coordinator Lead", async () => {
    const coordinators = [
      { id: "COORD-0001", name: "Coordinator One" },
      { id: "COORD-0002", name: "Coordinator Two" },
    ];
    const { app, select, eq } = buildApp(lead, { data: coordinators, error: null });

    const res = await request(app).get("/api/users?role=coordinator");

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual(coordinators);
    expect(select).toHaveBeenCalledWith("id, name");
    expect(eq).toHaveBeenCalledWith("role", "coordinator");
  });

  it("returns an empty list when no coordinators exist", async () => {
    const { app } = buildApp(lead, { data: [], error: null });

    const res = await request(app).get("/api/users?role=coordinator");

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  it.each(["coordinator", "organiser", "attendee", "venue_staff"])("denies a %s", async (role) => {
    const { app, from } = buildApp({ id: "X-0001", role });

    const res = await request(app).get("/api/users?role=coordinator");

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it("does not let the Lead list any other role", async () => {
    const { app, from } = buildApp(lead);

    const res = await request(app).get("/api/users?role=organiser");

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it("requires a role", async () => {
    const { app } = buildApp(lead);

    const res = await request(app).get("/api/users");

    expect(res.status).toBe(400);
  });

  it("reports a failed lookup as a server error", async () => {
    const { app } = buildApp(lead, { data: null, error: { message: "connection refused" } });

    const res = await request(app).get("/api/users?role=coordinator");

    expect(res.status).toBe(500);
  });
});

describe("GET /api/users?role= via internal service-to-service auth", () => {
  it("bypasses LISTABLE_ROLES_BY_CALLER for a trusted internal caller", async () => {
    const leads = [{ id: "LEAD-0001", name: "Lead One" }];
    // No req.user set (as requireAuthOrInternal leaves it for an internal caller).
    const { app, select, eq } = buildApp(undefined as any, { data: leads, error: null });

    const res = await request(app).get("/api/users?role=coordinator_lead");

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual(leads);
    expect(select).toHaveBeenCalledWith("id, name");
    expect(eq).toHaveBeenCalledWith("role", "coordinator_lead");
  });
});

describe("GET /api/users?role=coordinator_lead (E2-14)", () => {
  it("lets an organiser list Coordinator Leads, to notify them on submission", async () => {
    const leads = [{ id: "LEAD-0001", name: "Lead One" }];
    const { app, select, eq } = buildApp({ id: "ORG-0001", role: "organiser" }, { data: leads, error: null });

    const res = await request(app).get("/api/users?role=coordinator_lead");

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual(leads);
    expect(select).toHaveBeenCalledWith("id, name");
    expect(eq).toHaveBeenCalledWith("role", "coordinator_lead");
  });

  it.each(["coordinator", "attendee", "venue_staff", "coordinator_lead"])(
    "denies a %s",
    async (role) => {
      const { app, from } = buildApp({ id: "X-0001", role });

      const res = await request(app).get("/api/users?role=coordinator_lead");

      expect(res.status).toBe(403);
      expect(from).not.toHaveBeenCalled();
    },
  );
});
