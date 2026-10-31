/**
 * Edge cases that pin down behaviour mutation testing showed the other suites
 * left unchecked (library code: handlers, reservation flags, impact ordering,
 * validators, the users client).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEventRescheduled } from "../lib/eventRescheduledHandler.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";
import { computeReservationFlags } from "../lib/reservationFlags.js";
import { suggestUnits, type ImpactUnit } from "../lib/unitImpact.js";
import { fetchUserNames } from "../lib/usersClient.js";
import { isRealDate } from "../lib/validateUnavailability.js";
import { createFakeDb } from "./helpers/fakeDb.js";

const HOUR = 3_600_000;
const day = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
const win = (startH: number, endH: number) => ({ startMs: day("2026-12-01") + startH * HOUR, endMs: day("2026-12-01") + endH * HOUR });
const booking = (over: Record<string, unknown>) => ({ id: 1, equipment_id: 10, event_id: 7, request_item_id: 100, status: "Reserved", ...over });
const NO_FLAG = { flagged: false, reason: null };

afterEach(() => {
  setPublisherForTest(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("event.rescheduled clash notice", () => {
  it("derives its message id from the inbound message id and the notice type, so a redelivery is one notice", async () => {
    const publisher = createFakePublisher();
    setPublisherForTest(publisher);
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubEnv("INTERNAL_SERVICE_SECRET", "internal");
    const db = createFakeDb();
    db.onRpc("equipment_reschedule_clashes", () => ({ data: [{ item_id: 1, unit_id: 10, kind: "booking" }], error: null }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handleEventRescheduled(
      { messageId: "msg-1", type: "event.rescheduled", occurredAt: "", publisher: "events-service", actorId: null, eventId: 7, recipients: { userIds: [], roles: [] }, data: {} },
      { supabase: db as any },
    );

    // sha256("msg-1:equipment.reservation_clash"), laid out as a UUID.
    expect(publisher.published[0].messageId).toBe("1eccac0f-6103-cdb5-3429-0ff046da55f3");
  });
});

describe("computeReservationFlags", () => {
  const items = new Map([[100, 7]]);
  const known = new Map([[7, win(10, 12)], [8, win(11, 13)]]);
  const withBoth = () => createFakeDb({ equipment_booking: [booking({}), booking({ id: 2, event_id: 8, request_item_id: 200 })] });

  it("asks nothing more once it finds the item holds no reservations", async () => {
    const db = createFakeDb();
    await computeReservationFlags(db, items, known, "t");
    expect(db.calls).toHaveLength(1);
  });

  it("gives up, flagging nothing, when reading the item's own bookings errors, even if rows came back with it", async () => {
    const db = withBoth();
    db.mapOn("equipment_booking", "select", (r) => ({ data: r.data, error: { message: "boom" } }));
    expect((await computeReservationFlags(db, items, known, "t")).get(100)).toEqual(NO_FLAG);
    expect(db.calls).toHaveLength(1);
  });

  it("gives up, flagging nothing, when reading the other claims errors, even if rows came back with it", async () => {
    const db = withBoth();
    let reads = 0;
    db.mapOn("equipment_booking", "select", (r) => (++reads === 2 ? { data: r.data, error: { message: "boom" } } : r));
    expect((await computeReservationFlags(db, items, known, "t")).get(100)).toEqual(NO_FLAG);
  });

  it("never treats a row of the same request item as a rival, whatever event it names", async () => {
    const db = createFakeDb({ equipment_booking: [booking({}), booking({ id: 2, event_id: 8, request_item_id: 100 })] });
    expect((await computeReservationFlags(db, items, known, "t")).get(100)).toEqual(NO_FLAG);
  });
});

describe("suggestUnits ordering", () => {
  const unit = (id: number, events: { eventId: number; proposedDate: string | null; startTime: string | null }[]): ImpactUnit => ({
    id, label: null, state: "reserved", reason: null, events: events.map((e) => ({ ...e, eventName: "x", coordinatorId: null })),
  });
  const ev = (eventId: number, proposedDate: string, startTime: string | null = "09:00") => ({ eventId, proposedDate, startTime });

  it("judges a unit by its soonest event whichever way round the units are compared", async () => {
    const many = unit(1, [ev(1, "2026-12-30"), ev(2, "2026-12-02")]); // soonest Dec 2
    const one = unit(2, [ev(3, "2026-12-10")]);
    expect(suggestUnits([many, one], 2)).toEqual([2, 1]);
    expect(suggestUnits([one, many], 2)).toEqual([2, 1]);
    // And on the other side of the comparison.
    const manyLate = unit(1, [ev(1, "2026-12-02"), ev(2, "2026-12-30")]);
    expect(suggestUnits([manyLate, one], 2)).toEqual([2, 1]);
    expect(suggestUnits([one, manyLate], 2)).toEqual([2, 1]);
  });

  it("treats a missing start time as 00:00, so it ties with an event at 00:00 and falls back to the id", () => {
    const noTime = unit(5, [ev(1, "2026-12-01", null)]);
    const midnight = unit(4, [ev(2, "2026-12-01", "00:00")]);
    expect(suggestUnits([noTime, midnight], 2)).toEqual([4, 5]);
    expect(suggestUnits([midnight, noTime], 2)).toEqual([4, 5]);
  });

  it("puts the unit whose event is further away first, whatever the order they arrive in", () => {
    const soon = unit(1, [ev(1, "2026-12-01")]);
    const later = unit(2, [ev(2, "2026-12-09")]);
    expect(suggestUnits([soon, later], 2)).toEqual([2, 1]);
    expect(suggestUnits([later, soon], 2)).toEqual([2, 1]);
  });
});

describe("fetchUserNames", () => {
  it("ignores the body of a failed response", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, json: async () => ({ users: [{ id: "C1", name: "Ann" }] }) }));
    expect((await fetchUserNames(["C1"], "t")).size).toBe(0);
  });
});

describe("isRealDate", () => {
  it("rejects text before the date, and years below 100 (JavaScript maps those to 19xx)", () => {
    expect(isRealDate("x2026-01-01")).toBe(false);
    expect(isRealDate("12026-01-01")).toBe(false);
    expect(isRealDate("0050-01-01")).toBe(false);
    expect(isRealDate("0099-12-31")).toBe(false);
    expect(isRealDate("2026-01-01")).toBe(true);
  });
});
