// @ts-nocheck
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { eventStartsAt } from "../lib/eventTiming.js";
import { getRegistrationState, isListed } from "../lib/registrationPeriod.js";
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
const DETAILS = {
  name: "Film Night",
  proposedDate: "2026-11-20",
  startTime: "18:00",
  endTime: "21:00",
  registrationNeeded: true,
};

describe("eventStartsAt", () => {
  it("reads date + start time as Singapore time", () => {
    expect(eventStartsAt(DETAILS)?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
  });
  it("is null without a valid date", () => {
    expect(eventStartsAt({ startTime: "18:00" })).toBeNull();
  });
});

describe("getRegistrationState / isListed", () => {
  // Event starts 2026-11-20 18:00 SGT = 10:00 UTC. Default cutoff (5 days) = 2026-11-15 10:00 UTC.
  const at = (iso: string) => new Date(iso);
  const inputs = (openDate: string | null, override: string = "NONE", status = "Confirmed", details = DETAILS) => ({
    status,
    details,
    openDate,
    override,
  });
  const full = { registeredCount: 120, capacity: 120 };
  const room = { registeredCount: 119, capacity: 120 };

  it("before the open date (override NONE): NOT_OPEN and not listed; no date at all: NOT_OPEN", () => {
    const now = at("2026-10-31T15:00:00Z");
    expect(getRegistrationState(inputs("2026-11-01"), now)).toBe("NOT_OPEN");
    expect(isListed(inputs("2026-11-01"), now)).toBe(false);
    expect(getRegistrationState(inputs(null), at("2026-11-02T00:00:00Z"))).toBe("NOT_OPEN");
  });

  it("after the open date, before the cutoff, places left: OPEN and listed", () => {
    const now = at("2026-10-31T16:00:00Z"); // 00:00 SGT on 1 Nov
    expect(getRegistrationState(inputs("2026-11-01"), now, room)).toBe("OPEN");
    expect(isListed(inputs("2026-11-01"), now)).toBe(true);
  });

  it("full is FULL, and reopens after a withdrawal before the cutoff but not after it", () => {
    const before = at("2026-11-10T00:00:00Z");
    expect(getRegistrationState(inputs("2026-11-01"), before, full)).toBe("FULL");
    expect(getRegistrationState(inputs("2026-11-01"), before, room)).toBe("OPEN");
    const after = at("2026-11-16T00:00:00Z");
    expect(getRegistrationState(inputs("2026-11-01"), after, room)).toBe("CLOSED");
  });

  it("exactly at the cutoff: CLOSED; one minute before: OPEN", () => {
    expect(getRegistrationState(inputs("2026-11-01"), at("2026-11-15T09:59:00Z"))).toBe("OPEN");
    expect(getRegistrationState(inputs("2026-11-01"), at("2026-11-15T10:00:00Z"))).toBe("CLOSED");
  });

  it("FORCE_CLOSED with places left and inside the dates: CLOSED", () => {
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_CLOSED"), at("2026-11-05T00:00:00Z"), room)).toBe("CLOSED");
  });

  it("FORCE_OPEN before the open date with places left: OPEN and listed; when full: FULL", () => {
    const now = at("2026-10-20T00:00:00Z");
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN"), now, room)).toBe("OPEN");
    expect(isListed(inputs("2026-11-01", "FORCE_OPEN"), now)).toBe(true);
    expect(isListed(inputs(null, "FORCE_OPEN"), now)).toBe(true);
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN"), now, full)).toBe("FULL");
  });

  it("FORCE_OPEN inside the 5-day window: OPEN, and OPEN again after a withdrawal when it was full", () => {
    const now = at("2026-11-17T00:00:00Z");
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN"), now, room)).toBe("OPEN");
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN"), now, full)).toBe("FULL");
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN"), now, room)).toBe("OPEN");
  });

  it("the stop at the event start beats FORCE_OPEN and NONE", () => {
    const atStart = at("2026-11-20T10:00:00Z");
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN"), atStart, room)).toBe("CLOSED");
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN"), at("2026-11-20T11:00:00Z"), room)).toBe("CLOSED");
    expect(getRegistrationState(inputs("2026-11-01"), atStart, room)).toBe("CLOSED");
  });

  it("resetting to NONE after FORCE_CLOSED opens straight away once the open date has passed", () => {
    const now = at("2026-11-05T00:00:00Z");
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_CLOSED"), now, room)).toBe("CLOSED");
    expect(getRegistrationState(inputs("2026-11-01", "NONE"), now, room)).toBe("OPEN");
  });

  it("is never open for a non-Confirmed event, one that needs no registration, or one that has ended", () => {
    const now = at("2026-11-05T00:00:00Z");
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN", "Planning"), now)).toBe("CLOSED");
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN", "Confirmed", { ...DETAILS, registrationNeeded: false }), now)).toBe("CLOSED");
    expect(isListed(inputs("2026-11-01", "FORCE_OPEN", "Planning"), now)).toBe(false);
    expect(getRegistrationState(inputs("2026-11-01", "FORCE_OPEN"), at("2026-11-21T00:00:00Z"))).toBe("CLOSED");
  });
});

function buildApp(
  options: {
    user?: { id: string; role: string };
    event?: { id: number; status: string; coordinator_id: string | null };
    row?: Record<string, unknown>;
    updated?: Record<string, unknown> | null;
  } = {},
) {
  const event = options.event ?? { id: 7, status: "Confirmed", coordinator_id: coordinator.id };
  const row = options.row ?? { submitted_details: DETAILS, registration_open_date: null, registration_override: "NONE" };
  const updated = options.updated === undefined ? { ...event, submitted_details: DETAILS } : options.updated;

  const update = vi.fn();
  const filters: [string, unknown][] = [];
  const chain: any = {
    eq: vi.fn((c: string, v: unknown) => (filters.push([c, v]), chain)),
    in: vi.fn((c: string, v: unknown) => (filters.push([c, v]), chain)),
    select: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: updated, error: null }) })),
  };
  update.mockReturnValue(chain);
  const historyInsert = vi.fn().mockResolvedValue({ error: null });
  const denialInsert = vi.fn().mockResolvedValue({ error: null });

  (globalThis as any).__mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === "event_history") return { insert: historyInsert };
      if (table === "access_denials") return { insert: denialInsert };
      return {
        select: vi.fn((columns: string) => ({
          eq: () => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: columns.includes("registration_open_date") ? row : event,
              error: null,
            }),
          }),
        })),
        update,
      };
    }),
  };
  (globalThis as any).__mockUser = options.user ?? coordinator;

  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return { app, update, filters, historyInsert, denialInsert };
}

