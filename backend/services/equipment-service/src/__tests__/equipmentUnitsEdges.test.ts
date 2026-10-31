import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/supabaseAdmin.js", async () => ({ supabaseAdmin: (await import("./helpers/mockDb.js")).supabaseAdminProxy }));

import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";
import { equipmentUnitsRouter } from "../routes/equipmentUnits.js";
import { appWith, bearer, callRoute } from "./helpers/app.js";
import { createFakeDb } from "./helpers/fakeDb.js";
import { useDb } from "./helpers/mockDb.js";

const TS = bearer("TS-0001", "technical_support");
const COORD = bearer("COORD-0001", "coordinator");
const app = () => appWith("/api/equipment-units", equipmentUnitsRouter);

const fetchMock = vi.fn();
let eventsReply: { ok: boolean; events: unknown[] };
let arrangementsChanged: { url: string; body: any }[];
let publisher: ReturnType<typeof createFakePublisher>;

const ev = (over: Record<string, unknown> = {}) => ({
  id: 8, name: "Fest", proposedDate: "2026-12-01", startTime: "10:00", endTime: "12:00", coordinatorId: "COORD-1", ...over,
});
const unit = (id: number, over: Record<string, unknown> = {}) => ({ id, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1, ...over });
const period = (id: number, equipment_id: number, over: Record<string, unknown> = {}) => ({
  id, equipment_id, reason: "Damaged", start_date: "2026-12-01", end_date: "2026-12-03", note: null, ...over,
});
const reserved = (id: number, equipment_id: number, event_id: number) => ({ id, equipment_id, event_id, status: "Reserved" });
const seed = (extra: Record<string, any[]> = {}) => ({
  equipment_catalog: [{ id: 1, name: "Projector" }, { id: 2, name: "Microphone" }],
  equipment: [unit(1), unit(2), unit(3), unit(4, { type: "Microphone", equipment_catalog_id: 2 })],
  ...extra,
});

