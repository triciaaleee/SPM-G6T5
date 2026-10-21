import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { equipmentUnitsRouter } from "../routes/equipmentUnits.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { suggestUnits, type ImpactUnit } from "../lib/unitImpact.js";
import { validateUnavailability } from "../lib/validateUnavailability.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser;
      req.supabase = (globalThis as any).__mockSupabase;
      req.headers.authorization = "Bearer test-token";
      next();
    },
  };
});

const technicalSupport = { id: "TS-0001", role: "technical_support" };
const coordinator = { id: "COORD-0001", role: "coordinator" };

/** A minimal in-memory table: select/eq/in/order, maybeSingle, insert (one or many), update and delete. */
function table(seed: Record<string, unknown>[], options: { insertError?: boolean; selectError?: boolean } = {}) {
  let rows = [...seed];
  let nextId = rows.reduce((max, r) => Math.max(max, Number(r.id ?? 0)), 0) + 1;

  function filtering(initial: Record<string, unknown>[]) {
    let filtered = initial;
    const q: Record<string, any> = {};
    q.eq = vi.fn((field: string, value: unknown) => {
      filtered = filtered.filter((r) => r[field] === value);
      return q;
    });
    q.in = vi.fn((field: string, values: unknown[]) => {
      filtered = filtered.filter((r) => values.includes(r[field]));
      return q;
    });
    q.order = vi.fn(() => q);
    q.select = vi.fn(() => q);
    q.maybeSingle = vi.fn(async () => ({ data: filtered[0] ?? null, error: null }));
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(options.selectError ? { data: null, error: { message: "boom" } } : { data: filtered, error: null }).then(resolve, reject);
    return q;
  }

  return {
    select: vi.fn(() => filtering(rows)),
    insert: vi.fn((payload: Record<string, unknown> | Record<string, unknown>[]) => {
      const inserted = options.insertError ? [] : (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: nextId++, ...p }));
      rows.push(...inserted);
      const q: Record<string, any> = {};
      q.select = vi.fn(() => q);
      q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(options.insertError ? { data: null, error: { message: "boom" } } : { data: inserted, error: null }).then(resolve);
      return q;
    }),
    update: vi.fn((patch: Record<string, unknown>) => {
      let matched: Record<string, unknown>[] = rows;
      const q: Record<string, any> = {};
      q.eq = vi.fn((field: string, value: unknown) => {
        matched = matched.filter((r) => r[field] === value);
        return q;
      });
      q.select = vi.fn(() => q);
      q.maybeSingle = vi.fn(async () => {
        for (const row of matched) Object.assign(row, patch);
        return { data: matched[0] ?? null, error: null };
      });
      return q;
    }),
    delete: vi.fn(() => {
      const q: Record<string, any> = {};
      let doomed: (r: Record<string, unknown>) => boolean = () => true;
      const run = () => {
        const gone = rows.filter(doomed);
        rows = rows.filter((r) => !doomed(r));
        return gone;
      };
      q.eq = vi.fn((field: string, value: unknown) => {
        doomed = (r) => r[field] === value;
        return Promise.resolve({ data: null, error: null }).then((v) => (run(), v));
      });
      q.in = vi.fn((field: string, values: unknown[]) => {
        doomed = (r) => values.includes(r[field]);
        const chain: Record<string, any> = {};
        chain.select = vi.fn(() => Promise.resolve({ data: run(), error: null }));
        return chain;
      });
      return q;
    }),
    get rows() {
      return rows;
    },
  };
}

