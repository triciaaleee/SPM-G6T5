import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/supabaseAdmin.js", async () => ({ supabaseAdmin: (await import("./helpers/mockDb.js")).supabaseAdminProxy }));

import { equipmentAvailabilityRouter } from "../routes/equipmentAvailability.js";
import { appWith, bearer, callRoute } from "./helpers/app.js";
import { createFakeDb } from "./helpers/fakeDb.js";
import { useDb } from "./helpers/mockDb.js";

const TS = bearer("TS-0001", "technical_support");
const app = () => appWith("/api/equipment-availability", equipmentAvailabilityRouter);
const fetchMock = vi.fn();
let events: Record<string, unknown>[];
let eventsOk: boolean;

const ev = (id: number, startTime = "10:00", endTime = "12:00", over: Record<string, unknown> = {}) => ({
  id, name: `E${id}`, proposedDate: "2026-12-01", startTime, endTime, ...over,
});
const unit = (id: number, over: Record<string, unknown> = {}) => ({ id, status: "Available", equipment_catalog_id: 1, ...over });
const booking = (id: number, equipment_id: number, event_id: number) => ({ id, equipment_id, event_id, status: "Reserved", window_start_ms: null, window_end_ms: null });
const seed = (extra: Record<string, any[]> = {}) => ({
  equipment_catalog: [{ id: 1, name: "Projector" }],
  equipment: [unit(1), unit(2), unit(3), unit(4, { status: "Damaged" })],
  ...extra,
});
const get = (query: Record<string, string>) => request(app()).get("/api/equipment-availability").query(query).set("Authorization", TS);
const q = { eventId: "7", type: "Projector", quantity: "2" };

beforeEach(() => {
  events = [ev(7)];
  eventsOk = true;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const ids = new URL(url).searchParams.get("ids")!.split(",").map(Number);
    return { ok: eventsOk, status: eventsOk ? 200 : 500, json: async () => ({ events: events.filter((e) => ids.includes(e.id as number)) }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("EVENTS_SERVICE_URL", "http://events.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /", () => {
  it("counts the usable units free for the event", async () => {
    useDb(createFakeDb(seed()));
    const res = await get(q);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      event: { id: 7, name: "E7" },
      type: "Projector",
      requestedQuantity: 2,
      totalUnits: 4,
      unusableCount: 1,
      reservedElsewhereCount: 0,
      availableCount: 3,
      shortfall: 0,
    });
  });

  it("forwards the caller's token when asking events-service", async () => {
    useDb(createFakeDb(seed()));
    await get(q);
    expect(fetchMock).toHaveBeenCalledWith("http://events.test/api/events/venue-booking-info?ids=7", { headers: { Authorization: TS } });
  });

  it("takes out units out of use during the event, and units another event holds then", async () => {
    events = [ev(7), ev(8, "11:00", "13:00")];
    useDb(createFakeDb(seed({
      equipment_unavailability: [{ id: 1, equipment_id: 1, reason: "Damaged", start_date: "2026-12-01", end_date: "2026-12-01", note: null }],
      equipment_booking: [booking(1, 2, 8)],
    })));
    const res = await get({ ...q, quantity: "3" });
    expect(res.body).toMatchObject({ totalUnits: 4, unusableCount: 2, reservedElsewhereCount: 1, availableCount: 1, shortfall: 2 });
  });

  it("does not count a booking at another time, or this event's own", async () => {
    events = [ev(7), ev(8, "14:00", "16:00")];
    useDb(createFakeDb(seed({ equipment_booking: [booking(1, 1, 8), booking(2, 2, 7)] })));
    const res = await get(q);
    expect(res.body).toMatchObject({ reservedElsewhereCount: 0, availableCount: 3 });
  });

  it("has no shortfall when exactly enough are free, and one more is a shortfall of one", async () => {
    useDb(createFakeDb(seed()));
    expect((await get({ ...q, quantity: "3" })).body).toMatchObject({ availableCount: 3, shortfall: 0 });
    expect((await get({ ...q, quantity: "4" })).body).toMatchObject({ availableCount: 3, shortfall: 1 });
  });

  it("is zero for a type that isn't in the catalog", async () => {
    useDb(createFakeDb(seed()));
    const res = await get({ ...q, type: "Laser" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "Laser", totalUnits: 0, unusableCount: 0, availableCount: 0, shortfall: 2 });
  });

  it("403s anyone but Technical Support", async () => {
    useDb(createFakeDb(seed()));
    const res = await request(app()).get("/api/equipment-availability").query(q).set("Authorization", bearer("C-1", "coordinator"));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only Technical Support can check equipment availability" });
  });

  it("401s without a client or user", async () => {
    expect(await callRoute(equipmentAvailabilityRouter, "get", "/", {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
    expect((await callRoute(equipmentAvailabilityRouter, "get", "/", { supabase: {} })).status).toBe(401);
    expect((await callRoute(equipmentAvailabilityRouter, "get", "/", { user: { id: "u", role: "technical_support" } })).status).toBe(401);
  });

  it("400s an invalid query", async () => {
    useDb(createFakeDb(seed()));
    const res = await get({ eventId: "0", type: "", quantity: "-1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
    expect(Object.keys(res.body.fields).sort()).toEqual(["eventId", "quantity", "type"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("502s when events-service can't be asked", async () => {
    eventsOk = false;
    useDb(createFakeDb(seed()));
    const res = await get(q);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });
  });

  it("404s an event events-service doesn't return", async () => {
    events = [];
    useDb(createFakeDb(seed()));
    const res = await get(q);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });
  });

  it("409s an event with no date yet", async () => {
    events = [ev(7, "10:00", "12:00", { proposedDate: null })];
    useDb(createFakeDb(seed()));
    const res = await get(q);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This event has no date or time set yet, so availability can't be checked." });
  });

  it("500s when the catalog can't be read", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment_catalog", "select");
    const res = await get(q);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the equipment catalog" });
  });

  it("500s when the units can't be read", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment", "select");
    const res = await get(q);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment" });
  });

  it("500s when the unavailability periods can't be read", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment_unavailability", "select");
    const res = await get(q);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment unavailability" });
  });

  it("500s when the bookings can't be read", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment_booking", "select");
    const res = await get(q);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment bookings" });
  });
});
