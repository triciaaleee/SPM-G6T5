import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

const ev = vi.hoisted(() => ({ fetchEvent: vi.fn() }));
vi.mock("../lib/eventsClient.js", async (orig) => ({ ...(await orig<typeof import("../lib/eventsClient.js")>()), ...ev }));
const rec = vi.hoisted(() => ({ reconcileBufferOverlapsSafely: vi.fn() }));
vi.mock("../lib/bufferOverlapReview.js", async (orig) => ({ ...(await orig<typeof import("../lib/bufferOverlapReview.js")>()), ...rec }));

import { withdrawBooking, type WithdrawalAction } from "../lib/bookingWithdrawal.js";
import { releaseBookingsForCancelledEvent } from "../lib/eventCancellation.js";
import { handleEventCancelled } from "../lib/eventCancelledHandler.js";

const NOW = new Date("2026-09-14T08:00:00.000Z");
let db: FakeDb;
let published: any[];
let publishOk: boolean;

const bk = (id: number, o: Record<string, unknown> = {}) => ({
  id, venue_id: 1, event_id: 7, status: "Requested", hold_expires_at: null, decision_reason: null, decided_by: null, decided_at: null, ...o,
});
const venue = (id = 1, o: Record<string, unknown> = {}) => ({ id, name: `Hall ${id}`, location: "North", staff_id: `VEN-000${id}`, ...o });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  published = [];
  publishOk = true;
  setPublisherForTest({ publish: async (m) => { published.push(m); return publishOk; } });
  ev.fetchEvent.mockReset().mockResolvedValue({ status: "ok", event: { id: 7, coordinator_id: "COORD-1", submitted_details: { name: "Gala" } } });
  rec.reconcileBufferOverlapsSafely.mockReset().mockResolvedValue(undefined);
  db = createFakeDb({ venues: [venue()], venue_bookings: [bk(1)] });
});
afterEach(() => vi.useRealTimers());

const run = (action: WithdrawalAction, o: Record<string, unknown> = {}, id = 1) =>
  withdrawBooking(db as never, { bookingId: id, action, coordinatorId: "COORD-1", authorization: "Bearer t", ...o });
const row = (id: number) => db.rows("venue_bookings").find((r) => r.id === id)!;
const setStatus = (status: string, extra: Record<string, unknown> = {}) => Object.assign(row(1), { status, ...extra });

describe("withdrawBooking: who and what", () => {
  it("error when the booking lookup fails; not_found when absent", async () => {
    db.failOn("venue_bookings", "select");
    expect(await run("withdraw")).toEqual({ status: "error" });
    db.clearFailures();
    expect(await run("withdraw", {}, 99)).toEqual({ status: "not_found" });
  });
  it("maps the events-service answers: not_found, error, and someone else's event", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "not_found" });
    expect(await run("withdraw")).toEqual({ status: "not_found" });
    ev.fetchEvent.mockResolvedValue({ status: "error" });
    expect(await run("withdraw")).toEqual({ status: "event_error" });
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: { id: 7, coordinator_id: "COORD-2" } });
    expect(await run("withdraw")).toEqual({ status: "not_owner" });
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: { id: 7, coordinator_id: null } });
    expect(await run("withdraw")).toEqual({ status: "not_owner" });
    expect(row(1).status).toBe("Requested");
    expect(ev.fetchEvent).toHaveBeenCalledWith(7, "Bearer t");
  });

  const MATRIX: Record<string, Record<WithdrawalAction, string | null>> = {
    Requested: { withdraw: null, release: "This booking isn't Approved yet — withdraw the request instead of releasing it." },
    "On Hold": { withdraw: null, release: "This booking isn't Approved yet — withdraw the request instead of releasing it." },
    Approved: { withdraw: "This booking is already Approved — release it instead of withdrawing the request.", release: null },
    "Replacement Required": { withdraw: "A Replacement Required booking cannot be withdrawn.", release: null },
    Rejected: { withdraw: "A Rejected booking cannot be withdrawn.", release: "A Rejected booking cannot be released." },
    Expired: { withdraw: "A Expired booking cannot be withdrawn.", release: "A Expired booking cannot be released." },
    Withdrawn: { withdraw: "A Withdrawn booking cannot be withdrawn.", release: "A Withdrawn booking cannot be released." },
    Cancelled: { withdraw: "A Cancelled booking cannot be withdrawn.", release: "A Cancelled booking cannot be released." },
  };
  for (const [status, actions] of Object.entries(MATRIX)) {
    for (const action of ["withdraw", "release"] as const) {
      const message = actions[action];
      it(`${action} a ${status} booking → ${message ? "blocked" : "allowed"}`, async () => {
        setStatus(status, { hold_expires_at: status === "On Hold" ? "2099-01-01T00:00:00Z" : null });
        const r = await run(action);
        if (message) {
          expect(r).toEqual({ status: "blocked", message });
          expect(row(1).status).toBe(status);
          expect(published).toEqual([]);
        } else {
          expect(r.status).toBe("ok");
          expect(row(1)).toMatchObject({ status: "Withdrawn", hold_expires_at: null, decided_by: "COORD-1", decided_at: NOW.toISOString() });
        }
      });
    }
  }
});

