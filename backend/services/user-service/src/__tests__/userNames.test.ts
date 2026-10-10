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

/** .from("users").select("id, name").in("id", ids) */
function buildApp(user: { id: string; role: string }, result = { data: [] as unknown[], error: null as unknown }) {
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
    const { app, select, inFilter } = buildApp(
      { id: "ORG-0001", role: "organiser" },
      { data: [{ id: "ATT-0001", name: "Attendee One" }], error: null },
    );

    const res = await request(app).get("/api/users/names?ids=ATT-0001,ATT-0001,ATT-0002");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ users: [{ id: "ATT-0001", name: "Attendee One" }] });
    expect(select).toHaveBeenCalledWith("id, name");
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
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a missing ids list", async () => {
    const { app } = buildApp({ id: "ORG-0001", role: "organiser" });

    expect((await request(app).get("/api/users/names")).status).toBe(400);
  });
});
