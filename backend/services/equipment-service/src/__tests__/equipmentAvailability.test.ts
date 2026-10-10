import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { equipmentAvailabilityRouter } from "../routes/equipmentAvailability.js";
import { validateAvailabilityQuery } from "../lib/validateAvailabilityQuery.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "TS-0001", role: "technical_support" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const technicalSupport = { id: "TS-0001", role: "technical_support" };

/** A supabase-js style query: every filter returns the query, and awaiting it yields `result`. */
function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "in", "neq"]) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

interface TestEvent {
  id: number;
  name: string | null;
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
  equipment: string | null;
}

function testEvent(overrides: Partial<TestEvent> & { id: number }): TestEvent {
  return { name: "Alumni Gala", proposedDate: "2026-09-20", startTime: "09:00", endTime: "15:00", equipment: null, ...overrides };
}

function buildApp(
  options: {
    user?: { id: string; role: string };
    equipmentRows?: { id: number; status: string }[];
    bookingRows?: { equipment_id: number; event_id: number }[];
    catalogRow?: { available_stock: number } | null;
    eventsById?: Record<number, TestEvent>;
    bookingInfoStatus?: number;
  } = {},
) {
  const equipmentSelect = query({ data: options.equipmentRows ?? [], error: null });
  const bookingSelect = query({ data: options.bookingRows ?? [], error: null });
  const catalogSelect = query({ data: options.catalogRow ?? null, error: null });

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "equipment") return { select: equipmentSelect.select };
      if (table === "equipment_booking") return { select: bookingSelect.select };
      if (table === "equipment_catalog") return { select: catalogSelect.select };
      throw new Error(`unexpected table ${table}`);
    }),
  };

  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("venue-booking-info")) {
      const status = options.bookingInfoStatus ?? 200;
      if (!(status < 300)) return { ok: false, status, json: async () => ({}) };
      const idsParam = new URL(url).searchParams.get("ids") ?? "";
      const ids = idsParam.split(",").map(Number);
      const events = ids
        .map((id) => (options.eventsById ?? {})[id])
        .filter((event): event is TestEvent => Boolean(event));
      return { ok: true, status: 200, json: async () => ({ events }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? technicalSupport;

  const app = express();
  app.use(express.json());
  app.use("/api/equipment-availability", equipmentAvailabilityRouter);
  return { app, supabase, fetchMock, bookingSelect, catalogSelect };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateAvailabilityQuery", () => {
  it("accepts a well-formed query", () => {
    expect(validateAvailabilityQuery({ eventId: "7", type: "Projector", quantity: "3" })).toEqual({
      valid: true,
      fields: {},
      value: { eventId: 7, type: "Projector", quantity: 3 },
    });
  });

  it("rejects a missing or non-positive eventId", () => {
    expect(validateAvailabilityQuery({ type: "Projector", quantity: "1" }).valid).toBe(false);
    expect(validateAvailabilityQuery({ eventId: "0", type: "Projector", quantity: "1" }).valid).toBe(false);
  });

  it("rejects a blank type", () => {
    const result = validateAvailabilityQuery({ eventId: "7", type: "  ", quantity: "1" });
    expect(result.valid).toBe(false);
    expect(result.fields.type).toBeDefined();
  });

  it("rejects a non-positive quantity", () => {
    expect(validateAvailabilityQuery({ eventId: "7", type: "Projector", quantity: "0" }).valid).toBe(false);
    expect(validateAvailabilityQuery({ eventId: "7", type: "Projector", quantity: "1.5" }).valid).toBe(false);
  });
});

describe("GET /api/equipment-availability", () => {
  it("rejects a non-technical-support caller", async () => {
    const { app } = buildApp({ user: { id: "COORD-0001", role: "coordinator" } });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
    expect(res.status).toBe(403);
  });

  it("surfaces validation errors", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/equipment-availability?eventId=abc&type=Projector&quantity=1");
    expect(res.status).toBe(400);
    expect(res.body.fields.eventId).toBeDefined();
  });

  it("404s when the event doesn't exist", async () => {
    const { app } = buildApp({ eventsById: {} });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
    expect(res.status).toBe(404);
  });

  it("409s when the event has no date set", async () => {
    const { app } = buildApp({ eventsById: { 7: testEvent({ id: 7, proposedDate: null }) } });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
    expect(res.status).toBe(409);
  });

  it("reports full availability when nothing is damaged or booked elsewhere", async () => {
    const { app } = buildApp({
      eventsById: { 7: testEvent({ id: 7 }) },
      equipmentRows: [
        { id: 1, status: "Available" },
        { id: 2, status: "Available" },
        { id: 3, status: "Available" },
      ],
      bookingRows: [],
    });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=2");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "Projector",
      requestedQuantity: 2,
      totalUnits: 3,
      unusableCount: 0,
      reservedElsewhereCount: 0,
      availableCount: 3,
      shortfall: 0,
    });
  });

  // AC2: damaged/under-maintenance units never count as usable.
  it("excludes damaged and under-maintenance units from usable inventory", async () => {
    const { app } = buildApp({
      eventsById: { 7: testEvent({ id: 7 }) },
      equipmentRows: [
        { id: 1, status: "Available" },
        { id: 2, status: "Damaged" },
        { id: 3, status: "Under Maintenance" },
      ],
    });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalUnits: 3, unusableCount: 2, availableCount: 1 });
  });

  // AC1: a unit booked to another event with an overlapping window is excluded.
  it("excludes a unit booked to another event with an overlapping window", async () => {
    const { app } = buildApp({
      eventsById: {
        7: testEvent({ id: 7, proposedDate: "2026-09-20", startTime: "09:00", endTime: "15:00" }),
        20: testEvent({ id: 20, proposedDate: "2026-09-20", startTime: "10:00", endTime: "11:00" }),
      },
      equipmentRows: [{ id: 1, status: "Available" }],
      bookingRows: [{ equipment_id: 1, event_id: 20 }],
    });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reservedElsewhereCount: 1, availableCount: 0, shortfall: 1 });
  });

  // AC1 (negative case): a unit booked to another event on a different day is not excluded.
  it("does not exclude a unit booked to a non-overlapping event", async () => {
    const { app } = buildApp({
      eventsById: {
        7: testEvent({ id: 7, proposedDate: "2026-09-20", startTime: "09:00", endTime: "15:00" }),
        20: testEvent({ id: 20, proposedDate: "2026-09-22", startTime: "10:00", endTime: "11:00" }),
      },
      equipmentRows: [{ id: 1, status: "Available" }],
      bookingRows: [{ equipment_id: 1, event_id: 20 }],
    });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reservedElsewhereCount: 0, availableCount: 1 });
  });

  it("excludes the current event itself from the booking conflict query", async () => {
    const { app, bookingSelect } = buildApp({
      eventsById: { 7: testEvent({ id: 7 }) },
      equipmentRows: [{ id: 1, status: "Available" }],
      bookingRows: [],
    });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
    expect(res.status).toBe(200);
    expect(bookingSelect.neq).toHaveBeenCalledWith("event_id", 7);
  });

  // Conservative default: an unresolvable other booking (events-service couldn't
  // say when it is) is treated as blocking rather than over-promising the unit.
  it("treats a booking to an event with unknown schedule as blocking", async () => {
    const { app } = buildApp({
      eventsById: { 7: testEvent({ id: 7 }) }, // event 20 deliberately absent
      equipmentRows: [{ id: 1, status: "Available" }],
      bookingRows: [{ equipment_id: 1, event_id: 20 }],
    });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reservedElsewhereCount: 1, availableCount: 0 });
  });

  // AC3: the shortfall against the requested quantity.
  it("reports a shortfall when demand exceeds availability", async () => {
    const { app } = buildApp({
      eventsById: { 7: testEvent({ id: 7 }) },
      equipmentRows: [
        { id: 1, status: "Available" },
        { id: 2, status: "Available" },
      ],
    });
    const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=5");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ availableCount: 2, shortfall: 3 });
  });

  // The real fix: equipment_catalog.available_stock is what E5-3 actually
  // moves (Arranged/Partially Fulfilled), so it's the baseline — not the
  // per-unit equipment_booking table, which E5-6 hasn't started writing to.
  describe("ties availability to equipment_catalog (the number the stock table shows)", () => {
    it("reports a shortfall once the catalog is depleted, even though every physical unit is still marked Available", async () => {
      const { app } = buildApp({
        eventsById: { 7: testEvent({ id: 7 }) },
        catalogRow: { available_stock: 0 },
        equipmentRows: [
          { id: 1, status: "Available" },
          { id: 2, status: "Available" },
        ],
        bookingRows: [],
      });
      const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ catalogAvailableStock: 0, availableCount: 0, shortfall: 1 });
    });

    it("uses the catalog's count as the baseline, then still subtracts damaged/under-maintenance units on top", async () => {
      const { app } = buildApp({
        eventsById: { 7: testEvent({ id: 7 }) },
        catalogRow: { available_stock: 5 },
        equipmentRows: [
          { id: 1, status: "Available" },
          { id: 2, status: "Damaged" },
          { id: 3, status: "Under Maintenance" },
        ],
      });
      const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=3");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ catalogAvailableStock: 5, unusableCount: 2, availableCount: 3, shortfall: 0 });
    });

    it("falls back to the physical unit count when the type isn't in the catalog at all", async () => {
      const { app } = buildApp({
        eventsById: { 7: testEvent({ id: 7 }) },
        catalogRow: null,
        equipmentRows: [
          { id: 1, status: "Available" },
          { id: 2, status: "Available" },
        ],
      });
      const res = await request(app).get("/api/equipment-availability?eventId=7&type=Spare+Widget&quantity=1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ catalogAvailableStock: null, availableCount: 2 });
    });

    it("never reports a negative availableCount when exclusions exceed the catalog's count", async () => {
      const { app } = buildApp({
        eventsById: { 7: testEvent({ id: 7 }) },
        catalogRow: { available_stock: 1 },
        equipmentRows: [
          { id: 1, status: "Damaged" },
          { id: 2, status: "Damaged" },
        ],
      });
      const res = await request(app).get("/api/equipment-availability?eventId=7&type=Projector&quantity=1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ availableCount: 0, shortfall: 1 });
    });
  });
});
