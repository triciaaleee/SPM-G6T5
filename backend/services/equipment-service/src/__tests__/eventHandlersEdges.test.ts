import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEventCancelled, releaseForEvent } from "../lib/eventCancelledHandler.js";
import { handleEventRejected } from "../lib/eventRejectedHandler.js";
import { handleEventRescheduled } from "../lib/eventRescheduledHandler.js";
import type { InboundMessage } from "../lib/rabbitConsumer.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";

const msg = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: "msg-1",
  type: "event.cancelled",
  occurredAt: "2026-10-28T04:00:00.000Z",
  publisher: "events-service",
  actorId: "ORG-1",
  eventId: 7,
  recipients: { userIds: [], roles: [] },
  data: {},
  ...over,
});

const booking = (over: Record<string, unknown> = {}) => ({
  id: 1, equipment_id: 10, event_id: 7, request_item_id: 100, status: "Reserved", window_start_ms: 1, window_end_ms: 2, ...over,
});

let publisher: ReturnType<typeof createFakePublisher>;
const fetchMock = vi.fn();

beforeEach(() => {
  publisher = createFakePublisher();
  setPublisherForTest(publisher);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "internal");
  vi.stubEnv("EVENTS_SERVICE_URL", "http://events.test");
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  setPublisherForTest(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const asDb = (db: FakeDb) => ({ supabase: db as any });

describe("releaseForEvent (event.cancelled / event.rejected)", () => {
  it("does nothing for a message with no event id", async () => {
    const db = createFakeDb();
    await handleEventCancelled(msg({ eventId: null }), asDb(db));
    expect(db.calls).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
    expect(publisher.published).toHaveLength(0);
  });

  it("releases the event and tells Technical Support when it held reservations", async () => {
    const db = createFakeDb({ equipment_booking: [booking()] });
    await handleEventCancelled(msg({ data: { eventName: "Nut Festival" } }), asDb(db));

    expect(db.rpcCalls).toEqual([{ fn: "release_equipment_for_event", args: { p_event_id: 7 } }]);
    expect(publisher.published).toEqual([
      {
        type: "equipment.released",
        eventId: 7,
        actorId: "ORG-1",
        recipients: { userIds: [], roles: ["technical_support"] },
        data: { eventName: "Nut Festival", reason: "event_cancelled" },
      },
    ]);
  });

  it("only looks at this event's Reserved bookings, and asks for one row", async () => {
    const db = createFakeDb({ equipment_booking: [booking({ id: 1, status: "Released" }), booking({ id: 2, event_id: 99 })] });
    await handleEventCancelled(msg(), asDb(db));
    expect(db.calls[0]).toMatchObject({ table: "equipment_booking", op: "select", columns: "id" });
    expect(db.calls[0].filters).toEqual([
      { col: "event_id", kind: "eq", value: 7 },
      { col: "status", kind: "eq", value: "Reserved" },
    ]);
    // Released history and another event's booking do not count, so nobody is notified.
    expect(db.rpcCalls).toHaveLength(1);
    expect(publisher.published).toHaveLength(0);
  });

  it("still releases but does not notify when nothing was reserved", async () => {
    const db = createFakeDb();
    await handleEventCancelled(msg(), asDb(db));
    expect(db.rpcCalls).toHaveLength(1);
    expect(publisher.published).toHaveLength(0);
  });

  it("treats a null result like no reservations", async () => {
    const db = createFakeDb({ equipment_booking: [booking()] });
    db.nullOn("equipment_booking", "select");
    await handleEventCancelled(msg(), asDb(db));
    expect(db.rpcCalls).toHaveLength(1);
    expect(publisher.published).toHaveLength(0);
  });

  it("falls back to 'Event #id' when the name is missing, empty or not text", async () => {
    for (const eventName of [undefined, "", 12, null]) {
      publisher.published.length = 0;
      const db = createFakeDb({ equipment_booking: [booking()] });
      await handleEventCancelled(msg({ data: { eventName } }), asDb(db));
      expect(publisher.published[0].data.eventName).toBe("Event #7");
    }
  });

  it("fails (so the message is dead-lettered) when the bookings can't be read", async () => {
    const db = createFakeDb({ equipment_booking: [booking()] });
    db.failOn("equipment_booking", "select");
    await expect(handleEventCancelled(msg(), asDb(db))).rejects.toMatchObject({ message: "injected failure" });
    expect(db.rpcCalls).toHaveLength(0);
    expect(publisher.published).toHaveLength(0);
  });

  it("fails and does not notify when the release itself fails", async () => {
    const db = createFakeDb({ equipment_booking: [booking()] });
    db.onRpc("release_equipment_for_event", () => ({ data: null, error: { message: "rpc down" } }));
    await expect(handleEventCancelled(msg(), asDb(db))).rejects.toMatchObject({ message: "rpc down" });
    expect(publisher.published).toHaveLength(0);
  });

  it("reports the reason it was given", async () => {
    const db = createFakeDb({ equipment_booking: [booking()] });
    await releaseForEvent(msg(), asDb(db), "event_rejected");
    expect(publisher.published[0].data.reason).toBe("event_rejected");
  });
});

describe("handleEventRejected", () => {
  it("releases the event's reservations and notifies with event_rejected", async () => {
    const db = createFakeDb({ equipment_booking: [booking()] });
    await handleEventRejected(msg({ type: "event.rejected", data: { eventName: "Fest" } }), asDb(db));
    expect(db.rpcCalls).toEqual([{ fn: "release_equipment_for_event", args: { p_event_id: 7 } }]);
    expect(publisher.published[0]).toMatchObject({ type: "equipment.released", data: { eventName: "Fest", reason: "event_rejected" } });
  });

  it("ignores a message with no event id", async () => {
    const db = createFakeDb();
    await handleEventRejected(msg({ eventId: null }), asDb(db));
    expect(db.rpcCalls).toHaveLength(0);
  });
});

describe("handleEventRescheduled", () => {
  const day = (d: string) => Date.parse(`${d}T00:00:00.000Z`);

  it("does nothing for a message with no event id", async () => {
    const db = createFakeDb();
    await handleEventRescheduled(msg({ eventId: null }), asDb(db));
    expect(db.calls).toHaveLength(0);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("moves the window of this event's Reserved bookings only", async () => {
    const db = createFakeDb({
      equipment_booking: [
        booking({ id: 1 }),
        booking({ id: 2, status: "Released" }),
        booking({ id: 3, event_id: 99 }),
      ],
    });
    await handleEventRescheduled(msg({ data: { proposedDate: "2026-12-01", startTime: "09:00", endTime: "11:00" } }), asDb(db));

    const rows = db.rows("equipment_booking");
    expect(rows[0]).toMatchObject({ window_start_ms: day("2026-12-01") + 9 * 3_600_000, window_end_ms: day("2026-12-01") + 11 * 3_600_000 });
    expect(rows[1]).toMatchObject({ window_start_ms: 1, window_end_ms: 2 });
    expect(rows[2]).toMatchObject({ window_start_ms: 1, window_end_ms: 2 });
  });

  it("occupies the whole day when the event has a date but no times", async () => {
    const db = createFakeDb({ equipment_booking: [booking()] });
    await handleEventRescheduled(msg({ data: { proposedDate: "2026-12-01" } }), asDb(db));
    expect(db.rows("equipment_booking")[0]).toMatchObject({ window_start_ms: day("2026-12-01"), window_end_ms: day("2026-12-02") });
  });

  it("fails when the window can't be saved, and checks no clashes", async () => {
    const db = createFakeDb({ equipment_booking: [booking()] });
    db.failOn("equipment_booking", "update");
    await expect(handleEventRescheduled(msg({ data: { proposedDate: "2026-12-01" } }), asDb(db))).rejects.toMatchObject({ message: "injected failure" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("fails when the clash check can't run", async () => {
    const db = createFakeDb();
    db.onRpc("equipment_reschedule_clashes", () => ({ data: null, error: { message: "rpc down" } }));
    await expect(handleEventRescheduled(msg(), asDb(db))).rejects.toMatchObject({ message: "rpc down" });
    expect(publisher.published).toHaveLength(0);
  });

  it("asks about this event's clashes and reports nothing when there are none", async () => {
    const db = createFakeDb();
    db.onRpc("equipment_reschedule_clashes", () => ({ data: [], error: null }));
    await handleEventRescheduled(msg(), asDb(db));
    expect(db.rpcCalls).toEqual([{ fn: "equipment_reschedule_clashes", args: { p_event_id: 7 } }]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publisher.published).toHaveLength(0);
  });

  it("treats a null clash result as none", async () => {
    const db = createFakeDb();
    await handleEventRescheduled(msg(), asDb(db));
    expect(publisher.published).toHaveLength(0);
  });

  const clashes = (...unitIds: number[]) => ({ data: unitIds.map((unit_id) => ({ item_id: 1, unit_id, kind: "booking" })), error: null });

  it("reports a single clashing unit to events-service and notifies the coordinator and Technical Support", async () => {
    const db = createFakeDb();
    db.onRpc("equipment_reschedule_clashes", () => clashes(10));
    await handleEventRescheduled(msg({ data: { eventName: "Fest", coordinatorId: "COORD-1" } }), asDb(db));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://events.test/api/events/7/arrangements-changed");
    expect(JSON.parse(init.body)).toEqual({ reason: "1 reserved unit now clashes after the event was rescheduled" });
    expect(publisher.published).toEqual([
      {
        messageId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        type: "equipment.reservation_clash",
        eventId: 7,
        actorId: "ORG-1",
        recipients: { userIds: ["COORD-1"], roles: ["technical_support"] },
        data: { eventName: "Fest", coordinatorId: "COORD-1", units: 1 },
      },
    ]);
  });

  it("counts distinct units, pluralises, and falls back when the name and coordinator are missing", async () => {
    const db = createFakeDb();
    db.onRpc("equipment_reschedule_clashes", () => clashes(10, 10, 11));
    await handleEventRescheduled(msg(), asDb(db));

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reason).toBe("2 reserved units now clash after the event was rescheduled");
    expect(publisher.published[0]).toMatchObject({
      recipients: { userIds: [], roles: ["technical_support"] },
      data: { eventName: "Event #7", coordinatorId: null, units: 2 },
    });
  });

  it("gives a redelivery of the same message the same message id, and another message another", async () => {
    const db = createFakeDb();
    db.onRpc("equipment_reschedule_clashes", () => clashes(10));
    await handleEventRescheduled(msg({ messageId: "same" }), asDb(db));
    await handleEventRescheduled(msg({ messageId: "same" }), asDb(db));
    await handleEventRescheduled(msg({ messageId: "other" }), asDb(db));
    const ids = publisher.published.map((p) => p.messageId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("still notifies when events-service can't be told", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const db = createFakeDb();
    db.onRpc("equipment_reschedule_clashes", () => clashes(10));
    await handleEventRescheduled(msg(), asDb(db));
    expect(publisher.published).toHaveLength(1);
  });
});
