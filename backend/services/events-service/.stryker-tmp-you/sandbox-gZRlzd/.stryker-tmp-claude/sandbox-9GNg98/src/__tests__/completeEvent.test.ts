// @ts-nocheck
// 
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { setClockForTest } from "../lib/clock.js";

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

const coordinator = { id: "COORD-0001", role: "coordinator" };

// Event 7 runs 10:00–18:00 Singapore time on 10 Nov 2026, i.e. it ends at 10:00 UTC.
const DETAILS = { name: "Spring Gala", proposedDate: "2026-11-10", startTime: "10:00", endTime: "18:00" };
const AFTER_END = new Date("2026-11-10T10:30:00.000Z");
const BEFORE_END = new Date("2026-11-10T09:30:00.000Z");

beforeEach(() => {
  setClockForTest(AFTER_END);
});

function buildApp(
  options: {
    user?: { id: string; role: string };
    event?: { id: number; status: string; coordinator_id: string | null } | null;
    details?: Record<string, unknown>;
    /** What the conditional update matches: the completed row, or null when it lost a race. */
    updated?: Record<string, unknown> | null;
    updateError?: { message: string } | null;
  } = {},
) {
  const event = options.event === undefined ? { id: 7, status: "Confirmed", coordinator_id: coordinator.id } : options.event;
  const updated =
    options.updated === undefined ? { ...event, status: "Completed", submitted_details: DETAILS } : options.updated;

  const update = vi.fn();
  const updateFilters: [string, unknown][] = [];
  const updateChain = {
    eq: vi.fn((column: string, value: unknown) => {
      updateFilters.push([column, value]);
      return updateChain;
    }),
    select: vi.fn(() => ({
      maybeSingle: vi.fn().mockResolvedValue({ data: options.updateError ? null : updated, error: options.updateError ?? null }),
    })),
  };
  update.mockReturnValue(updateChain);

  const historyInsert = vi.fn().mockResolvedValue({ error: null });

  (globalThis as any).__mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === "event_history") return { insert: historyInsert };
      if (table === "access_denials") return { insert: vi.fn().mockResolvedValue({ error: null }) };
      return {
        // authorizeCoordinatorReview: .select("id, status, coordinator_id").eq().maybeSingle()
        // the end-time check:          .select("submitted_details").eq().single()
        select: vi.fn(() => ({
          eq: () => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: event, error: null }),
            single: vi.fn().mockResolvedValue({ data: { submitted_details: options.details ?? DETAILS }, error: null }),
          }),
        })),
        update,
      };
    }),
  };
  (globalThis as any).__mockUser = options.user ?? coordinator;

  // Completing must not call any other service: nothing is released or deleted.
  const fetchMock = vi.fn().mockRejectedValue(new Error("unexpected fetch"));
  vi.stubGlobal("fetch", fetchMock);

  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return { app, update, updateFilters, historyInsert, fetchMock };
}

function complete(app: express.Express, id: number | string = 7) {
  return request(app).post(`/api/events/${id}/complete`).set("Authorization", "Bearer t").send({});
}

describe("POST /api/events/:id/complete (E3-5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC1: marks a Confirmed event whose end time has passed as Completed", async () => {
    const { app, update, updateFilters } = buildApp();
    const res = await complete(app);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Completed");
    expect(update).toHaveBeenCalledWith({ status: "Completed" });
    // Only while still Confirmed and still assigned to the caller.
    expect(updateFilters).toEqual([
      ["id", 7],
      ["status", "Confirmed"],
      ["coordinator_id", coordinator.id],
    ]);
  });

  it("AC3: keeps the original review decision and records who completed it in the history", async () => {
    const { app, update, historyInsert } = buildApp();
    await complete(app);

    const changes = update.mock.calls[0][0];
    expect(changes).not.toHaveProperty("decided_at");
    expect(changes).not.toHaveProperty("decided_by");
    expect(historyInsert).toHaveBeenCalledWith([
      { event_id: 7, field: "Status", old_value: "Confirmed", new_value: "Completed", changed_by: coordinator.id },
    ]);
  });

  it("AC3: releases and deletes nothing — no other service is called", async () => {
    const { app, fetchMock } = buildApp();
    await complete(app);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("AC2: blocks an event that hasn't ended yet and says when it ends", async () => {
    setClockForTest(BEFORE_END);
    const { app, update } = buildApp();
    const res = await complete(app);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("2026-11-10 18:00");
    expect(update).not.toHaveBeenCalled();
  });

  it("AC2: blocks an event that is still running", async () => {
    setClockForTest("2026-11-10T05:00:00.000Z");
    const { app, update } = buildApp();
    expect((await complete(app)).status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("allows it from the end minute itself", async () => {
    setClockForTest("2026-11-10T10:00:00.000Z");
    const { app } = buildApp();
    expect((await complete(app)).status).toBe(200);
  });

  it("blocks an event with no valid date", async () => {
    const { app, update } = buildApp({ details: { name: "Spring Gala" } });
    const res = await complete(app);

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no valid date");
    expect(update).not.toHaveBeenCalled();
  });

  it.each(["Unassigned", "Requested", "Clarification Requested", "Planning", "Safety Review", "Completed", "Cancelled"])(
    "blocks an event in %s",
    async (status) => {
      const { app, update } = buildApp({ event: { id: 7, status, coordinator_id: coordinator.id } });
      expect((await complete(app)).status).toBe(409);
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("blocks a Rejected event", async () => {
    const { app, update } = buildApp({ event: { id: 7, status: "Rejected", coordinator_id: coordinator.id } });
    expect((await complete(app)).status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("blocks a coordinator the event isn't assigned to", async () => {
    const { app, update } = buildApp({ event: { id: 7, status: "Confirmed", coordinator_id: "COORD-0002" } });
    expect((await complete(app)).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(["organiser", "coordinator_lead", "safety_officer", "venue_staff", "technical_support", "attendee"])(
    "blocks the %s role",
    async (role) => {
      const { app, update } = buildApp({ user: { id: "USR-0001", role } });
      expect((await complete(app)).status).toBe(403);
      expect(update).not.toHaveBeenCalled();
    },
  );

  it("returns 409 when the event changed between the checks and the write", async () => {
    const { app, historyInsert } = buildApp({ updated: null });
    expect((await complete(app)).status).toBe(409);
    expect(historyInsert).not.toHaveBeenCalled();
  });

  it("returns 500 when the update fails", async () => {
    const { app } = buildApp({ updateError: { message: "boom" } });
    expect((await complete(app)).status).toBe(500);
  });

  it("returns 404 for a malformed event id", async () => {
    const { app } = buildApp();
    expect((await complete(app, "abc")).status).toBe(404);
  });

  it("returns 404 for an unknown event", async () => {
    const { app } = buildApp({ event: null });
    expect((await complete(app)).status).toBe(404);
  });
});