beforeEach(() => {
  eventsReply = { ok: true, events: [] };
  arrangementsChanged = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: any) => {
    if (url.includes("arrangements-changed")) {
      arrangementsChanged.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    return { ok: eventsReply.ok, status: eventsReply.ok ? 200 : 500, json: async () => ({ events: eventsReply.events }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("EVENTS_SERVICE_URL", "http://events.test");
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "internal");
  publisher = createFakePublisher();
  setPublisherForTest(publisher);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  setPublisherForTest(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("access", () => {
  const routes: [string, "get" | "post" | "delete" | "patch", string, string][] = [
    ["list", "get", "/", "/api/equipment-units"],
    ["impact", "get", "/impact", "/api/equipment-units/impact"],
    ["mark", "post", "/mark", "/api/equipment-units/mark"],
    ["clear", "post", "/unavailability/clear", "/api/equipment-units/unavailability/clear"],
    ["remove one", "delete", "/:id/unavailability/:periodId", "/api/equipment-units/1/unavailability/1"],
    ["label", "patch", "/:id", "/api/equipment-units/1"],
  ];

  it.each(routes)("%s 403s anyone but Technical Support", async (_n, method, _p, url) => {
    useDb(createFakeDb(seed()));
    const res = await (request(app()) as any)[method](url).set("Authorization", COORD).send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only Technical Support can manage equipment units" });
  });

  it.each(routes)("%s 401s without a client or user", async (_n, method, path) => {
    expect(await callRoute(equipmentUnitsRouter, method, path, {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
    expect((await callRoute(equipmentUnitsRouter, method, path, { supabase: {} })).status).toBe(401);
    expect((await callRoute(equipmentUnitsRouter, method, path, { user: { id: "u", role: "technical_support" } })).status).toBe(401);
  });
});

describe("GET /", () => {
  const get = (query: Record<string, string> = {}) => request(app()).get("/api/equipment-units").query(query).set("Authorization", TS);

  it("lists every unit ordered by type then id, with running and future periods only", async () => {
    useDb(createFakeDb(seed({
      equipment_unavailability: [
        period(1, 1, { start_date: "2026-12-05", end_date: "2026-12-06" }),
        period(2, 1, { start_date: "2026-10-01", end_date: "2026-10-27" }), // finished yesterday: history
        period(3, 1, { start_date: "2026-10-20", end_date: "2026-10-28" }), // ends today: still running
        period(4, 1, { start_date: "2026-11-01", end_date: null, reason: "Under Maintenance", note: "n" }),
        period(5, 2, { start_date: "2026-12-01", end_date: "2026-12-02" }),
      ],
    })));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.units.map((u: any) => u.id)).toEqual([4, 1, 2, 3]); // Microphone before Projector
    const projector = res.body.units.find((u: any) => u.id === 1);
    expect(projector.periods).toEqual([
      { id: 3, reason: "Damaged", startDate: "2026-10-20", endDate: "2026-10-28", note: null },
      { id: 4, reason: "Under Maintenance", startDate: "2026-11-01", endDate: null, note: "n" },
      { id: 1, reason: "Damaged", startDate: "2026-12-05", endDate: "2026-12-06", note: null },
    ]);
    expect(res.body.units.find((u: any) => u.id === 2).periods).toHaveLength(1);
    expect(res.body.units.find((u: any) => u.id === 3).periods).toEqual([]);
  });

  it("orders periods that start the same day by id", async () => {
    useDb(createFakeDb(seed({ equipment_unavailability: [period(9, 1), period(7, 1)] })));
    const res = await get();
    expect(res.body.units.find((u: any) => u.id === 1).periods.map((p: any) => p.id)).toEqual([7, 9]);
  });

  it("shows a unit's label, or null", async () => {
    useDb(createFakeDb(seed({ equipment: [unit(1, { label: "Sticker 12" }), unit(2, { label: undefined })] })));
    const res = await get();
    expect(res.body.units.map((u: any) => u.label)).toEqual(["Sticker 12", null]);
  });

  it("limits to one catalog item by name", async () => {
    useDb(createFakeDb(seed()));
    const res = await get({ type: " Microphone " });
    expect(res.body.units.map((u: any) => u.id)).toEqual([4]);
  });

  it("treats a blank type as all units", async () => {
    useDb(createFakeDb(seed()));
    expect((await get({ type: "  " })).body.units).toHaveLength(4);
  });

  it("is empty for a type that isn't in the catalog", async () => {
    useDb(createFakeDb(seed()));
    const res = await get({ type: "Laser" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ units: [] });
  });

  it("500s when the catalog, the units or the periods can't be read", async () => {
    const catalog = useDb(createFakeDb(seed()));
    catalog.failOn("equipment_catalog", "select");
    let res = await get({ type: "Projector" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment units" });

    const units = useDb(createFakeDb(seed()));
    units.failOn("equipment", "select");
    res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment units" });

    const none = useDb(createFakeDb(seed()));
    none.nullOn("equipment", "select");
    expect((await get()).status).toBe(500);

    const periods = useDb(createFakeDb(seed()));
    periods.failOn("equipment_unavailability", "select");
    res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment unavailability" });
  });
});

describe("GET /impact", () => {
  const get = (query: Record<string, string>) => request(app()).get("/api/equipment-units/impact").query(query).set("Authorization", TS);
  const base = { type: "Projector", startDate: "2026-12-01" };

  it("shows each unit's state for the period", async () => {
    eventsReply.events = [ev()];
    useDb(createFakeDb(seed({
      equipment_unavailability: [period(1, 3)],
      equipment_booking: [reserved(1, 2, 8)],
    })));
    const res = await get({ ...base, endDate: "2026-12-02" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "Projector",
      units: [
        { id: 1, label: null, state: "free", reason: null, events: [] },
        { id: 2, label: null, state: "reserved", reason: null, events: [{ eventId: 8, eventName: "Fest", proposedDate: "2026-12-01", startTime: "10:00" }] },
        { id: 3, label: null, state: "unavailable", reason: "Damaged", events: [] },
      ],
      pickable: 2,
      suggested: [],
    });
  });

  it("suggests units for a quantity, free first", async () => {
    eventsReply.events = [ev()];
    useDb(createFakeDb(seed({ equipment_booking: [reserved(1, 1, 8)] })));
    const res = await get({ ...base, quantity: "2" });
    expect(res.body.suggested).toEqual([2, 3]);
    const more = await get({ ...base, quantity: "3" });
    expect(more.body.suggested).toEqual([2, 3, 1]);
  });

  it("treats a blank quantity as none, and a blank end date as open-ended", async () => {
    useDb(createFakeDb(seed({ equipment_unavailability: [period(1, 1, { start_date: "2027-01-01", end_date: null })] })));
    const res = await get({ ...base, quantity: "  ", endDate: "  " });
    expect(res.status).toBe(200);
    expect(res.body.suggested).toEqual([]);
    // Open-ended from 2026-12-01 reaches unit 1's period in 2027.
    expect(res.body.units.find((u: any) => u.id === 1).state).toBe("unavailable");
  });

  it("is empty for a type that isn't in the catalog", async () => {
    useDb(createFakeDb(seed()));
    const res = await get({ ...base, type: "Laser" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "Laser", units: [], pickable: 0, suggested: [] });
  });

  it("400s every invalid field at once", async () => {
    useDb(createFakeDb(seed()));
    const res = await get({ type: " ", startDate: "2026-02-30", endDate: "nope", quantity: "0" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Validation failed",
      fields: {
        type: "Choose an equipment type.",
        startDate: "Enter a valid start date.",
        endDate: "Enter a valid end date.",
        quantity: "Enter a whole number, 1 or more.",
      },
    });
  });

  it("400s a missing or repeated type, a missing start date, an end before the start and a fractional quantity", async () => {
    useDb(createFakeDb(seed()));
    expect((await get({ startDate: "2026-12-01" })).body.fields).toEqual({ type: "Choose an equipment type." });
    const repeated = await request(app()).get("/api/equipment-units/impact?type=a&type=b&startDate=2026-12-01").set("Authorization", TS);
    expect(repeated.body.fields).toEqual({ type: "Choose an equipment type." });
    expect((await get({ type: "P" })).body.fields).toEqual({ startDate: "Enter a valid start date." });
    expect((await get({ ...base, endDate: "2026-11-30" })).body.fields).toEqual({ endDate: "End date can't be before the start date." });
    expect((await get({ ...base, endDate: "2026-12-01" })).status).toBe(200);
    expect((await get({ ...base, quantity: "1.5" })).body.fields).toEqual({ quantity: "Enter a whole number, 1 or more." });
    expect((await get({ ...base, quantity: "abc" })).body.fields).toEqual({ quantity: "Enter a whole number, 1 or more." });
  });

  it("does not compare the end date with a bad start date", async () => {
    useDb(createFakeDb(seed()));
    const res = await get({ type: "P", startDate: "bad", endDate: "2020-01-01" });
    expect(res.body.fields).toEqual({ startDate: "Enter a valid start date." });
  });

  it("500s when the catalog, the units or the reservations can't be read", async () => {
    const catalog = useDb(createFakeDb(seed()));
    catalog.failOn("equipment_catalog", "select");
    let res = await get(base);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment units" });

    const units = useDb(createFakeDb(seed()));
    units.failOn("equipment", "select");
    res = await get(base);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment units" });

    const none = useDb(createFakeDb(seed()));
    none.nullOn("equipment", "select");
    expect((await get(base)).status).toBe(500);

    const bookings = useDb(createFakeDb(seed()));
    bookings.failOn("equipment_booking", "select");
    res = await get(base);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to check the equipment's reservations" });
  });

  it("502s when events-service can't say which events hold the units", async () => {
    eventsReply.ok = false;
    useDb(createFakeDb(seed({ equipment_booking: [reserved(1, 1, 8)] })));
    const res = await get(base);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Couldn't check which events these units are reserved for. Please try again." });
  });
});

describe("POST /mark", () => {
  const post = (body: Record<string, unknown>) => request(app()).post("/api/equipment-units/mark").set("Authorization", TS).send(body);
  const ok = { type: "Projector", unitIds: [1, 2], reason: "Damaged", startDate: "2026-12-01", endDate: "2026-12-03", note: "cracked" };

  it("carries each unit's label and accepts an open-ended period, ignoring duplicate ids", async () => {
    const db = useDb(createFakeDb(seed({ equipment: [unit(1, { label: "S-1" }), unit(2)] })));
    const res = await post({ ...ok, unitIds: [1, "2", 1], endDate: undefined, note: undefined });
    expect(res.status).toBe(201);
    expect(res.body.periods.map((p: any) => p.label)).toEqual(["S-1", null]);
    expect(db.rows("equipment_unavailability").map((r) => [r.end_date, r.note])).toEqual([[null, null], [null, null]]);
  });

  it("tells each affected event's coordinator once, with how many of their units are affected", async () => {
    eventsReply.events = [ev({ id: 8, coordinatorId: "COORD-1" }), ev({ id: 9, name: "Gala", coordinatorId: "COORD-2" })];
    useDb(createFakeDb(seed({ equipment_booking: [reserved(1, 1, 8), reserved(2, 2, 8), reserved(3, 2, 9)] })));
    const res = await post(ok);

    expect(res.status).toBe(201);
    expect(res.body.affectedEvents).toEqual([
      { eventId: 8, eventName: "Fest", units: 2 },
      { eventId: 9, eventName: "Gala", units: 1 },
    ]);
    expect(res.body.notified).toBe(true);
    expect(publisher.published).toEqual([
      {
        type: "equipment.unusable", eventId: 8, actorId: "TS-0001",
        recipients: { userIds: ["COORD-1"], roles: [] },
        data: { eventName: "Fest", equipmentType: "Projector", quantity: 2, reason: "Damaged", startDate: "2026-12-01", endDate: "2026-12-03" },
      },
      expect.objectContaining({ eventId: 9, recipients: { userIds: ["COORD-2"], roles: [] }, data: expect.objectContaining({ quantity: 1 }) }),
    ]);
    expect(arrangementsChanged.map((a) => [a.url, a.body.reason])).toEqual([
      ["http://events.test/api/events/8/arrangements-changed", "2 reserved Projector units are unusable (Damaged)"],
      ["http://events.test/api/events/9/arrangements-changed", "1 reserved Projector unit is unusable (Damaged)"],
    ]);
  });

  it("reports notified false when an event has no coordinator, but still tells events-service", async () => {
    eventsReply.events = [ev({ coordinatorId: null })];
    useDb(createFakeDb(seed({ equipment_booking: [reserved(1, 1, 8)] })));
    const res = await post(ok);
    expect(res.status).toBe(201);
    expect(res.body.notified).toBe(false);
    expect(publisher.published).toHaveLength(0);
    expect(arrangementsChanged).toHaveLength(1);
  });

  it("reports notified false when a notice couldn't be sent", async () => {
    eventsReply.events = [ev(), ev({ id: 9, coordinatorId: "COORD-2" })];
    useDb(createFakeDb(seed({ equipment_booking: [reserved(1, 1, 8), reserved(2, 2, 9)] })));
    let calls = 0;
    setPublisherForTest({ publish: async () => ++calls !== 1 });
    const res = await post(ok);
    expect(res.body.notified).toBe(false);
    expect(calls).toBe(2); // the second one is still tried
  });

  it("keeps the saved periods and says no notices went out when events-service can't be asked", async () => {
    eventsReply.ok = false;
    const db = useDb(createFakeDb(seed({ equipment_booking: [reserved(1, 1, 8)] })));
    const res = await post(ok);
    expect(res.status).toBe(201);
    expect(res.body.affectedEvents).toEqual([]);
    expect(res.body.notified).toBe(false);
    expect(res.body.periods).toHaveLength(2);
    expect(db.rows("equipment_unavailability")).toHaveLength(2);
    expect(publisher.published).toHaveLength(0);
  });

  it("400s a request with no body at all", async () => {
    const db = useDb(createFakeDb(seed()));
    const out = await callRoute(equipmentUnitsRouter, "post", "/mark", { supabase: db, user: { id: "TS-0001", role: "technical_support" }, body: undefined });
    expect(out.status).toBe(400);
    expect((out.body as any).fields).toEqual({
      reason: "Choose one of: Damaged, Under Maintenance.",
      startDate: "Start date is required.",
      type: "Choose an equipment type.",
      unitIds: "Choose at least one unit.",
    });
  });

  it("400s every invalid field at once", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post({ type: " ", unitIds: [], reason: "Lost", startDate: "" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Validation failed",
      fields: {
        reason: "Choose one of: Damaged, Under Maintenance.",
        startDate: "Start date is required.",
        type: "Choose an equipment type.",
        unitIds: "Choose at least one unit.",
      },
    });
    expect(db.writes("equipment_unavailability")).toHaveLength(0);
  });

  it.each([[["a"]], [[0]], [[-1]], [[1.5]], ["1,2"], [undefined]])("400s the unit ids %j", async (unitIds) => {
    useDb(createFakeDb(seed()));
    const res = await post({ ...ok, unitIds });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ unitIds: "Choose at least one unit." });
  });

  it("accepts 500 units and rejects 501", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    useDb(createFakeDb(seed({ equipment: many(501).map((id) => unit(id)) })));
    expect((await post({ ...ok, unitIds: many(500) })).status).toBe(201);
    const res = await post({ ...ok, unitIds: many(501) });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ unitIds: "Choose at most 500 units at a time." });
  });

  it("404s units that don't exist, or belong to another type, or an unknown type", async () => {
    const db = useDb(createFakeDb(seed()));
    for (const body of [{ ...ok, unitIds: [1, 99] }, { ...ok, unitIds: [1, 4] }, { ...ok, type: "Laser" }]) {
      const res = await post(body);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "One or more of those equipment units wasn't found" });
    }
    expect(db.writes("equipment_unavailability")).toHaveLength(0);
  });

  it("409s units already out of use for those dates, naming them, and saves nothing", async () => {
    const db = useDb(createFakeDb(seed({ equipment_unavailability: [period(1, 1)], equipment: [unit(1), unit(2), unit(3, { status: "Damaged" })] })));
    let res = await post({ ...ok, unitIds: [1, 2] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Projector #1 is already out of use for those dates.", unitIds: [1] });

    res = await post({ ...ok, unitIds: [1, 3] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Projector #1, Projector #3 are already out of use for those dates.", unitIds: [1, 3] });
    expect(db.writes("equipment_unavailability")).toHaveLength(0);
  });

  it("500s when the catalog or the units can't be read", async () => {
    const catalog = useDb(createFakeDb(seed()));
    catalog.failOn("equipment_catalog", "select");
    let res = await post(ok);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the equipment units" });

    const units = useDb(createFakeDb(seed()));
    units.failOn("equipment", "select");
    res = await post(ok);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the equipment units" });
  });

  it("treats an empty read of the units as none found", async () => {
    const db = useDb(createFakeDb(seed()));
    db.nullOn("equipment", "select");
    expect((await post(ok)).status).toBe(404);
  });

  it("500s when the reservations can't be checked", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment_booking", "select");
    const res = await post(ok);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to check the equipment's reservations" });
  });

  it("500s when the periods can't be saved, notifying nobody", async () => {
    eventsReply.events = [ev()];
    const db = useDb(createFakeDb(seed({ equipment_booking: [reserved(1, 1, 8)] })));
    db.failOn("equipment_unavailability", "insert");
    let res = await post(ok);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to mark the equipment unusable" });
    expect(publisher.published).toHaveLength(0);

    db.clearFailures();
    db.nullOn("equipment_unavailability", "insert");
    res = await post(ok);
    expect(res.status).toBe(500);
  });
});

describe("POST /unavailability/clear", () => {
  const post = (body: unknown) => request(app()).post("/api/equipment-units/unavailability/clear").set("Authorization", TS).send(body as object);

  it("removes the periods and says how many", async () => {
    const db = useDb(createFakeDb(seed({ equipment_unavailability: [period(1, 1), period(2, 2), period(3, 3)] })));
    const res = await post({ periodIds: [1, "2", 2, 99] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 2 });
    expect(db.rows("equipment_unavailability").map((r) => r.id)).toEqual([3]);
  });

  it.each([[{}], [{ periodIds: [] }], [{ periodIds: "1" }], [{ periodIds: ["x"] }], [{ periodIds: [0] }], [{ periodIds: [-2] }], [{ periodIds: [1.5] }], [null]])(
    "400s %j",
    async (body) => {
      const db = useDb(createFakeDb(seed({ equipment_unavailability: [period(1, 1)] })));
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Validation failed", fields: { periodIds: "Choose at least one period." } });
      expect(db.rows("equipment_unavailability")).toHaveLength(1);
    },
  );

  it("accepts 500 ids and rejects 501", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    useDb(createFakeDb(seed()));
    expect((await post({ periodIds: many(500) })).status).toBe(200);
    expect((await post({ periodIds: many(501) })).status).toBe(400);
  });

  it("500s when the removal fails, and counts nothing for an empty result", async () => {
    const db = useDb(createFakeDb(seed({ equipment_unavailability: [period(1, 1)] })));
    db.failOn("equipment_unavailability", "delete");
    let res = await post({ periodIds: [1] });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to mark the equipment usable again" });

    db.clearFailures();
    db.nullOn("equipment_unavailability", "delete");
    res = await post({ periodIds: [1] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 0 });
  });
});

describe("DELETE /:id/unavailability/:periodId", () => {
  const del = (unit: string, id: string) => request(app()).delete(`/api/equipment-units/${unit}/unavailability/${id}`).set("Authorization", TS);

  it("removes the period when it belongs to the unit", async () => {
    const db = useDb(createFakeDb(seed({ equipment_unavailability: [period(1, 1), period(2, 2)] })));
    const res = await del("1", "1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
    expect(db.rows("equipment_unavailability").map((r) => r.id)).toEqual([2]);
  });

  it("404s a period that belongs to another unit, or doesn't exist, and removes nothing", async () => {
    const db = useDb(createFakeDb(seed({ equipment_unavailability: [period(1, 1)] })));
    for (const [u, p] of [["2", "1"], ["1", "9"]]) {
      const res = await del(u, p);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Unavailability period not found" });
    }
    expect(db.rows("equipment_unavailability")).toHaveLength(1);
  });

  it.each([["0", "1"], ["1", "0"], ["x", "1"], ["1", "x"], ["-1", "1"], ["01", "1"]])("400s the ids %s/%s", async (u, p) => {
    useDb(createFakeDb(seed()));
    const res = await del(u, p);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A valid unit and period id are required" });
  });

  it("500s when the lookup or the removal fails", async () => {
    const lookup = useDb(createFakeDb(seed({ equipment_unavailability: [period(1, 1)] })));
    lookup.failOn("equipment_unavailability", "select");
    let res = await del("1", "1");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the unavailability period" });

    const removal = useDb(createFakeDb(seed({ equipment_unavailability: [period(1, 1)] })));
    removal.failOn("equipment_unavailability", "delete");
    res = await del("1", "1");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to mark the equipment usable again" });
  });
});

describe("PATCH /:id (label)", () => {
  const patch = (id: string, body: unknown) => request(app()).patch(`/api/equipment-units/${id}`).set("Authorization", TS).send(body as object);

  it("sets a trimmed label", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await patch("1", { label: "  Sticker 12 " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unit: { id: 1, label: "Sticker 12" } });
    expect(db.rows("equipment").find((u) => u.id === 1)!.label).toBe("Sticker 12");
  });

  it("clears the label for blank, null or missing", async () => {
    for (const body of [{ label: "   " }, { label: null }, {}]) {
      const db = useDb(createFakeDb(seed({ equipment: [unit(1, { label: "old" })] })));
      const res = await patch("1", body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ unit: { id: 1, label: null } });
      expect(db.rows("equipment")[0].label).toBeNull();
    }
  });

  it("accepts exactly 50 characters and rejects 51", async () => {
    useDb(createFakeDb(seed()));
    expect((await patch("1", { label: "x".repeat(50) })).status).toBe(200);
    const res = await patch("1", { label: "x".repeat(51) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Validation failed", fields: { label: "Use at most 50 characters." } });
  });

  it("400s a label that isn't text", async () => {
    const db = useDb(createFakeDb(seed()));
    for (const label of [5, true, ["a"], {}]) {
      const res = await patch("1", { label });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Validation failed", fields: { label: "Enter text." } });
    }
    expect(db.writes("equipment")).toHaveLength(0);
  });

  it("400s a bad unit id", async () => {
    useDb(createFakeDb(seed()));
    for (const id of ["0", "x", "-1"]) {
      const res = await patch(id, { label: "a" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "A valid unit id is required" });
    }
  });

  it("404s a unit that doesn't exist, 500s when the save fails", async () => {
    useDb(createFakeDb(seed()));
    let res = await patch("99", { label: "a" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Equipment unit not found" });

    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment", "update");
    res = await patch("1", { label: "a" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to save the label" });
  });

  it("works with no body at all", async () => {
    useDb(createFakeDb(seed()));
    const res = await request(app()).patch("/api/equipment-units/1").set("Authorization", TS);
    expect(res.status).toBe(200);
  });
});