const projectorUnits = [
  { id: 12, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
  { id: 13, type: "Projector", status: "Damaged", label: "A-013", equipment_catalog_id: 1 },
  { id: 14, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
];

function event(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Event ${id}`,
    proposedDate: "2099-06-10",
    startTime: "09:00",
    endTime: "15:00",
    equipment: null,
    coordinatorId: `COORD-000${id}`,
    ...overrides,
  };
}

function buildApp(
  options: {
    user?: { id: string; role: string };
    units?: Record<string, unknown>[];
    periods?: Record<string, unknown>[];
    bookings?: Record<string, unknown>[];
    events?: Record<string, unknown>[];
    eventsStatus?: number;
    insertError?: boolean;
    bookingsError?: boolean;
    publishResult?: boolean;
  } = {},
) {
  const equipment = table(options.units ?? projectorUnits);
  const unavailability = table(options.periods ?? [], { insertError: options.insertError });
  // A booking holds its unit unless it was Released (migration 0052), so fixtures default to Reserved.
  const bookings = table((options.bookings ?? []).map((row) => ({ status: "Reserved", ...row })), { selectError: options.bookingsError });
  // Units belong to a catalog item by id (migration 0048); the API still names it.
  const catalog = table([
    { id: 1, name: "Projector" },
    { id: 2, name: "Screen" },
  ]);

  (globalThis as any).__mockSupabase = {
    from: vi.fn((name: string) => {
      if (name === "equipment") return equipment;
      if (name === "equipment_catalog") return catalog;
      if (name === "equipment_unavailability") return unavailability;
      if (name === "equipment_booking") return bookings;
      throw new Error(`unexpected table ${name}`);
    }),
  };
  (globalThis as any).__mockUser = options.user ?? technicalSupport;

  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes("venue-booking-info")) {
      const status = options.eventsStatus ?? 200;
      if (status >= 300) return { ok: false, status, json: async () => ({}) };
      const ids = (new URL(url).searchParams.get("ids") ?? "").split(",").map(Number);
      const events = (options.events ?? []).filter((e) => ids.includes(e.id as number));
      return { ok: true, status: 200, json: async () => ({ events }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);

  const publish = vi.fn().mockResolvedValue(options.publishResult ?? true);
  setPublisherForTest({ publish });

  const app = express();
  app.use(express.json());
  app.use("/api/equipment-units", equipmentUnitsRouter);
  return { app, equipment, unavailability, bookings, publish, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateUnavailability", () => {
  it("accepts a reason, a start date and an optional end date and note", () => {
    expect(validateUnavailability({ reason: "Damaged", startDate: "2026-11-03", endDate: "2026-11-07", note: " cracked lens " })).toEqual({
      valid: true,
      fields: {},
      value: { reason: "Damaged", startDate: "2026-11-03", endDate: "2026-11-07", note: "cracked lens" },
    });
  });

  it("treats a missing or blank end date as open-ended, and a blank note as none", () => {
    for (const endDate of [undefined, null, "", "  "]) {
      expect(validateUnavailability({ reason: "Under Maintenance", startDate: "2026-11-03", endDate, note: " " })).toEqual({
        valid: true,
        fields: {},
        value: { reason: "Under Maintenance", startDate: "2026-11-03", endDate: null, note: null },
      });
    }
  });

  it("collects every problem in one pass", () => {
    const result = validateUnavailability({ reason: "Lost", startDate: "2026-02-30", endDate: "tomorrow", note: "x".repeat(501) });
    expect(result.valid).toBe(false);
    expect(Object.keys(result.fields).sort()).toEqual(["endDate", "note", "reason", "startDate"]);
  });

  it("requires a start date, and an end date that isn't before it", () => {
    expect(validateUnavailability({ reason: "Damaged" }).fields.startDate).toBe("Start date is required.");
    expect(validateUnavailability({ reason: "Damaged", startDate: "2026-11-07", endDate: "2026-11-03" }).fields.endDate).toMatch(
      /before the start date/,
    );
    expect(validateUnavailability({ reason: "Damaged", startDate: "2026-11-03", endDate: "2026-11-03" }).valid).toBe(true);
  });
});

describe("suggestUnits", () => {
  const unit = (id: number, state: ImpactUnit["state"], dates: string[] = []): ImpactUnit => ({
    id,
    label: null,
    state,
    reason: null,
    events: dates.map((proposedDate, i) => ({ eventId: id * 10 + i, eventName: `E${id}`, proposedDate, startTime: "09:00", coordinatorId: null })),
  });

  it("takes free units first, lowest id first, and never one already out of use", () => {
    const units = [unit(1, "reserved", ["2099-01-01"]), unit(2, "unavailable"), unit(3, "free"), unit(4, "free")];
    expect(suggestUnits(units, 2)).toEqual([3, 4]);
    expect(suggestUnits(units, 10)).toEqual([3, 4, 1]);
  });

  it("when it must take reserved units, takes those whose events are furthest away, so coordinators have the most time", () => {
    const units = [
      unit(1, "reserved", ["2099-03-01"]),
      unit(2, "reserved", ["2099-09-01"]),
      unit(3, "reserved", ["2099-06-01", "2099-12-01"]), // its soonest event is June
      unit(4, "reserved", ["2099-09-01"]),
    ];
    expect(suggestUnits(units, 3)).toEqual([2, 4, 3]);
  });
});

describe("GET /api/equipment-units (E5-5)", () => {
  it("is for Technical Support only", async () => {
    const { app } = buildApp({ user: coordinator });
    expect((await request(app).get("/api/equipment-units")).status).toBe(403);
  });

  it("lists units with their label and their running and upcoming periods, not finished ones", async () => {
    const { app } = buildApp({
      periods: [
        { id: 1, equipment_id: 12, reason: "Damaged", start_date: "2000-01-01", end_date: "2000-01-31", note: null },
        { id: 2, equipment_id: 12, reason: "Under Maintenance", start_date: "2000-02-01", end_date: null, note: "servicing" },
        { id: 3, equipment_id: 12, reason: "Damaged", start_date: "2099-03-01", end_date: "2099-03-05", note: null },
      ],
    });

    const res = await request(app).get("/api/equipment-units");

    expect(res.status).toBe(200);
    expect(res.body.units[0]).toEqual({
      id: 12,
      type: "Projector",
      status: "Available",
      label: null,
      periods: [
        { id: 2, reason: "Under Maintenance", startDate: "2000-02-01", endDate: null, note: "servicing" },
        { id: 3, reason: "Damaged", startDate: "2099-03-01", endDate: "2099-03-05", note: null },
      ],
    });
    expect(res.body.units[1]).toMatchObject({ id: 13, status: "Damaged", label: "A-013", periods: [] });
  });

  it("narrows to one type", async () => {
    const { app } = buildApp({ units: [...projectorUnits, { id: 20, type: "Screen", status: "Available", label: null, equipment_catalog_id: 2 }] });
    const res = await request(app).get("/api/equipment-units?type=Screen");
    expect(res.body.units.map((u: { id: number }) => u.id)).toEqual([20]);
  });
});

describe("GET /api/equipment-units/impact (preview before marking)", () => {
  const url = "/api/equipment-units/impact?type=Projector&startDate=2099-06-01&endDate=2099-06-30";

  it("is for Technical Support only, and checks its input", async () => {
    expect((await request(buildApp({ user: coordinator }).app).get(url)).status).toBe(403);

    const { app } = buildApp();
    const bad = await request(app).get("/api/equipment-units/impact?type=&startDate=2099-02-30&endDate=nope&quantity=0");
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.fields).sort()).toEqual(["endDate", "quantity", "startDate", "type"]);
    expect((await request(app).get("/api/equipment-units/impact?type=Projector&startDate=2099-06-10&endDate=2099-06-01")).body.fields.endDate).toMatch(/before/);
  });

  it("shows each unit as free, reserved (with its events) or already out of use", async () => {
    const { app } = buildApp({
      units: [
        { id: 12, type: "Projector", status: "Available", label: "A-012", equipment_catalog_id: 1 },
        { id: 13, type: "Projector", status: "Damaged", label: null, equipment_catalog_id: 1 },
        { id: 14, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
        { id: 15, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
      ],
      periods: [{ id: 1, equipment_id: 15, reason: "Under Maintenance", start_date: "2099-06-05", end_date: "2099-06-06", note: null }],
      bookings: [{ id: 1, equipment_id: 14, event_id: 1, request_item_id: 100 }],
      events: [event(1)],
    });

    const res = await request(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([
      { id: 12, label: "A-012", state: "free", reason: null, events: [] },
      { id: 13, label: null, state: "unavailable", reason: "Damaged", events: [] },
      {
        id: 14,
        label: null,
        state: "reserved",
        reason: null,
        events: [{ eventId: 1, eventName: "Event 1", proposedDate: "2099-06-10", startTime: "09:00" }],
      },
      { id: 15, label: null, state: "unavailable", reason: "Under Maintenance", events: [] },
    ]);
    expect(res.body.pickable).toBe(2);
    expect(res.body.suggested).toEqual([]);
  });

  it("answers the all-reserved case: with quantity, suggests the units whose events are furthest away", async () => {
    const { app } = buildApp({
      units: [
        { id: 1, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
        { id: 2, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
        { id: 3, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
      ],
      bookings: [
        { id: 1, equipment_id: 1, event_id: 1, request_item_id: 100 },
        { id: 2, equipment_id: 2, event_id: 2, request_item_id: 101 },
        { id: 3, equipment_id: 3, event_id: 3, request_item_id: 102 },
      ],
      events: [event(1, { proposedDate: "2099-06-05" }), event(2, { proposedDate: "2099-06-25" }), event(3, { proposedDate: "2099-06-15" })],
    });

    const res = await request(app).get(`${url}&quantity=2`);

    expect(res.body.units.every((u: { state: string }) => u.state === "reserved")).toBe(true);
    expect(res.body.suggested).toEqual([2, 3]);
  });

  it("ignores reservations outside the period and events that are over", async () => {
    const { app } = buildApp({
      units: [
        { id: 1, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
        { id: 2, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
      ],
      bookings: [
        { id: 1, equipment_id: 1, event_id: 1, request_item_id: 100 },
        { id: 2, equipment_id: 2, event_id: 2, request_item_id: 101 },
      ],
      events: [event(1, { proposedDate: "2099-08-01" }), event(2, { proposedDate: "2000-01-05" })],
    });

    const res = await request(app).get("/api/equipment-units/impact?type=Projector&startDate=2000-01-01&endDate=2099-06-30");

    expect(res.body.units.map((u: { id: number; state: string }) => [u.id, u.state])).toEqual([
      [1, "free"],
      [2, "free"],
    ]);
  });

  it("answers 502 when it can't tell which events the units are reserved for", async () => {
    const { app } = buildApp({ bookings: [{ id: 1, equipment_id: 12, event_id: 1, request_item_id: 100 }], eventsStatus: 500 });
    expect((await request(app).get(url)).status).toBe(502);
  });
});

describe("POST /api/equipment-units/mark (E5-5)", () => {
  const body = { type: "Projector", unitIds: [12], reason: "Damaged", startDate: "2099-06-01", endDate: "2099-06-30", note: "cracked lens" };

  it("is for Technical Support only", async () => {
    const { app, unavailability } = buildApp({ user: coordinator });
    expect((await request(app).post("/api/equipment-units/mark").send(body)).status).toBe(403);
    expect(unavailability.rows).toHaveLength(0);
  });

  it("rejects bad input, units that don't exist or aren't of that type, and units already out of use", async () => {
    const { app, unavailability } = buildApp();

    const bad = await request(app).post("/api/equipment-units/mark").send({ reason: "Lost", unitIds: [] });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.fields).sort()).toEqual(["reason", "startDate", "type", "unitIds"]);

    expect((await request(app).post("/api/equipment-units/mark").send({ ...body, unitIds: [12, 999] })).status).toBe(404);
    expect((await request(app).post("/api/equipment-units/mark").send({ ...body, type: "Screen" })).status).toBe(404);

    const out = await request(app).post("/api/equipment-units/mark").send({ ...body, unitIds: [12, 13] });
    expect(out.status).toBe(409);
    expect(out.body.unitIds).toEqual([13]);
    expect(out.body.error).toBe("Projector #13 is already out of use for those dates.");
    expect(unavailability.rows).toHaveLength(0);
  });

  it("saves one period per unit, recording who marked them (AC1)", async () => {
    const { app, unavailability } = buildApp();

    const res = await request(app).post("/api/equipment-units/mark").send({ ...body, unitIds: [12, 14] });

    expect(res.status).toBe(201);
    expect(unavailability.rows).toEqual([
      expect.objectContaining({ equipment_id: 12, reason: "Damaged", start_date: "2099-06-01", end_date: "2099-06-30", note: "cracked lens", marked_by: "TS-0001" }),
      expect.objectContaining({ equipment_id: 14, reason: "Damaged", start_date: "2099-06-01", end_date: "2099-06-30", marked_by: "TS-0001" }),
    ]);
    expect(res.body.periods.map((p: { unitId: number }) => p.unitId)).toEqual([12, 14]);
    expect(res.body.periods[0].period).toMatchObject({ reason: "Damaged", startDate: "2099-06-01", endDate: "2099-06-30" });
    expect(res.body).toMatchObject({ affectedEvents: [], notified: true });
  });

  it("tells events-service about each affected event, so a Confirmed event moves to Needs Review", async () => {
    process.env.INTERNAL_SERVICE_SECRET = "test-internal-secret";
    const { app, fetchMock } = buildApp({
      bookings: [
        { id: 1, equipment_id: 12, event_id: 1, request_item_id: 100 },
        { id: 3, equipment_id: 14, event_id: 2, request_item_id: 102 },
      ],
      events: [event(1), event(2, { proposedDate: "2099-06-20" })],
    });

    const res = await request(app).post("/api/equipment-units/mark").send({ ...body, unitIds: [12, 14] });

    expect(res.status).toBe(201);
    const urls = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/arrangements-changed"));
    expect(urls.sort()).toEqual([
      expect.stringContaining("/api/events/1/arrangements-changed"),
      expect.stringContaining("/api/events/2/arrangements-changed"),
    ]);
  });

  it("tells nobody when none of the units is reserved", async () => {
    const { app, publish } = buildApp();
    await request(app).post("/api/equipment-units/mark").send(body);
    expect(publish).not.toHaveBeenCalled();
  });

  it("notifies the assigned coordinator of each event reserving a unit in the period, once per event (AC2)", async () => {
    const { app, publish } = buildApp({
      bookings: [
        { id: 1, equipment_id: 12, event_id: 1, request_item_id: 100 },
        { id: 2, equipment_id: 14, event_id: 1, request_item_id: 101 },
        { id: 3, equipment_id: 14, event_id: 2, request_item_id: 102 },
      ],
      events: [event(1), event(2, { proposedDate: "2099-06-20" })],
    });

    const res = await request(app).post("/api/equipment-units/mark").send({ ...body, unitIds: [12, 14] });

    expect(res.status).toBe(201);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledWith({
      type: "equipment.unusable",
      eventId: 1,
      actorId: "TS-0001",
      recipients: { userIds: ["COORD-0001"], roles: [] },
      data: { eventName: "Event 1", equipmentType: "Projector", quantity: 2, reason: "Damaged", startDate: "2099-06-01", endDate: "2099-06-30" },
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 2, recipients: { userIds: ["COORD-0002"], roles: [] }, data: expect.objectContaining({ quantity: 1 }) }),
    );
    expect(res.body.affectedEvents).toEqual([
      { eventId: 1, eventName: "Event 1", units: 2 },
      { eventId: 2, eventName: "Event 2", units: 1 },
    ]);
    expect(res.body.notified).toBe(true);
  });

  it("only notifies for events inside the period and not yet over, and ignores units that weren't marked", async () => {
    const { app, publish } = buildApp({
      bookings: [
        { id: 1, equipment_id: 12, event_id: 1, request_item_id: 100 },
        { id: 2, equipment_id: 12, event_id: 2, request_item_id: 101 },
        { id: 3, equipment_id: 12, event_id: 3, request_item_id: 102 },
        { id: 4, equipment_id: 14, event_id: 4, request_item_id: 103 },
      ],
      events: [
        event(1, { proposedDate: "2099-06-10" }), // inside the period
        event(2, { proposedDate: "2099-08-01" }), // after it ends
        event(3, { proposedDate: "2000-01-05" }), // over long ago
        event(4, { proposedDate: "2099-06-10" }), // reserved a unit that wasn't marked
      ],
    });

    const res = await request(app)
      .post("/api/equipment-units/mark")
      .send({ ...body, startDate: "2000-01-01", endDate: "2099-06-30" });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventId: 1 }));
    expect(res.body.affectedEvents.map((e: { eventId: number }) => e.eventId)).toEqual([1]);
  });

  it("treats an open-ended period as covering every later event", async () => {
    const { app, publish } = buildApp({
      bookings: [{ id: 1, equipment_id: 12, event_id: 1, request_item_id: 100 }],
      events: [event(1, { proposedDate: "2099-12-31" })],
    });

    await request(app).post("/api/equipment-units/mark").send({ ...body, reason: "Under Maintenance", endDate: undefined });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ endDate: null }) }));
  });

  it("reports notified:false, keeping the saved periods, when a coordinator can't be reached or a notice fails", async () => {
    const noCoordinator = buildApp({
      bookings: [{ id: 1, equipment_id: 12, event_id: 1, request_item_id: 100 }],
      events: [event(1, { coordinatorId: null })],
    });
    const first = await request(noCoordinator.app).post("/api/equipment-units/mark").send(body);
    expect(first.status).toBe(201);
    expect(first.body.notified).toBe(false);
    expect(first.body.affectedEvents).toHaveLength(1);
    expect(noCoordinator.publish).not.toHaveBeenCalled();

    const failing = buildApp({
      bookings: [{ id: 1, equipment_id: 12, event_id: 1, request_item_id: 100 }],
      events: [event(1)],
      publishResult: false,
    });
    const second = await request(failing.app).post("/api/equipment-units/mark").send(body);
    expect(second.status).toBe(201);
    expect(second.body.notified).toBe(false);
    expect(failing.unavailability.rows).toHaveLength(1);
  });

  it("still saves the periods when events-service can't be reached", async () => {
    const eventsDown = buildApp({ bookings: [{ id: 1, equipment_id: 12, event_id: 1, request_item_id: 100 }], eventsStatus: 500 });

    const res = await request(eventsDown.app).post("/api/equipment-units/mark").send(body);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ affectedEvents: [], notified: false });
    expect(eventsDown.unavailability.rows).toHaveLength(1);
  });

  it("answers 500, saves nothing and notifies nobody when the reservations or the periods can't be handled", async () => {
    const insertFails = buildApp({
      insertError: true,
      bookings: [{ id: 1, equipment_id: 12, event_id: 1, request_item_id: 100 }],
      events: [event(1)],
    });
    expect((await request(insertFails.app).post("/api/equipment-units/mark").send(body)).status).toBe(500);
    expect(insertFails.publish).not.toHaveBeenCalled();

    const bookingsDown = buildApp({ bookingsError: true });
    expect((await request(bookingsDown.app).post("/api/equipment-units/mark").send(body)).status).toBe(500);
    expect(bookingsDown.unavailability.rows).toHaveLength(0);
  });
});

describe("marking units usable again (E5-5)", () => {
  const periods = [
    { id: 5, equipment_id: 12, reason: "Damaged", start_date: "2099-06-01", end_date: null, note: null },
    { id: 6, equipment_id: 14, reason: "Damaged", start_date: "2099-06-01", end_date: null, note: null },
    { id: 7, equipment_id: 14, reason: "Under Maintenance", start_date: "2099-09-01", end_date: null, note: null },
  ];

  it("clears a group of periods at once", async () => {
    const { app, unavailability } = buildApp({ periods });

    const res = await request(app).post("/api/equipment-units/unavailability/clear").send({ periodIds: [5, 6] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 2 });
    expect(unavailability.rows.map((r) => r.id)).toEqual([7]);
  });

  it("is for Technical Support only and needs at least one period", async () => {
    const forbidden = buildApp({ user: coordinator, periods });
    expect((await request(forbidden.app).post("/api/equipment-units/unavailability/clear").send({ periodIds: [5] })).status).toBe(403);
    expect(forbidden.unavailability.rows).toHaveLength(3);

    const { app } = buildApp({ periods });
    expect((await request(app).post("/api/equipment-units/unavailability/clear").send({ periodIds: [] })).status).toBe(400);
    expect((await request(app).post("/api/equipment-units/unavailability/clear").send({ periodIds: ["x"] })).status).toBe(400);
  });

  it("removes one unit's period, only if it belongs to that unit", async () => {
    const { app, unavailability } = buildApp({ periods });

    expect((await request(app).delete("/api/equipment-units/14/unavailability/5")).status).toBe(404);
    expect((await request(app).delete("/api/equipment-units/12/unavailability/99")).status).toBe(404);
    expect((await request(app).delete("/api/equipment-units/x/unavailability/5")).status).toBe(400);
    expect(unavailability.rows).toHaveLength(3);

    const res = await request(app).delete("/api/equipment-units/12/unavailability/5");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
    expect(unavailability.rows.map((r) => r.id)).toEqual([6, 7]);
  });

  it("is for Technical Support only", async () => {
    const { app, unavailability } = buildApp({ user: coordinator, periods });
    expect((await request(app).delete("/api/equipment-units/12/unavailability/5")).status).toBe(403);
    expect(unavailability.rows).toHaveLength(3);
  });
});

describe("PATCH /api/equipment-units/:id (unit label)", () => {
  it("sets a label, trimmed, and clears it when blank", async () => {
    const { app, equipment } = buildApp();

    const set = await request(app).patch("/api/equipment-units/12").send({ label: "  Sticker A-012 " });
    expect(set.status).toBe(200);
    expect(set.body.unit).toEqual({ id: 12, label: "Sticker A-012" });
    expect(equipment.rows.find((r) => r.id === 12)?.label).toBe("Sticker A-012");

    const cleared = await request(app).patch("/api/equipment-units/12").send({ label: " " });
    expect(cleared.body.unit).toEqual({ id: 12, label: null });
  });

  it("rejects a too-long label, an unknown unit and other roles", async () => {
    const { app } = buildApp();
    expect((await request(app).patch("/api/equipment-units/12").send({ label: "x".repeat(51) })).status).toBe(400);
    expect((await request(app).patch("/api/equipment-units/999").send({ label: "A" })).status).toBe(404);
    expect((await request(app).patch("/api/equipment-units/abc").send({ label: "A" })).status).toBe(400);
    expect((await request(buildApp({ user: coordinator }).app).patch("/api/equipment-units/12").send({ label: "A" })).status).toBe(403);
  });
});
