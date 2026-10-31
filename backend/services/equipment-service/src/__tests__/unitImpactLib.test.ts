import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { impactForUnits, suggestUnits, type ImpactUnit, type UnitRecord } from "../lib/unitImpact.js";
import { createFakeDb } from "./helpers/fakeDb.js";

const fetchMock = vi.fn();
const day = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
const period = { startMs: day("2026-12-01"), endMs: day("2026-12-02") };
const eventsAre = (events: unknown[]) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ events }) });
const ev = (over: Record<string, unknown>) => ({ id: 8, name: "Fest", proposedDate: "2026-12-01", startTime: "10:00", endTime: "12:00", coordinatorId: "C1", ...over });
const unit = (id: number, over: Partial<UnitRecord> = {}): UnitRecord => ({ id, type: "Projector", status: "Available", label: `P${id}`, ...over });
const reserved = (id: number, equipment_id: number, event_id: number, status = "Reserved") => ({ id, equipment_id, event_id, status });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("EVENTS_SERVICE_URL", "http://events.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("impactForUnits", () => {
  it("is empty for no units and asks nothing", async () => {
    const db = createFakeDb();
    expect(await impactForUnits(db, "t", [], period)).toEqual({ units: [], eventsOk: true });
    expect(db.calls).toHaveLength(0);
  });

  it("marks a unit with nothing in the period free, without calling events-service", async () => {
    const db = createFakeDb();
    expect(await impactForUnits(db, "t", [unit(1)], period)).toEqual({
      eventsOk: true,
      units: [{ id: 1, label: "P1", state: "free", reason: null, events: [] }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a unit whose status is not Available as unavailable for that status", async () => {
    const db = createFakeDb();
    const out = await impactForUnits(db, "t", [unit(1, { status: "Damaged" }), unit(2, { status: "Under Maintenance", label: null })], period);
    expect(out.units).toEqual([
      { id: 1, label: "P1", state: "unavailable", reason: "Damaged", events: [] },
      { id: 2, label: null, state: "unavailable", reason: "Under Maintenance", events: [] },
    ]);
  });

  it("marks a unit with an overlapping period as unavailable for that period's reason", async () => {
    const db = createFakeDb({
      equipment_unavailability: [{ id: 1, equipment_id: 1, reason: "Under Maintenance", start_date: "2026-12-01", end_date: null, note: null }],
    });
    const out = await impactForUnits(db, "t", [unit(1), unit(2)], period);
    expect(out.units[0]).toMatchObject({ state: "unavailable", reason: "Under Maintenance" });
    expect(out.units[1]).toMatchObject({ state: "free" });
  });

  it("lists the events holding a unit, with their details", async () => {
    eventsAre([ev({})]);
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8)] });
    const out = await impactForUnits(db, "Bearer t", [unit(1)], period);
    expect(out.units[0]).toEqual({
      id: 1,
      label: "P1",
      state: "reserved",
      reason: null,
      events: [{ eventId: 8, eventName: "Fest", proposedDate: "2026-12-01", startTime: "10:00", coordinatorId: "C1" }],
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("http://events.test/api/events/venue-booking-info?ids=8", { headers: { Authorization: "Bearer t" } });
  });

  it("only counts Reserved bookings of the units asked about", async () => {
    eventsAre([ev({})]);
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8, "Released"), reserved(2, 99, 8)] });
    expect((await impactForUnits(db, "t", [unit(1)], period)).units[0].state).toBe("free");
  });

  it("falls back to 'Event #id' and a null coordinator", async () => {
    eventsAre([ev({ name: null, coordinatorId: undefined }), ev({ id: 9, name: "", coordinatorId: null })]);
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8), reserved(2, 2, 9)] });
    const out = await impactForUnits(db, "t", [unit(1), unit(2)], period);
    expect(out.units[0].events[0]).toMatchObject({ eventName: "Event #8", coordinatorId: null });
    expect(out.units[1].events[0]).toMatchObject({ eventName: "Event #9", coordinatorId: null });
  });

  it("lists an event once per unit even when it holds the unit through several items", async () => {
    eventsAre([ev({})]);
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8), reserved(2, 1, 8)] });
    expect((await impactForUnits(db, "t", [unit(1)], period)).units[0].events).toHaveLength(1);
  });

  it("lists several events on one unit", async () => {
    eventsAre([ev({}), ev({ id: 9, startTime: "14:00", endTime: "16:00" })]);
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8), reserved(2, 1, 9)] });
    expect((await impactForUnits(db, "t", [unit(1)], period)).units[0].events.map((e) => e.eventId)).toEqual([8, 9]);
  });

  it("ignores an event that is already over", async () => {
    // The suite's clock is 2026-10-28.
    eventsAre([ev({ proposedDate: "2026-10-01" })]);
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8)] });
    const past = { startMs: day("2026-10-01"), endMs: day("2026-10-02") };
    expect((await impactForUnits(db, "t", [unit(1)], past)).units[0].state).toBe("free");
  });

  it("keeps an event that ends exactly now", async () => {
    vi.setSystemTime(new Date("2026-12-01T12:00:00.000Z"));
    eventsAre([ev({})]);
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8)] });
    expect((await impactForUnits(db, "t", [unit(1)], period)).units[0].state).toBe("reserved");
    vi.setSystemTime(new Date("2026-12-01T12:00:00.001Z"));
    expect((await impactForUnits(db, "t", [unit(1)], period)).units[0].state).toBe("free");
  });

  it("ignores an event that does not touch the period", async () => {
    eventsAre([ev({ proposedDate: "2026-12-05" })]);
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8)] });
    expect((await impactForUnits(db, "t", [unit(1)], period)).units[0].state).toBe("free");
  });

  it("ignores an event with no usable date, and one events-service didn't return", async () => {
    eventsAre([ev({ proposedDate: null, startTime: null, endTime: null })]);
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8), reserved(2, 2, 9)] });
    const out = await impactForUnits(db, "t", [unit(1), unit(2)], period);
    expect(out.units.map((u) => u.state)).toEqual(["free", "free"]);
    expect(out.eventsOk).toBe(true);
  });

  it("reports eventsOk false, with the unit shown as free, when events-service can't be asked", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const db = createFakeDb({ equipment_booking: [reserved(1, 1, 8)] });
    expect(await impactForUnits(db, "t", [unit(1)], period)).toEqual({
      eventsOk: false,
      units: [{ id: 1, label: "P1", state: "free", reason: null, events: [] }],
    });
  });

  it("treats a null bookings result as none", async () => {
    const db = createFakeDb();
    db.nullOn("equipment_booking", "select");
    expect((await impactForUnits(db, "t", [unit(1)], period)).units[0].state).toBe("free");
  });

  it("throws when the bookings or the periods can't be read", async () => {
    const bookings = createFakeDb();
    bookings.failOn("equipment_booking", "select");
    await expect(impactForUnits(bookings, "t", [unit(1)], period)).rejects.toThrow("Failed to load equipment bookings");

    const periods = createFakeDb();
    periods.failOn("equipment_unavailability", "select");
    await expect(impactForUnits(periods, "t", [unit(1)], period)).rejects.toThrow("Failed to load equipment unavailability");
  });
});