describe("registration period routes", () => {
  beforeEach(() => setClockForTest("2026-10-18T00:00:00Z"));

  it("PUT saves the open date for the assigned coordinator and records history", async () => {
    const { app, update, historyInsert } = buildApp();
    const res = await request(app).put("/api/events/7/registration").send({ openDate: "2026-11-01" });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ registration_open_date: "2026-11-01" });
    expect(historyInsert).toHaveBeenCalledWith([
      { event_id: 7, field: "Registration open date", old_value: null, new_value: "2026-11-01", changed_by: coordinator.id },
    ]);
  });

  it("PUT refuses a malformed date and one at or after the 5-day cutoff", async () => {
    const { app } = buildApp();
    expect((await request(app).put("/api/events/7/registration").send({ openDate: "tomorrow" })).status).toBe(400);
    expect((await request(app).put("/api/events/7/registration").send({ openDate: "2026-11-16" })).status).toBe(400);
  });

  it("PUT refuses an event that needs no registration or is past Planning stages", async () => {
    const noReg = buildApp({
      row: { submitted_details: { ...DETAILS, registrationNeeded: false }, registration_open_date: null, registration_override: "NONE" },
    });
    expect((await request(noReg.app).put("/api/events/7/registration").send({ openDate: "2026-11-01" })).status).toBe(409);

    const done = buildApp({ event: { id: 7, status: "Completed", coordinator_id: coordinator.id } });
    expect((await request(done.app).put("/api/events/7/registration").send({ openDate: "2026-11-01" })).status).toBe(409);
  });

  it("denies a coordinator who isn't assigned on all four endpoints (and records it)", async () => {
    for (const [method, path, body] of [
      ["put", "/api/events/7/registration", { openDate: "2026-11-01" }],
      ["post", "/api/events/7/registration/open", {}],
      ["post", "/api/events/7/registration/close", {}],
      ["post", "/api/events/7/registration/auto", {}],
    ] as const) {
      const { app, update, denialInsert } = buildApp({ user: { id: "COORD-0002", role: "coordinator" } });
      const res = await (request(app) as any)[method](path).send(body);

      expect(res.status).toBe(403);
      expect(update).not.toHaveBeenCalled();
      expect(denialInsert).toHaveBeenCalled();
    }
  });

  it.each([
    ["open", "FORCE_OPEN"],
    ["close", "FORCE_CLOSED"],
    ["auto", "NONE"],
  ])("POST /registration/%s sets registration_override to %s", async (action, value) => {
    const { app, update, filters } = buildApp();
    const res = await request(app).post(`/api/events/7/registration/${action}`).send({});

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ registration_override: value });
    expect(filters).toContainEqual(["status", "Confirmed"]);
    expect(filters).toContainEqual(["coordinator_id", coordinator.id]);
  });

  it("override routes need a Confirmed event, and refuse FORCE_OPEN once the event has started", async () => {
    const planning = buildApp({ event: { id: 7, status: "Planning", coordinator_id: coordinator.id } });
    expect((await request(planning.app).post("/api/events/7/registration/open").send({})).status).toBe(409);

    setClockForTest("2026-11-21T00:00:00Z");
    const ended = buildApp();
    expect((await request(ended.app).post("/api/events/7/registration/open").send({})).status).toBe(409);
  });

  it("returns 409 when the conditional update loses a race", async () => {
    const { app } = buildApp({ updated: null });
    expect((await request(app).post("/api/events/7/registration/close").send({})).status).toBe(409);
  });
});
