import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeReservationFlags } from "../lib/reservationFlags.js";
import { createFakeDb } from "./helpers/fakeDb.js";

const fetchMock = vi.fn();
const HOUR = 3_600_000;
const day = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
const win = (startH: number, endH: number, d = "2026-12-01") => ({ startMs: day(d) + startH * HOUR, endMs: day(d) + endH * HOUR });
const event = (id: number, startTime: string, endTime: string) => ({ id, name: `E${id}`, proposedDate: "2026-12-01", startTime, endTime });
const eventsAre = (events: unknown[]) => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ events }) });
const b = (over: Record<string, unknown>) => ({ id: 1, equipment_id: 10, event_id: 7, request_item_id: 100, status: "Reserved", ...over });
const NO_FLAG = { flagged: false, reason: null };
const CONFLICT = "This event's schedule now conflicts with another event's claim on the same reserved equipment unit.";

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("EVENTS_SERVICE_URL", "http://events.test");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const items = (...pairs: [number, number][]) => new Map<number, number>(pairs);

describe("computeReservationFlags", () => {
  it("is empty for no items, and asks nothing", async () => {
    const db = createFakeDb();
    expect((await computeReservationFlags(db, new Map(), new Map(), "t")).size).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  it("starts every item unflagged, and stays so with no reservations", async () => {
    const db = createFakeDb();
    const flags = await computeReservationFlags(db, items([100, 7], [101, 7]), new Map(), "t");
    expect([...flags]).toEqual([[100, NO_FLAG], [101, NO_FLAG]]);
  });

  it("leaves items unflagged when the item's own bookings can't be read", async () => {
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    db.failOn("equipment_booking", "select");
    const flags = await computeReservationFlags(db, items([100, 7]), new Map(), "t");
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  it("leaves items unflagged when the other claims on those units can't be read", async () => {
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    db.failOn("equipment_booking", "select", -1, (c) => c.columns === "equipment_id, event_id, request_item_id");
    eventsAre([event(8, "11:00", "13:00")]);
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  it("treats an empty read of the item's own bookings as no reservations", async () => {
    const db = createFakeDb({ equipment_booking: [b({})] });
    db.nullOn("equipment_booking", "select");
    const flags = await computeReservationFlags(db, items([100, 7]), new Map(), "t");
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  it("treats an empty read of the other claims as no rivals", async () => {
    const db = createFakeDb({ equipment_booking: [b({})] });
    db.nullOn("equipment_booking", "select", -1, (c) => c.columns === "equipment_id, event_id, request_item_id");
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  it("flags an item whose event now overlaps another event's claim on the same unit", async () => {
    eventsAre([event(8, "11:00", "13:00")]);
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "Bearer t");
    expect(flags.get(100)).toEqual({ flagged: true, reason: CONFLICT });
    expect(fetchMock.mock.calls[0][0]).toBe("http://events.test/api/events/venue-booking-info?ids=8");
  });

  it("does not flag when the other event is at a different time", async () => {
    eventsAre([event(8, "14:00", "16:00")]);
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  it("does not flag when the other event only touches", async () => {
    eventsAre([event(8, "12:00", "14:00")]);
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  it("ignores other units, Released claims, the item's own row and the same event's other items", async () => {
    eventsAre([event(8, "11:00", "13:00")]);
    const db = createFakeDb({
      equipment_booking: [
        b({}),
        b({ id: 2, equipment_id: 99, event_id: 8, request_item_id: 200 }), // a different unit
        b({ id: 3, event_id: 8, request_item_id: 201, status: "Released" }), // history
        b({ id: 4, event_id: 7, request_item_id: 101 }), // same event, another item of it
      ],
    });
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  it("uses windows the caller already has, and fetches only the missing ones", async () => {
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 }), b({ id: 3, event_id: 9, request_item_id: 300 })] });
    eventsAre([event(9, "14:00", "15:00")]);
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)], [8, win(11, 13)]]), "t");
    expect(fetchMock.mock.calls[0][0]).toBe("http://events.test/api/events/venue-booking-info?ids=9");
    expect(flags.get(100)?.flagged).toBe(true);
  });

  it("does not call events-service when every window is known", async () => {
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)], [8, win(14, 16)]]), "t");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  it("flags conservatively when a rival's window can't be resolved", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
    expect(flags.get(100)).toEqual({ flagged: true, reason: CONFLICT });
  });

  it("skips a rival event that has no usable date, treating it as a conflict", async () => {
    eventsAre([{ id: 8, name: "E8", proposedDate: null, startTime: null, endTime: null }]);
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
    expect(flags.get(100)?.flagged).toBe(true);
  });

  it("cannot judge an item whose own event has no known window", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    const flags = await computeReservationFlags(db, items([100, 7]), new Map(), "t");
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  it("skips a booking whose item isn't one being evaluated", async () => {
    // The unit rows come back with the id as text, so it can't be matched to the caller's numeric key.
    const db = createFakeDb({ equipment_booking: [b({ request_item_id: "100" }), b({ id: 2, event_id: 8, request_item_id: 200 })] });
    const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)], [8, win(11, 13)]]), "t");
    expect(flags.get(100)).toEqual(NO_FLAG);
  });

  describe("periods marked by Technical Support (E5-5)", () => {
    const period = (over: Record<string, unknown> = {}) => ({ id: 1, equipment_id: 10, reason: "Damaged", start_date: "2026-12-01", end_date: "2026-12-01", note: null, ...over });

    it("flags a reserved unit that is out of use during the event", async () => {
      const db = createFakeDb({ equipment_booking: [b({})], equipment_unavailability: [period()] });
      const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
      expect(flags.get(100)).toEqual({ flagged: true, reason: "A reserved unit is unavailable (Damaged) during this event, so it needs a replacement." });
    });

    it("names the reason, and prefers it over a schedule conflict", async () => {
      const db = createFakeDb({
        equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })],
        equipment_unavailability: [period({ reason: "Under Maintenance" })],
      });
      const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)], [8, win(11, 13)]]), "t");
      expect(flags.get(100)?.reason).toContain("(Under Maintenance)");
    });

    it("ignores a period on another day, or on another unit", async () => {
      const db = createFakeDb({
        equipment_booking: [b({})],
        equipment_unavailability: [period({ start_date: "2026-12-02", end_date: "2026-12-03" }), period({ id: 2, equipment_id: 11 })],
      });
      const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
      expect(flags.get(100)).toEqual(NO_FLAG);
    });

    it("flags each of several units on its own period", async () => {
      const db = createFakeDb({
        equipment_booking: [b({}), b({ id: 2, equipment_id: 11, request_item_id: 101 })],
        equipment_unavailability: [period({ id: 1, equipment_id: 10 }), period({ id: 2, equipment_id: 10, reason: "Under Maintenance", start_date: "2026-11-30" }), period({ id: 3, equipment_id: 11, reason: "Under Maintenance" })],
      });
      const flags = await computeReservationFlags(db, items([100, 7], [101, 7]), new Map([[7, win(10, 12)]]), "t");
      expect(flags.get(100)?.reason).toContain("(Damaged)");
      expect(flags.get(101)?.reason).toContain("(Under Maintenance)");
    });

    it("carries on with conflicts when the periods can't be read", async () => {
      eventsAre([event(8, "11:00", "13:00")]);
      const db = createFakeDb({ equipment_booking: [b({}), b({ id: 2, event_id: 8, request_item_id: 200 })], equipment_unavailability: [period()] });
      db.failOn("equipment_unavailability", "select");
      const flags = await computeReservationFlags(db, items([100, 7]), new Map([[7, win(10, 12)]]), "t");
      expect(flags.get(100)).toEqual({ flagged: true, reason: CONFLICT });
    });
  });

  it("evaluates several items independently", async () => {
    const db = createFakeDb({
      equipment_booking: [b({}), b({ id: 2, equipment_id: 11, request_item_id: 101, event_id: 7 }), b({ id: 3, event_id: 8, request_item_id: 200 })],
    });
    const flags = await computeReservationFlags(db, items([100, 7], [101, 7]), new Map([[7, win(10, 12)], [8, win(11, 13)]]), "t");
    expect(flags.get(100)?.flagged).toBe(true);
    expect(flags.get(101)).toEqual(NO_FLAG);
  });
});
