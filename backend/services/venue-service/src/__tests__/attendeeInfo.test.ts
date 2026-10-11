import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { attendeeInfoRouter } from "../routes/attendeeInfo.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "ATT-0001", role: "attendee" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const attendee = { id: "ATT-0001", role: "attendee" };

/** .from("venue_bookings").select(...).in("event_id", ids).eq("status", "Approved") */
function buildApp(rows: Record<string, unknown>[], user = attendee) {
  const eq = vi.fn().mockResolvedValue({ data: rows, error: null });
  const inFilter = vi.fn().mockReturnValue({ eq });
  const select = vi.fn().mockReturnValue({ in: inFilter });
  const from = vi.fn().mockReturnValue({ select });
  (globalThis as any).__mockSupabase = { from };
  (globalThis as any).__mockUser = user;

  const app = express();
  app.use("/api/venues/attendee-info", attendeeInfoRouter);
  return { app, from, select, inFilter, eq };
}

describe("GET /api/venues/attendee-info (E6)", () => {
  it("returns only venue names for Approved bookings", async () => {
    const { app, select, inFilter, eq } = buildApp([
      { event_id: 1, venues: { name: "Great Lawn" } },
      { event_id: 2, venues: [{ name: "Grand Ballroom" }] },
    ]);

    const res = await request(app).get("/api/venues/attendee-info?eventIds=1,2");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      venues: [
        { eventId: 1, venueName: "Great Lawn" },
        { eventId: 2, venueName: "Grand Ballroom" },
      ],
    });
    expect(select).toHaveBeenCalledWith("event_id, venues (name)");
    expect(inFilter).toHaveBeenCalledWith("event_id", [1, 2]);
    expect(eq).toHaveBeenCalledWith("status", "Approved");
  });

  it("skips a booking whose venue is missing", async () => {
    const { app } = buildApp([{ event_id: 1, venues: null }]);

    const res = await request(app).get("/api/venues/attendee-info?eventIds=1");

    expect(res.body).toEqual({ venues: [] });
  });

  it("refuses every other role without querying", async () => {
    const { app, from } = buildApp([], { id: "COORD-0001", role: "coordinator" });

    const res = await request(app).get("/api/venues/attendee-info?eventIds=1");

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects missing or malformed event ids", async () => {
    const { app } = buildApp([]);

    expect((await request(app).get("/api/venues/attendee-info")).status).toBe(400);
    expect((await request(app).get("/api/venues/attendee-info?eventIds=abc")).status).toBe(400);
  });
});