describe("withdrawBooking: the write", () => {
  it("error when the update fails; blocked when another change got there first (guarded by current status)", async () => {
    db.failOn("venue_bookings", "update");
    expect(await run("withdraw")).toEqual({ status: "error" });
    db.clearFailures();
    db.failOn("venue_bookings", "update", 1, () => { row(1).status = "Approved"; return false; });
    expect(await run("withdraw")).toEqual({ status: "blocked", message: "This booking was changed by someone else — reload and try again." });
    expect(row(1).status).toBe("Approved");
    expect(published).toEqual([]);
    expect(db.calls.find((c) => c.op === "update")!.filters).toContainEqual({ col: "status", kind: "eq", value: "Requested" });
  });
  it("error when the venue cannot be read, after the write has landed", async () => {
    db.failOn("venues", "select");
    expect(await run("withdraw")).toEqual({ status: "error" });
    db.clearFailures();
    db.rows("venues").length = 0;
    setStatus("Requested");
    expect(await run("withdraw")).toEqual({ status: "error" });
  });
  it("returns the updated booking and the venue's public fields, and tells the venue's staff why", async () => {
    setStatus("Approved");
    const r = await run("release");
    expect(r).toMatchObject({ status: "ok", staffNotified: true, venue: { id: 1, name: "Hall 1", location: "North" } });
    expect((r as any).venue).not.toHaveProperty("staff_id");
    expect((r as any).booking).toMatchObject({ id: 1, status: "Withdrawn" });
    expect(published).toEqual([
      { type: "booking.withdrawn", eventId: 7, actorId: "COORD-1", recipients: { userIds: ["VEN-0001"], roles: [] }, data: { bookingId: 1, venueName: "Hall 1", eventName: "Gala", reason: "coordinator_released" } },
    ]);
    expect(rec.reconcileBufferOverlapsSafely).toHaveBeenCalledWith(db, 1, "Bearer t", { venueName: "Hall 1", venueStaffId: "VEN-0001" });
  });
  it("withdrawing a request gives the coordinator_withdrew reason", async () => {
    await run("withdraw");
    expect(published[0].data.reason).toBe("coordinator_withdrew");
  });
  it("falls back to 'Event #id' when the event has no usable name", async () => {
    for (const details of [{}, { name: "" }, { name: 5 }, null]) {
      published.length = 0;
      setStatus("Requested");
      ev.fetchEvent.mockResolvedValue({ status: "ok", event: { id: 7, coordinator_id: "COORD-1", submitted_details: details } });
      await run("withdraw");
      expect(published[0].data.eventName).toBe("Event #7");
    }
  });
  it("a venue with nobody assigned sends no message (staffNotified false) but still withdraws and reconciles", async () => {
    db.rows("venues")[0].staff_id = null;
    const r = await run("withdraw");
    expect(r).toMatchObject({ status: "ok", staffNotified: false });
    expect(published).toEqual([]);
    expect(rec.reconcileBufferOverlapsSafely).toHaveBeenCalledWith(db, 1, "Bearer t", { venueName: "Hall 1", venueStaffId: null });
  });
  it("a failed broker reports staffNotified false without undoing the withdrawal", async () => {
    publishOk = false;
    expect(await run("withdraw")).toMatchObject({ status: "ok", staffNotified: false });
    expect(row(1).status).toBe("Withdrawn");
  });
  it("leaves the event's other bookings alone", async () => {
    db.tables.venue_bookings.push(bk(2, { venue_id: 2 }));
    await run("withdraw");
    expect(row(2).status).toBe("Requested");
  });
});

