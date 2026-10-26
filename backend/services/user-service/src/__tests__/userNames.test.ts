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

/** .from("users").select("id, name").in("id", ids) */
function buildApp(
  user: { id: string; role: string },
  result: { data: unknown[] | null; error: unknown } = { data: [], error: null },
) {
  const inFilter = vi.fn().mockResolvedValue(result);
  const select = vi.fn().mockReturnValue({ in: inFilter });
  const from = vi.fn().mockReturnValue({ select });
  (globalThis as any).__mockSupabase = { from };
  (globalThis as any).__mockUser = user;

  const app = express();
  app.use("/api/users", usersRouter);
  return { app, from, select, inFilter };
}

describe("GET /api/users/names (E6)", () => {
  it("returns only id and name for an organiser", async () => {
    const { app, from, select, inFilter } = buildApp(
      { id: "ORG-0001", role: "organiser" },
      { data: [{ id: "ATT-0001", name: "Attendee One" }], error: null },
    );

    const res = await request(app).get("/api/users/names?ids=ATT-0001,ATT-0001,ATT-0002");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ users: [{ id: "ATT-0001", name: "Attendee One" }] });
    expect(from).toHaveBeenCalledWith("users");
    expect(select).toHaveBeenCalledWith("id, name");
    expect(inFilter).toHaveBeenCalledWith("id", ["ATT-0001", "ATT-0002"]);
  });

  it("trims whitespace around each id before deduplicating and querying", async () => {
    const { app, inFilter } = buildApp({ id: "ORG-0001", role: "organiser" });

    await request(app).get("/api/users/names?ids=" + encodeURIComponent(" ATT-0001 , ATT-0002"));

    expect(inFilter).toHaveBeenCalledWith("id", ["ATT-0001", "ATT-0002"]);
  });

  it("allows a coordinator", async () => {
    const { app } = buildApp({ id: "COORD-0001", role: "coordinator" });

    expect((await request(app).get("/api/users/names?ids=ATT-0001")).status).toBe(200);
  });

  it("refuses attendees so they can't look each other up", async () => {
    const { app, from } = buildApp({ id: "ATT-0001", role: "attendee" });

    const res = await request(app).get("/api/users/names?ids=ATT-0002");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
    expect(from).not.toHaveBeenCalled();
  });

  it("refuses a caller with no verified user at all, the same as any other disallowed role", async () => {
    const { app, from } = buildApp(undefined as any);

    const res = await request(app).get("/api/users/names?ids=ATT-0002");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a missing ids list", async () => {
    const { app } = buildApp({ id: "ORG-0001", role: "organiser" });

    const res = await request(app).get("/api/users/names");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "ids must be 1–200 comma-separated user ids" });
  });

  it("accepts exactly 200 ids", async () => {
    const { app } = buildApp({ id: "ORG-0001", role: "organiser" });
    const ids = Array.from({ length: 200 }, (_, i) => `ATT-${i}`).join(",");

    const res = await request(app).get(`/api/users/names?ids=${ids}`);

    expect(res.status).toBe(200);
  });

  it("rejects 201 ids", async () => {
    const { app, from } = buildApp({ id: "ORG-0001", role: "organiser" });
    const ids = Array.from({ length: 201 }, (_, i) => `ATT-${i}`).join(",");

    const res = await request(app).get(`/api/users/names?ids=${ids}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "ids must be 1–200 comma-separated user ids" });
    expect(from).not.toHaveBeenCalled();
  });

  it("returns an empty list, not null, when the query succeeds with no data", async () => {
    const { app } = buildApp({ id: "ORG-0001", role: "organiser" }, { data: null, error: null });

    const res = await request(app).get("/api/users/names?ids=ATT-0001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ users: [] });
  });

  it("reports a failed lookup as a server error", async () => {
    const { app } = buildApp(
      { id: "ORG-0001", role: "organiser" },
      { data: null, error: { message: "connection refused" } },
    );

    const res = await request(app).get("/api/users/names?ids=ATT-0001");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load users" });
  });
});
