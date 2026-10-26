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
  return { app, from, select, eq, order };
}

const lead = { id: "LEAD-0001", role: "coordinator_lead" };

describe("usersRouter route table", () => {
  it("registers the role-listing GET route at the router's own root path", () => {
    // Express treats router.get("") and router.get("/") identically for any
    // request that reaches this router — there is no request that could
    // ever tell them apart, which makes that mutant a true equivalent for
    // every supertest-based assertion above. Reading the registered path
    // string directly off the router's internal route table is the only
    // way to actually pin it down.
    const rootGetLayer = (usersRouter as any).stack.find(
      (layer: any) => layer.route?.methods?.get && layer.route.path === "/",
    );
    expect(rootGetLayer).toBeDefined();
  });
});

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
    const { app, from, select, eq } = buildApp(lead, { data: coordinators, error: null });

    const res = await request(app).get("/api/users?role=coordinator");

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual(coordinators);
    expect(from).toHaveBeenCalledWith("users");
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
    expect(res.body).toEqual({ error: "Access denied" });
    expect(from).not.toHaveBeenCalled();
  });

  it("does not let the Lead list any other role", async () => {
    const { app, from } = buildApp(lead);

    const res = await request(app).get("/api/users?role=organiser");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
    expect(from).not.toHaveBeenCalled();
  });

  it("requires a role", async () => {
    const { app } = buildApp(lead);

    const res = await request(app).get("/api/users");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "role is required" });
  });

  it("rejects role sent as a repeated query param (parsed as an array, not a string), without touching the database", async () => {
    // Express parses ?role=a&role=b as an array. The typeof guard must
    // treat anything but a plain string as "no role given".
    const { app, from } = buildApp(lead);

    const res = await request(app).get("/api/users?role=coordinator&role=organiser");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "role is required" });
    expect(from).not.toHaveBeenCalled();
  });

  it("reports a failed lookup as a server error", async () => {
    const { app, select, eq } = buildApp(lead, { data: null, error: { message: "connection refused" } });

    const res = await request(app).get("/api/users?role=coordinator");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load users" });
    expect(select).toHaveBeenCalledWith("id, name");
    expect(eq).toHaveBeenCalledWith("role", "coordinator");
  });

  it("returns an empty list, not null, when the query succeeds with no data", async () => {
    const { app } = buildApp(lead, { data: null, error: null });

    const res = await request(app).get("/api/users?role=coordinator");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ users: [] });
  });

  it("orders results by name ascending", async () => {
    const { app, order } = buildApp(lead, { data: [], error: null });

    await request(app).get("/api/users?role=coordinator");

    expect(order).toHaveBeenCalledWith("name", { ascending: true });
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