describe("releaseBookingsForCancelledEvent", () => {
  beforeEach(() => {
    db = createFakeDb({
      venues: [venue(1), venue(2), venue(3, { staff_id: null })],
      venue_bookings: [
        bk(1, { status: "Requested", venue_id: 1 }), bk(2, { status: "On Hold", venue_id: 1, hold_expires_at: "2099-01-01T00:00:00Z" }),
        bk(3, { status: "Approved", venue_id: 2 }), bk(4, { status: "Replacement Required", venue_id: 3 }),
        bk(5, { status: "Rejected", venue_id: 1 }), bk(6, { status: "Expired", venue_id: 1 }), bk(7, { status: "Withdrawn", venue_id: 1 }), bk(8, { status: "Cancelled", venue_id: 1 }),
        bk(9, { status: "Approved", venue_id: 1, event_id: 8 }),
      ],
    });
  });

  it("withdraws every active booking of the event and no others, recording who and when", async () => {
    expect(await releaseBookingsForCancelledEvent(db as never, 7, "ORG-1", "Gala")).toEqual({ released: 4 });
    expect([1, 2, 3, 4].map((i) => row(i).status)).toEqual(["Withdrawn", "Withdrawn", "Withdrawn", "Withdrawn"]);
    expect(row(2)).toMatchObject({ hold_expires_at: null, decided_by: "ORG-1", decided_at: NOW.toISOString() });
    expect([5, 6, 7, 8].map((i) => row(i).status)).toEqual(["Rejected", "Expired", "Withdrawn", "Cancelled"]);
    expect(row(9).status).toBe("Approved"); // another event
    expect(row(5).decided_by).toBeNull();
  });
  it("tells each venue's staff once per booking, skipping unstaffed venues", async () => {
    await releaseBookingsForCancelledEvent(db as never, 7, "ORG-1", "Gala");
    expect(published.map((m) => [m.data.bookingId, m.recipients.userIds[0], m.data.venueName])).toEqual([[1, "VEN-0001", "Hall 1"], [2, "VEN-0001", "Hall 1"], [3, "VEN-0002", "Hall 2"]]);
    expect(published[0]).toEqual({ type: "booking.withdrawn", eventId: 7, actorId: "ORG-1", recipients: { userIds: ["VEN-0001"], roles: [] }, data: { bookingId: 1, venueName: "Hall 1", eventName: "Gala", reason: "event_cancelled" } });
  });
  it("reconciles each distinct venue once, with its name and staff", async () => {
    await releaseBookingsForCancelledEvent(db as never, 7, "ORG-1", "Gala");
    expect(rec.reconcileBufferOverlapsSafely.mock.calls.map((c) => [c[1], c[2], c[3]])).toEqual([
      [1, null, { venueName: "Hall 1", venueStaffId: "VEN-0001" }],
      [2, null, { venueName: "Hall 2", venueStaffId: "VEN-0002" }],
      [3, null, { venueName: "Hall 3", venueStaffId: null }],
    ]);
  });
  it("is idempotent: a second delivery releases nothing and notifies no-one", async () => {
    await releaseBookingsForCancelledEvent(db as never, 7, "ORG-1", "Gala");
    published.length = 0;
    rec.reconcileBufferOverlapsSafely.mockClear();
    expect(await releaseBookingsForCancelledEvent(db as never, 7, "ORG-1", "Gala")).toEqual({ released: 0 });
    expect(published).toEqual([]);
    expect(rec.reconcileBufferOverlapsSafely).not.toHaveBeenCalled();
  });
  it("a null actor is recorded as no decider", async () => {
    await releaseBookingsForCancelledEvent(db as never, 7, null, "Gala");
    expect(row(1).decided_by).toBeNull();
    expect(published[0].actorId).toBeNull();
  });
  it("throws (so the message is retried/dead-lettered) when either lookup fails", async () => {
    db.failOn("venue_bookings", "update");
    await expect(releaseBookingsForCancelledEvent(db as never, 7, "ORG-1", "Gala")).rejects.toMatchObject({ message: "injected failure" });
    db.clearFailures();
    db.failOn("venues", "select");
    await expect(releaseBookingsForCancelledEvent(db as never, 7, "ORG-1", "Gala")).rejects.toMatchObject({ message: "injected failure" });
  });
  it("still releases when a venue row is missing (no message for it)", async () => {
    db.rows("venues").splice(0, 3);
    expect(await releaseBookingsForCancelledEvent(db as never, 7, "ORG-1", "Gala")).toEqual({ released: 4 });
    expect(published).toEqual([]);
  });
});

describe("handleEventCancelled", () => {
  const msg = (o: Record<string, unknown>) => ({ messageId: "m", type: "event.cancelled", occurredAt: "x", publisher: "events-service", actorId: "ORG-1", recipients: { userIds: [], roles: [] }, data: {}, eventId: 7, ...o }) as never;
  beforeEach(() => { db = createFakeDb({ venues: [venue()], venue_bookings: [bk(1)] }); });

  it("ignores a message with no event id", async () => {
    await handleEventCancelled(msg({ eventId: null }), { supabase: db as never });
    expect(db.calls).toHaveLength(0);
  });
  it("releases the event's bookings, naming the event from the message or by id", async () => {
    await handleEventCancelled(msg({ data: { eventName: "Gala" } }), { supabase: db as never });
    expect(published[0].data.eventName).toBe("Gala");
    for (const data of [{}, { eventName: "" }, { eventName: 3 }]) {
      published.length = 0;
      db.rows("venue_bookings")[0].status = "Requested";
      await handleEventCancelled(msg({ data }), { supabase: db as never });
      expect(published[0].data.eventName).toBe("Event #7");
    }
  });
});
