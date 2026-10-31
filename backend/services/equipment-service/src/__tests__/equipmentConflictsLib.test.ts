import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimUnits, fetchUnitsByCatalogId, unitsBlocked } from "../lib/equipmentConflicts.js";
import { createFakeDb } from "./helpers/fakeDb.js";

const fetchMock = vi.fn();
const HOUR = 3_600_000;
const day = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
const target = { startMs: day("2026-12-01") + 10 * HOUR, endMs: day("2026-12-01") + 12 * HOUR };

/** events-service answers the venue-booking-info batch with these events. */
function eventsAre(events: Record<string, unknown>[]) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ events }) });
}
const event = (id: number, startTime: string, endTime: string, proposedDate = "2026-12-01") => ({ id, name: `E${id}`, proposedDate, startTime, endTime });
const booking = (over: Record<string, unknown> = {}) => ({
  id: 1, equipment_id: 10, event_id: 8, request_item_id: 100, status: "Reserved", window_start_ms: null, window_end_ms: null, ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("EVENTS_SERVICE_URL", "http://events.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchUnitsByCatalogId", () => {
  it("returns every unit of the item, whatever its condition, and no other item's", async () => {
    const db = createFakeDb({
      equipment: [
        { id: 1, status: "Available", equipment_catalog_id: 5 },
        { id: 2, status: "Damaged", equipment_catalog_id: 5 },
        { id: 3, status: "Available", equipment_catalog_id: 6 },
      ],
    });
    expect(await fetchUnitsByCatalogId(db, 5)).toEqual([{ id: 1, status: "Available" }, { id: 2, status: "Damaged" }]);
    expect(db.calls[0].columns).toBe("id, status");
  });

  it("is empty for a null result and throws when the table can't be read", async () => {
    const db = createFakeDb();
    db.nullOn("equipment", "select");
    expect(await fetchUnitsByCatalogId(db, 5)).toEqual([]);

    const failing = createFakeDb();
    failing.failOn("equipment", "select");
    await expect(fetchUnitsByCatalogId(failing, 5)).rejects.toThrow("Failed to load equipment");
  });
});

describe("unitsBlocked", () => {
  const check = (db: ReturnType<typeof createFakeDb>, ids: number[], opts: { own?: boolean; refresh?: boolean } = {}) =>
    unitsBlocked(db, ids, target, "Bearer t", { eventId: 7, treatOwnEventClaimsAsBlocking: !!opts.own, refreshStoredWindows: opts.refresh });

  it("blocks nothing, and asks nothing, for no units", async () => {
    const db = createFakeDb();
    expect((await check(db, [])).size).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it("throws when the bookings can't be read", async () => {
    const db = createFakeDb();
    db.failOn("equipment_booking", "select");
    await expect(check(db, [10])).rejects.toThrow("Failed to load equipment bookings");
  });

  it("blocks nothing for a null result, without calling events-service", async () => {
    const db = createFakeDb();
    db.nullOn("equipment_booking", "select");
    expect((await check(db, [10])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a unit held by another event at an overlapping time", async () => {
    eventsAre([event(8, "11:00", "13:00")]);
    const db = createFakeDb({ equipment_booking: [booking()] });
    expect([...(await check(db, [10]))]).toEqual([10]);
    expect(fetchMock.mock.calls[0][0]).toBe("http://events.test/api/events/venue-booking-info?ids=8");
  });

  it("does not block a unit held by another event at a different time", async () => {
    eventsAre([event(8, "14:00", "16:00")]);
    const db = createFakeDb({ equipment_booking: [booking()] });
    expect((await check(db, [10])).size).toBe(0);
  });

  it("does not block when the other event only touches the window", async () => {
    eventsAre([event(8, "12:00", "14:00")]);
    const db = createFakeDb({ equipment_booking: [booking()] });
    expect((await check(db, [10])).size).toBe(0);
  });

  it("only considers Reserved bookings of the units asked about", async () => {
    eventsAre([event(8, "11:00", "13:00")]);
    const db = createFakeDb({
      equipment_booking: [booking({ id: 1, status: "Released" }), booking({ id: 2, equipment_id: 11 })],
    });
    expect((await check(db, [10])).size).toBe(0);
  });

  it("blocks a unit whose other event can't be resolved (conservative)", async () => {
    eventsAre([]);
    const db = createFakeDb({ equipment_booking: [booking()] });
    expect([...(await check(db, [10]))]).toEqual([10]);
  });

  it("blocks a unit when the other event has no usable date", async () => {
    eventsAre([{ id: 8, name: "E8", proposedDate: null, startTime: null, endTime: null }]);
    const db = createFakeDb({ equipment_booking: [booking()] });
    expect([...(await check(db, [10]))]).toEqual([10]);
  });

  it("blocks every booked unit when events-service can't be reached", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const db = createFakeDb({ equipment_booking: [booking({ id: 1, equipment_id: 10 }), booking({ id: 2, equipment_id: 11, event_id: 9 })] });
    expect([...(await check(db, [10, 11]))].sort()).toEqual([10, 11]);
  });

  it("leaves this event's own booking out when only checking availability", async () => {
    const db = createFakeDb({ equipment_booking: [booking({ event_id: 7 })] });
    expect((await check(db, [10], { own: false })).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.calls[0].filters.some((f) => f.kind === "neq" && f.col === "event_id" && f.value === 7)).toBe(true);
  });

  it("counts this event's own booking as blocking when claiming", async () => {
    const db = createFakeDb({ equipment_booking: [booking({ event_id: 7 })] });
    expect([...(await check(db, [10], { own: true }))]).toEqual([10]);
    // Its own event needs no lookup.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.calls[0].filters.some((f) => f.kind === "neq")).toBe(false);
  });

  it("looks each other event up once, in one call", async () => {
    eventsAre([event(8, "14:00", "15:00"), event(9, "14:00", "15:00")]);
    const db = createFakeDb({
      equipment_booking: [booking({ id: 1, event_id: 8 }), booking({ id: 2, event_id: 8, equipment_id: 11 }), booking({ id: 3, event_id: 9, equipment_id: 12 }), booking({ id: 4, event_id: 7, equipment_id: 13 })],
    });
    await check(db, [10, 11, 12, 13], { own: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://events.test/api/events/venue-booking-info?ids=8,9");
  });

  it("reports a unit once even when several bookings hold it", async () => {
    eventsAre([event(8, "11:00", "13:00"), event(9, "11:30", "12:30")]);
    const db = createFakeDb({ equipment_booking: [booking({ id: 1, event_id: 8 }), booking({ id: 2, event_id: 9 })] });
    expect([...(await check(db, [10]))]).toEqual([10]);
  });

  it("blocks a unit held by another event even when this event also holds a different unit", async () => {
    eventsAre([event(8, "14:00", "15:00")]);
    const db = createFakeDb({ equipment_booking: [booking({ id: 1, equipment_id: 10, event_id: 7 }), booking({ id: 2, equipment_id: 11, event_id: 8 })] });
    expect([...(await check(db, [10, 11], { own: true }))]).toEqual([10]);
  });

  describe("refreshing stored windows (claims only)", () => {
    const stale = { window_start_ms: 1, window_end_ms: 2 };
    const current = { window_start_ms: day("2026-12-01") + 14 * HOUR, window_end_ms: day("2026-12-01") + 16 * HOUR };

    it("writes the other event's current window onto its Reserved bookings", async () => {
      eventsAre([event(8, "14:00", "16:00")]);
      const db = createFakeDb({
        equipment_booking: [booking({ id: 1, ...stale }), booking({ id: 2, equipment_id: 11, ...stale }), booking({ id: 3, status: "Released", ...stale }), booking({ id: 4, event_id: 9, equipment_id: 12, ...stale })],
      });
      await check(db, [10, 11, 12], { refresh: true });
      const rows = db.rows("equipment_booking");
      expect(rows[0]).toMatchObject(current);
      expect(rows[1]).toMatchObject(current);
      expect(rows[2]).toMatchObject(stale); // history keeps its window
      expect(rows[3]).toMatchObject(stale); // event 9 could not be resolved, so nothing is guessed
    });

    it("writes once per event, not once per booking", async () => {
      eventsAre([event(8, "14:00", "16:00")]);
      const db = createFakeDb({ equipment_booking: [booking({ id: 1, ...stale }), booking({ id: 2, equipment_id: 11, ...stale })] });
      await check(db, [10, 11], { refresh: true });
      expect(db.writes("equipment_booking")).toHaveLength(1);
    });

    it("does not write a window that is already right", async () => {
      eventsAre([event(8, "14:00", "16:00")]);
      const db = createFakeDb({ equipment_booking: [booking(current)] });
      await check(db, [10], { refresh: true });
      expect(db.writes("equipment_booking")).toHaveLength(0);
    });

    it("rewrites when only one end of the stored window is wrong", async () => {
      eventsAre([event(8, "14:00", "16:00")]);
      const onlyStartOff = createFakeDb({ equipment_booking: [booking({ ...current, window_start_ms: 5 })] });
      await check(onlyStartOff, [10], { refresh: true });
      expect(onlyStartOff.rows("equipment_booking")[0]).toMatchObject(current);

      const onlyEndOff = createFakeDb({ equipment_booking: [booking({ ...current, window_end_ms: 5 })] });
      await check(onlyEndOff, [10], { refresh: true });
      expect(onlyEndOff.rows("equipment_booking")[0]).toMatchObject(current);
    });

    it("never rewrites this event's own booking", async () => {
      const db = createFakeDb({ equipment_booking: [booking({ event_id: 7, ...stale })] });
      await check(db, [10], { refresh: true, own: true });
      expect(db.writes("equipment_booking")).toHaveLength(0);
    });

    it("does not refresh unless asked to", async () => {
      eventsAre([event(8, "14:00", "16:00")]);
      const db = createFakeDb({ equipment_booking: [booking(stale)] });
      await check(db, [10]);
      expect(db.writes("equipment_booking")).toHaveLength(0);
    });

    it("still answers when the refresh write fails", async () => {
      eventsAre([event(8, "11:00", "13:00")]);
      const db = createFakeDb({ equipment_booking: [booking(stale)] });
      db.failOn("equipment_booking", "update");
      expect([...(await check(db, [10], { refresh: true }))]).toEqual([10]);
    });
  });
});

describe("claimUnits", () => {
  const catalog = { equipment: [
    { id: 1, status: "Available", equipment_catalog_id: 5 },
    { id: 2, status: "Available", equipment_catalog_id: 5 },
    { id: 3, status: "Available", equipment_catalog_id: 5 },
    { id: 4, status: "Damaged", equipment_catalog_id: 5 },
    { id: 5, status: "Under Maintenance", equipment_catalog_id: 5 },
    { id: 9, status: "Available", equipment_catalog_id: 6 },
  ] };

  it("claims the first free units up to the quantity", async () => {
    const db = createFakeDb(catalog);
    expect(await claimUnits(db, 5, 2, 7, target, "t")).toEqual({ claimedIds: [1, 2], availableCount: 3, shortfall: 0 });
  });

  it("reports a shortfall when there aren't enough", async () => {
    const db = createFakeDb(catalog);
    expect(await claimUnits(db, 5, 5, 7, target, "t")).toEqual({ claimedIds: [1, 2, 3], availableCount: 3, shortfall: 2 });
  });

  it("has no shortfall when exactly enough are free", async () => {
    const db = createFakeDb(catalog);
    expect(await claimUnits(db, 5, 3, 7, target, "t")).toMatchObject({ claimedIds: [1, 2, 3], shortfall: 0 });
  });

  it("skips units out of use during the event, and ones another event holds then", async () => {
    eventsAre([event(8, "11:00", "13:00")]);
    const db = createFakeDb({
      ...catalog,
      equipment_unavailability: [{ id: 1, equipment_id: 1, reason: "Damaged", start_date: "2026-12-01", end_date: "2026-12-01", note: null }],
      equipment_booking: [booking({ equipment_id: 2 })],
    });
    expect(await claimUnits(db, 5, 3, 7, target, "t")).toEqual({ claimedIds: [3], availableCount: 1, shortfall: 2 });
  });

  it("does not hand a unit this event already holds to a second claim", async () => {
    const db = createFakeDb({ ...catalog, equipment_booking: [booking({ equipment_id: 1, event_id: 7 })] });
    expect((await claimUnits(db, 5, 3, 7, target, "t")).claimedIds).toEqual([2, 3]);
  });

  it("skips units another item of the same call has provisionally claimed", async () => {
    const db = createFakeDb(catalog);
    expect(await claimUnits(db, 5, 2, 7, target, "t", new Set([1, 3]))).toEqual({ claimedIds: [2], availableCount: 1, shortfall: 1 });
  });

  it("refreshes the stored windows of other events while claiming", async () => {
    eventsAre([event(8, "14:00", "16:00")]);
    const db = createFakeDb({ ...catalog, equipment_booking: [booking({ equipment_id: 1, window_start_ms: 1, window_end_ms: 2 })] });
    await claimUnits(db, 5, 1, 7, target, "t");
    expect(db.rows("equipment_booking")[0].window_start_ms).toBe(day("2026-12-01") + 14 * HOUR);
  });

  it("claims nothing for an item with no units", async () => {
    const db = createFakeDb(catalog);
    expect(await claimUnits(db, 77, 2, 7, target, "t")).toEqual({ claimedIds: [], availableCount: 0, shortfall: 2 });
  });

  it("propagates a database failure", async () => {
    const db = createFakeDb(catalog);
    db.failOn("equipment", "select");
    await expect(claimUnits(db, 5, 1, 7, target, "t")).rejects.toThrow("Failed to load equipment");
  });
});