describe("suggestUnits", () => {
  const u = (id: number, state: ImpactUnit["state"], events: { eventId: number; proposedDate: string | null; startTime: string | null }[] = []): ImpactUnit => ({
    id, label: null, state, reason: null,
    events: events.map((e) => ({ ...e, eventName: "x", coordinatorId: null })),
  });

  it("prefers free units, in id order, and never suggests unavailable ones", () => {
    expect(suggestUnits([u(3, "free"), u(1, "free"), u(2, "unavailable"), u(4, "reserved", [{ eventId: 1, proposedDate: "2026-12-01", startTime: "09:00" }])], 2)).toEqual([1, 3]);
  });

  it("falls back to reserved units, those whose soonest event is furthest away first", () => {
    const units = [
      u(1, "reserved", [{ eventId: 1, proposedDate: "2026-12-01", startTime: "09:00" }]),
      u(2, "reserved", [{ eventId: 2, proposedDate: "2026-12-20", startTime: "09:00" }]),
      u(3, "reserved", [{ eventId: 3, proposedDate: "2026-12-10", startTime: "09:00" }]),
    ];
    expect(suggestUnits(units, 3)).toEqual([2, 3, 1]);
  });

  it("judges a unit by its soonest event", () => {
    const units = [
      u(1, "reserved", [{ eventId: 1, proposedDate: "2026-12-30", startTime: "09:00" }, { eventId: 2, proposedDate: "2026-12-02", startTime: "09:00" }]),
      u(2, "reserved", [{ eventId: 3, proposedDate: "2026-12-10", startTime: "09:00" }]),
    ];
    expect(suggestUnits(units, 2)).toEqual([2, 1]);
  });

  it("breaks a tie, and compares times within a day, by id then time", () => {
    const same = { eventId: 1, proposedDate: "2026-12-01", startTime: "09:00" };
    expect(suggestUnits([u(5, "reserved", [same]), u(4, "reserved", [same])], 2)).toEqual([4, 5]);
    expect(suggestUnits([
      u(1, "reserved", [{ eventId: 1, proposedDate: "2026-12-01", startTime: "08:00" }]),
      u(2, "reserved", [{ eventId: 2, proposedDate: "2026-12-01", startTime: "18:00" }]),
    ], 2)).toEqual([2, 1]);
  });

  it("sorts an unknown date last in time, so it is suggested first among reserved units", () => {
    const units = [
      u(1, "reserved", [{ eventId: 1, proposedDate: "2026-12-01", startTime: "09:00" }]),
      u(2, "reserved", [{ eventId: 2, proposedDate: null, startTime: null }]),
    ];
    expect(suggestUnits(units, 2)).toEqual([2, 1]);
  });

  it("treats a missing start time as midnight", () => {
    const units = [
      u(1, "reserved", [{ eventId: 1, proposedDate: "2026-12-01", startTime: null }]),
      u(2, "reserved", [{ eventId: 2, proposedDate: "2026-12-01", startTime: "00:01" }]),
    ];
    expect(suggestUnits(units, 2)).toEqual([2, 1]);
  });

  it("returns fewer than asked when there aren't enough, and none for zero", () => {
    expect(suggestUnits([u(1, "free")], 5)).toEqual([1]);
    expect(suggestUnits([u(1, "free")], 0)).toEqual([]);
    expect(suggestUnits([], 3)).toEqual([]);
  });
});
