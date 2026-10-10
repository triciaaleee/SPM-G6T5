import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { usersRouter } from "../routes/users.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser;
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
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

    expect(res.status).toBe(403);
  });
});
