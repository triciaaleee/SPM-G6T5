import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

const ev = vi.hoisted(() => ({ fetchVenueBookingInfo: vi.fn(), fetchVenueBookingInfoInternal: vi.fn() }));
vi.mock("../lib/eventsClient.js", async (orig) => ({ ...(await orig<typeof import("../lib/eventsClient.js")>()), ...ev }));
const rec = vi.hoisted(() => ({ reconcileBufferOverlapsSafely: vi.fn() }));
vi.mock("../lib/bufferOverlapReview.js", async (orig) => ({ ...(await orig<typeof import("../lib/bufferOverlapReview.js")>()), ...rec }));

import {
  AUTO_REJECT_REASON,
  blockingWindows,
  decideBooking,
  expireLapsedHolds,
  sweepExpiringHolds,
  yieldsTo,
  type Decision,
} from "../lib/bookingDecisions.js";

const NOW = new Date("2026-09-14T08:00:00.000Z");
const H = 3600_000;
const AUTH = "Bearer coordinator-token";
const STAFF = "VEN-0001";

const evt = (id: number, o: Record<string, unknown> = {}) => ({
  id, name: `Event ${id}`, status: "Planning", coordinatorId: `COORD-${id}`, proposedDate: "2026-09-20", startTime: "10:00", endTime: "12:00", expectedAttendance: 50, ...o,
});
const bk = (id: number, o: Record<string, unknown> = {}) => ({
  id, venue_id: 1, event_id: 100 + id, status: "Requested", hold_expires_at: null, decision_reason: null, decided_by: null, decided_at: null, ...o,
});
const venueRow = (o: Record<string, unknown> = {}) => ({ id: 1, name: "Grand Hall", location: "North", staff_id: STAFF, setup_minutes: 30, turnaround_minutes: 30, ...o });

let db: FakeDb;
let events: Record<number, any>;
let published: any[];
let publishOk: boolean;

function world(bookings: any[], opts: { venues?: any[]; extra?: Record<string, any[]>; events?: any[] } = {}) {
  db = createFakeDb({ venues: opts.venues ?? [venueRow()], venue_bookings: bookings, ...opts.extra });
  events = {};
  for (const b of bookings) events[b.event_id] = evt(b.event_id);
  for (const e of opts.events ?? []) events[e.id] = e;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  published = [];
  publishOk = true;
  setPublisherForTest({ publish: async (m) => { published.push(m); return publishOk; } });
  ev.fetchVenueBookingInfo.mockReset().mockImplementation(async (ids: number[]) => ({ status: "ok", events: ids.map((i) => events[i]).filter(Boolean) }));
  ev.fetchVenueBookingInfoInternal.mockReset().mockImplementation(async (ids: number[]) => ({ status: "ok", events: ids.map((i) => events[i]).filter(Boolean) }));
  rec.reconcileBufferOverlapsSafely.mockReset().mockResolvedValue(undefined);
  world([bk(1)]);
});
afterEach(() => vi.useRealTimers());

const decide = (decision: Decision, o: Record<string, unknown> = {}, id = 1) =>
  decideBooking(db as never, { bookingId: id, decision, staffId: STAFF, authorization: AUTH, reason: "Not suitable", ...o });
const row = (id: number) => db.rows("venue_bookings").find((r) => r.id === id)!;

describe("decideBooking: preconditions", () => {
  it("error when the booking lookup fails; not_found when there is none", async () => {
    db.failOn("venue_bookings", "select");
    expect(await decide("Approved")).toEqual({ status: "error" });
    db.clearFailures();
    expect(await decide("Approved", {}, 99)).toEqual({ status: "not_found" });
  });
  it("error when the assignment check fails; not_assigned for someone else's venue", async () => {
    db.failOn("venues", "select", 1);
    expect(await decide("Approved")).toEqual({ status: "error" });
    expect(await decide("Approved", { staffId: "VEN-0002" })).toEqual({ status: "not_assigned" });
    expect(row(1).status).toBe("Requested");
  });
  it("error / not_found when the venue row cannot be read or is gone", async () => {
    db.failOn("venues", "select", -1, (c) => c.filters.some((f) => f.col === "staff_id") === false);
    expect(await decide("Approved")).toEqual({ status: "error" });
    db.clearFailures();
    // venue row vanishes between assignment check and load: assignment query sees it, load does not
    const real = db.from;
    let venueReads = 0;
    db.from = ((t: string) => {
      if (t === "venues" && ++venueReads === 2) { const q = real("venues"); return { ...q, select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }; }
      return real(t);
    }) as never;
    expect(await decide("Approved")).toEqual({ status: "not_found" });
  });
  it.each([
    ["Approved", "Rejected", "A Approved booking cannot be rejected"],
    ["Rejected", "Approved", "A Rejected booking cannot be moved to Approved"],
    ["Expired", "On Hold", "A Expired booking cannot be moved to On Hold"],
    ["Withdrawn", "Rejected", "A Withdrawn booking cannot be rejected"],
    ["Approved", "On Hold", "A Approved booking cannot be moved to On Hold"],
    ["Replacement Required", "Approved", "A Replacement Required booking cannot be moved to Approved"],
    ["Cancelled", "Approved", "A Cancelled booking cannot be moved to Approved"],
    ["On Hold", "On Hold", "A On Hold booking cannot be moved to On Hold"],
  ] as const)("a %s booking cannot be %s → blocked with the exact message", async (from, to, message) => {
    world([bk(1, { status: from, hold_expires_at: from === "On Hold" ? "2099-01-01T00:00:00Z" : null })]);
    expect(await decide(to)).toEqual({ status: "blocked", message });
    expect(row(1).status).toBe(from);
    expect(published).toEqual([]);
  });
});

describe("decideBooking: lapsed holds", () => {
  it("a hold past its deadline is swept to Expired, the coordinator told, and the decision refused", async () => {
    world([bk(1, { status: "On Hold", hold_expires_at: "2026-09-14T07:59:59.999Z" })]);
    const r = await decide("Approved");
    expect(r).toEqual({ status: "blocked", message: "This hold has expired, so it can no longer be decided" });
    expect(row(1)).toMatchObject({ status: "Expired", decided_by: null, decided_at: NOW.toISOString() });
    expect(published).toEqual([
      { type: "hold.expired", eventId: 101, actorId: null, recipients: { userIds: ["COORD-101"], roles: [] }, data: { eventName: "Event 101", venueName: "Grand Hall" } },
    ]);
    expect(rec.reconcileBufferOverlapsSafely).toHaveBeenCalledWith(db, 1, AUTH);
  });
  it("a hold expiring at exactly this instant is already lapsed; one millisecond later is still live", async () => {
    world([bk(1, { status: "On Hold", hold_expires_at: NOW.toISOString() })]);
    expect((await decide("Approved")).status).toBe("blocked");
    expect(row(1).status).toBe("Expired");
    world([bk(1, { status: "On Hold", hold_expires_at: "2026-09-14T08:00:00.001Z" })]);
    expect((await decide("Approved")).status).toBe("ok");
  });
  it("an On Hold row with no expiry is never swept", async () => {
    world([bk(1, { status: "On Hold" })]);
    expect((await decide("Approved")).status).toBe("ok");
  });
  it("rejecting a lapsed hold is also refused (expired holds have no actions)", async () => {
    world([bk(1, { status: "On Hold", hold_expires_at: "2026-09-13T00:00:00Z" })]);
    expect(await decide("Rejected")).toEqual({ status: "blocked", message: "This hold has expired, so it can no longer be decided" });
  });
  it("the sweep still reports the hold as expired when its write failed, and notifies no-one", async () => {
    world([bk(1, { status: "On Hold", hold_expires_at: "2026-09-13T00:00:00Z" })]);
    db.failOn("venue_bookings", "update");
    expect((await decide("Approved")).status).toBe("blocked");
    expect(row(1).status).toBe("On Hold");
    expect(published).toEqual([]);
  });
});

describe("decideBooking: reject", () => {
  it.each(["Requested", "On Hold"])("rejects a %s booking: status, trimmed reason, decider and cleared hold", async (status) => {
    world([bk(1, { status, hold_expires_at: status === "On Hold" ? "2099-01-01T00:00:00Z" : null })]);
    const r = await decide("Rejected", { reason: "  Too small  " });
    expect(r).toMatchObject({ status: "ok", autoRejectedIds: [], coordinatorsNotified: 1, notificationsFailed: false });
    expect(row(1)).toMatchObject({ status: "Rejected", decision_reason: "Too small", decided_by: STAFF, decided_at: NOW.toISOString(), hold_expires_at: null });
    expect(published).toEqual([
      { type: "booking.decided", eventId: 101, actorId: STAFF, recipients: { userIds: ["COORD-101"], roles: [] }, data: { decision: "rejected", reason: "Too small", eventName: "Event 101", venueName: "Grand Hall" } },
    ]);
    expect(rec.reconcileBufferOverlapsSafely).toHaveBeenCalledWith(db, 1, AUTH);
  });
  it("a missing reason is stored as an empty string (the route enforces it)", async () => {
    await decide("Rejected", { reason: undefined });
    expect(row(1).decision_reason).toBe("");
  });
  it("needs neither the event to be in Planning nor the venue lock", async () => {
    events[101].status = "Confirmed";
    expect((await decide("Rejected")).status).toBe("ok");
    expect(db.calls.some((c) => c.table === "venue_booking_locks")).toBe(false);
  });
  it("does not auto-reject anything else", async () => {
    world([bk(1), bk(2)]);
    await decide("Rejected");
    expect(row(2).status).toBe("Requested");
  });
  it("error when the write fails; blocked when someone else decided first", async () => {
    db.failOn("venue_bookings", "update");
    expect(await decide("Rejected")).toEqual({ status: "error" });
    db.clearFailures();
    // simulate a concurrent decision: status changed between read and write
    db.failOn("venue_bookings", "update", 1, () => { row(1).status = "Withdrawn"; return false; });
    expect(await decide("Rejected")).toEqual({ status: "blocked", message: "This booking was decided by someone else — reload the queue" });
    expect(row(1)).toMatchObject({ status: "Withdrawn", decision_reason: null });
    expect(rec.reconcileBufferOverlapsSafely).not.toHaveBeenCalled();
  });
  it("is still ok with 0 notified when the event cannot be looked up or has no coordinator", async () => {
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    expect(await decide("Rejected")).toMatchObject({ status: "ok", coordinatorsNotified: 0, notificationsFailed: false });
    world([bk(1)], { events: [evt(101, { coordinatorId: null })] });
    expect(await decide("Rejected")).toMatchObject({ status: "ok", coordinatorsNotified: 0 });
    expect(published).toEqual([]);
  });
  it("labels an unnamed event by its id", async () => {
    world([bk(1)], { events: [evt(101, { name: "" })] });
    await decide("Rejected");
    expect(published[0].data.eventName).toBe("Event #101");
  });
  it("a failing broker is reported but never undoes the rejection", async () => {
    publishOk = false;
    expect(await decide("Rejected")).toMatchObject({ status: "ok", coordinatorsNotified: 0, notificationsFailed: true });
    expect(row(1).status).toBe("Rejected");
  });
});

describe.each([["On Hold"], ["Approved"]] as const)("decideBooking: %s", (decision) => {
  const verb = decision === "On Hold" ? "held" : "approved";

  it("event lookup error → event_error; unknown event → blocked", async () => {
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    expect(await decide(decision)).toEqual({ status: "event_error" });
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events: [] });
    expect(await decide(decision)).toEqual({ status: "blocked", message: "This booking's event is no longer available" });
    expect(row(1).status).toBe("Requested");
  });
  it.each(["Draft", "Unassigned", "Requested", "Clarification Requested", "Safety Review", "Confirmed", "Rejected", "Completed", "Cancelled"])("is refused while the event is %s", async (status) => {
    events[101].status = status;
    expect(await decide(decision)).toEqual({ status: "blocked", message: `This event is ${status}, so its venue booking can no longer be ${verb}` });
    expect(row(1).status).toBe("Requested");
  });
  it.each(["Planning", "Needs Review"])("is allowed while the event is %s", async (status) => {
    events[101].status = status;
    expect((await decide(decision)).status).toBe("ok");
  });
  it("is refused when the event has no usable date", async () => {
    for (const proposedDate of [null, "", "tomorrow"]) {
      events[101].proposedDate = proposedDate;
      expect(await decide(decision)).toEqual({ status: "blocked", message: "This event has no date or time to book a venue for" });
    }
  });
  it("is refused over a block-out, naming the venue, period and reason", async () => {
    db.tables.venue_unavailability = [{ id: 1, venue_id: 1, start_date: "2026-09-19", end_date: "2026-09-21", all_day: true, start_time: null, end_time: null, reason: "Roof repair" }];
    expect(await decide(decision)).toEqual({
      status: "blocked",
      message: `Grand Hall is unavailable from 2026-09-19 to 2026-09-21 (all day): Roof repair. This booking can't be ${verb} while it overlaps that period.`,
    });
    expect(row(1).status).toBe("Requested");
  });
  it("a block-out that merely touches the occupied window does not stop it (window 09:30–12:30)", async () => {
    const block = (startTime: string, endTime: string) => [{ id: 1, venue_id: 1, start_date: "2026-09-20", end_date: "2026-09-20", all_day: false, start_time: startTime, end_time: endTime, reason: "x" }];
    db.tables.venue_unavailability = block("12:30", "14:00");
    expect((await decide(decision)).status).toBe("ok");
    world([bk(1)]);
    db.tables.venue_unavailability = block("12:29", "14:00");
    expect((await decide(decision)).status).toBe("blocked");
  });
  it("error when the block-out lookup fails", async () => {
    db.failOn("venue_unavailability", "select");
    expect(await decide(decision)).toEqual({ status: "error" });
  });

  it("success writes the decision, takes the lock for the duration and always releases it", async () => {
    const r = await decide(decision);
    expect(r).toMatchObject({ status: "ok", autoRejectedIds: [], coordinatorsNotified: 1, notificationsFailed: false });
    expect(row(1)).toMatchObject({
      status: decision, decided_by: STAFF, decided_at: NOW.toISOString(),
      hold_expires_at: decision === "On Hold" ? new Date(NOW.getTime() + 72 * H).toISOString() : null,
    });
    expect(db.rows("venue_booking_locks")).toEqual([]);
    expect(db.writes("venue_booking_locks").map((c) => c.op)).toEqual(expect.arrayContaining(["insert", "delete"]));
    expect(published).toEqual([
      { type: "booking.decided", eventId: 101, actorId: STAFF, recipients: { userIds: ["COORD-101"], roles: [] }, data: { decision: decision === "On Hold" ? "on_hold" : "approved", reason: "", eventName: "Event 101", venueName: "Grand Hall" } },
    ]);
    expect(rec.reconcileBufferOverlapsSafely).toHaveBeenCalledWith(db, 1, AUTH);
  });
  it("a hold in another's hands: lock busy → blocked, nothing written", async () => {
    db.mapOn("venue_booking_locks", "insert", () => ({ data: null, error: { code: "23505", message: "duplicate key" } }));
    vi.useFakeTimers(); // let the lock's retry delays run instantly
    const pending = decide(decision);
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ status: "blocked", message: "Another decision for this venue is still being processed — please try again." });
    expect(row(1).status).toBe("Requested");
  });
  it("a lock that cannot be taken for any other reason is an error, not 'busy', and nothing is written", async () => {
    db.failOn("venue_booking_locks", "insert");
    await expect(decide(decision)).rejects.toThrow("Could not take the lock for venue 1:");
    expect(row(1).status).toBe("Requested");
  });
  it("releases the lock even when the decision fails mid-way", async () => {
    db.failOn("venue_bookings", "update");
    expect(await decide(decision)).toEqual({ status: "error" });
    expect(db.rows("venue_booking_locks")).toEqual([]);
  });
  it("error when the blocking-booking check fails (query or events lookup)", async () => {
    world([bk(1), bk(2, { status: "Approved" })]);
    db.failOn("venue_bookings", "select", 1, (c) => c.filters.some((f) => f.col === "venue_id") && c.filters.some((f) => f.col === "status" && f.kind === "in"));
    expect(await decide(decision)).toEqual({ status: "error" });
    world([bk(1), bk(2, { status: "Approved" })]);
    let calls = 0;
    ev.fetchVenueBookingInfo.mockImplementation(async (ids: number[]) => (++calls === 2 ? { status: "error" } : { status: "ok", events: ids.map((i) => events[i]).filter(Boolean) }));
    expect(await decide(decision)).toEqual({ status: "error" });
    expect(row(1).status).toBe("Requested");
  });

  describe("conflicts (own window 09:30–12:30 on 2026-09-20)", () => {
    const rival = (o: Record<string, unknown>, eo: Record<string, unknown> = {}) => {
      world([bk(1), bk(2, { status: "Approved", ...o })], { events: [evt(102, eo)] });
    };
    it("an overlapping Approved booking blocks it, with both windows and the venue's buffers", async () => {
      rival({}, { startTime: "11:00", endTime: "13:00" });
      expect(await decide(decision)).toEqual({
        status: "conflict",
        message: "Venue is not available for this period",
        conflict: { bookingId: 2, status: "Approved", window: "2026-09-20 10:30–13:30", requestedWindow: "2026-09-20 09:30–12:30", setupMinutes: 30, turnaroundMinutes: 30 },
      });
      expect(row(1).status).toBe("Requested");
      expect(published).toEqual([]);
    });
    it("an unexpired On Hold booking blocks too", async () => {
      rival({ status: "On Hold", hold_expires_at: "2026-09-15T00:00:00Z" });
      expect((await decide(decision)).status).toBe("conflict");
    });
    it.each([
      ["a lapsed hold", { status: "On Hold", hold_expires_at: "2026-09-14T07:00:00Z" }],
      ["a Requested booking", { status: "Requested" }],
      ["a Rejected booking", { status: "Rejected" }],
      ["a Withdrawn booking", { status: "Withdrawn" }],
      ["a Cancelled booking", { status: "Cancelled" }],
      ["a Replacement Required booking", { status: "Replacement Required" }],
    ])("%s does not block", async (_n, o) => {
      rival(o);
      expect((await decide(decision)).status).toBe("ok");
    });
    it("windows that touch exactly (other ends 09:30 / starts 12:30 in padded terms) do not conflict; one minute more does", async () => {
      // other event 06:00–08:00 → occupies 05:30–08:30; ours starts 09:30. Push it to touch: 07:00–09:00 → 06:30–09:30
      rival({}, { startTime: "07:00", endTime: "09:00" });
      expect((await decide(decision)).status).toBe("ok");
      rival({}, { startTime: "07:00", endTime: "09:01" });
      expect((await decide(decision)).status).toBe("conflict");
      rival({}, { startTime: "14:00", endTime: "16:00" }); // occupies 13:30–16:30; ours ends 12:30
      expect((await decide(decision)).status).toBe("ok");
      rival({}, { startTime: "13:00", endTime: "16:00" }); // 12:30–16:30
      expect((await decide(decision)).status).toBe("ok");
      rival({}, { startTime: "12:59", endTime: "16:00" }); // 12:29–16:30
      expect((await decide(decision)).status).toBe("conflict");
    });
    it("a different day or a different venue never conflicts; the booking itself is excluded", async () => {
      rival({}, { proposedDate: "2026-09-21" });
      expect((await decide(decision)).status).toBe("ok");
      rival({ venue_id: 2 });
      expect((await decide(decision)).status).toBe("ok");
    });
    it("an event with no times occupies its whole day", async () => {
      rival({}, { startTime: null, endTime: null });
      expect((await decide(decision)).status).toBe("conflict");
    });
    it("ignores a blocking booking whose event is unknown or undated", async () => {
      rival({}, { proposedDate: null });
      expect((await decide(decision)).status).toBe("ok");
      world([bk(1), bk(2, { status: "Approved", event_id: 555 })]);
      delete events[555]; // events-service no longer returns this event
      expect((await decide(decision)).status).toBe("ok");
    });
  });

  describe("the write and the race check", () => {
    it("blocked, nothing changed, when another decision moved the booking after the read", async () => {
      db.failOn("venue_bookings", "update", 1, () => { row(1).status = "Withdrawn"; return false; });
      expect(await decide(decision)).toEqual({ status: "blocked", message: "This booking was decided by someone else — reload the queue" });
    });
    it("error when the post-write re-check cannot be run, leaving the decision in place", async () => {
      world([bk(1), bk(2, { status: "Approved", venue_id: 2 })]);
      let blockingSelects = 0;
      db.failOn("venue_bookings", "select", 1, (c) => c.filters.some((f) => f.col === "status" && f.kind === "in") && ++blockingSelects === 2);
      expect(await decide(decision)).toEqual({ status: "error" });
    });
    /** Inject a rival that appears right after our write succeeds. */
    function rivalAppearsAfterWrite(rivalRow: Record<string, unknown>, rivalEvent: Record<string, unknown> = {}) {
      events[102] = evt(102, rivalEvent);
      db.failOn("venue_bookings", "update", 1, () => false); // marker so only the first update triggers
      const real = db.from;
      let injected = false;
      db.from = ((t: string) => {
        const q: any = real(t);
        if (t !== "venue_bookings") return q;
        const origThen = q.then.bind(q);
        const origMaybe = q.maybeSingle.bind(q);
        q.maybeSingle = async () => {
          const out = await origMaybe();
          if (!injected && out.data?.id === 1 && out.data?.status === decision) {
            injected = true;
            db.tables.venue_bookings.push({ id: 2, venue_id: 1, event_id: 102, status: "Approved", hold_expires_at: null, decision_reason: null, decided_by: null, decided_at: null, ...rivalRow });
          }
          return out;
        };
        q.then = origThen;
        return q;
      }) as never;
    }
    it("a rival that arrived first (earlier decided_at) wins: this decision rolls back to Rejected and reports the conflict", async () => {
      rivalAppearsAfterWrite({ decided_at: "2026-09-14T07:00:00.000Z" });
      const r = await decide(decision);
      expect(r).toMatchObject({ status: "conflict", conflict: { bookingId: 2, status: "Approved" } });
      expect(row(1)).toMatchObject({ status: "Rejected", decision_reason: AUTO_REJECT_REASON, decided_by: null, hold_expires_at: null, decided_at: NOW.toISOString() });
      expect(rec.reconcileBufferOverlapsSafely).toHaveBeenCalledWith(db, 1, AUTH);
      expect(published).toEqual([]);
    });
    it("a rival decided later does not make us yield — we keep the venue", async () => {
      rivalAppearsAfterWrite({ decided_at: "2026-09-14T09:00:00.000Z" });
      expect((await decide(decision)).status).toBe("ok");
      expect(row(1).status).toBe(decision);
    });
    it("equal timestamps fall back to the lower id: a lower-id rival wins, a higher-id rival does not", async () => {
      // our booking is id 1, so a rival with id 2 is higher → we keep it
      rivalAppearsAfterWrite({ decided_at: NOW.toISOString() });
      expect((await decide(decision)).status).toBe("ok");
    });
    it("at equal timestamps a lower-id rival wins and we roll back", async () => {
      rivalAppearsAfterWrite({ id: 0, decided_at: NOW.toISOString() });
      const r = await decide(decision);
      expect(r).toMatchObject({ status: "conflict", conflict: { bookingId: 0 } });
      expect(row(1)).toMatchObject({ status: "Rejected", decision_reason: AUTO_REJECT_REASON });
    });
    it("a rival with no decided_at counts as the earliest of all", async () => {
      rivalAppearsAfterWrite({ decided_at: null });
      expect((await decide(decision)).status).toBe("conflict");
    });
    it("error when the rollback itself fails", async () => {
      rivalAppearsAfterWrite({ decided_at: "2026-09-14T07:00:00.000Z" });
      db.failOn("venue_bookings", "update", 1, () => false);
      db.failOn("venue_bookings", "update", -1, (c) => c.payload?.status === "Rejected");
      expect(await decide(decision)).toEqual({ status: "error" });
    });
  });

  describe("requests that lost the venue", () => {
    it("overlapping Requested bookings are auto-rejected with the fixed reason, no decider; others untouched", async () => {
      world(
        [bk(1), bk(2), bk(3), bk(4), bk(5, { status: "Approved", venue_id: 2 }), bk(6, { venue_id: 2 }), bk(7, { status: "Withdrawn" })],
        { venues: [venueRow(), venueRow({ id: 2, name: "Annex" })], events: [evt(102, { startTime: "11:00", endTime: "13:00" }), evt(103, { proposedDate: "2026-09-21" }), evt(104, { startTime: "13:00", endTime: "14:00" }), evt(106, { startTime: "11:00", endTime: "13:00" })] },
      );
      const r = await decide(decision);
      expect(r).toMatchObject({ status: "ok", autoRejectedIds: [2] });
      expect(row(2)).toMatchObject({ status: "Rejected", decision_reason: AUTO_REJECT_REASON, decided_by: null, decided_at: NOW.toISOString() });
      expect(row(3).status).toBe("Requested"); // different day
      expect(row(4).status).toBe("Requested"); // 12:30–14:30 touches our 09:30–12:30 end
      expect(row(6).status).toBe("Requested"); // other venue
      expect(row(7).status).toBe("Withdrawn");
      expect(row(5).status).toBe("Approved");
    });
    it("a one-minute overlap loses, a touching window survives", async () => {
      world([bk(1), bk(2), bk(3)], { events: [evt(102, { startTime: "12:59", endTime: "14:00" }), evt(103, { startTime: "13:00", endTime: "14:00" })] });
      const r = await decide(decision);
      expect(r).toMatchObject({ autoRejectedIds: [2] });
      expect(row(3).status).toBe("Requested");
    });
    it("tells each loser's coordinator (booking.decided / auto_rejected) in addition to ours; skips coordinator-less ones", async () => {
      world([bk(1), bk(2), bk(3), bk(4)], { events: [evt(102), evt(103, { coordinatorId: null }), evt(104, { name: "" })] });
      const r = await decide(decision);
      expect(r).toMatchObject({ status: "ok", autoRejectedIds: [2, 3, 4], coordinatorsNotified: 3, notificationsFailed: false });
      const auto = published.filter((m) => m.data.decision === "auto_rejected");
      expect(auto.map((m) => m.recipients.userIds[0])).toEqual(["COORD-102", "COORD-104"]);
      expect(auto[0]).toEqual({ type: "booking.decided", eventId: 102, actorId: null, recipients: { userIds: ["COORD-102"], roles: [] }, data: { decision: "auto_rejected", reason: AUTO_REJECT_REASON, eventName: "Event 102", venueName: "Grand Hall" } });
      expect(auto[1].data.eventName).toBe("Event #104");
      expect(published).toHaveLength(3);
    });
    it("the fixed reason is exactly the text the story promises, on the row and on the notification", async () => {
      expect(AUTO_REJECT_REASON).toBe("Venue no longer available for this period");
      world([bk(1), bk(2)]);
      await decide(decision);
      expect(row(2).decision_reason).toBe("Venue no longer available for this period");
      expect(published.find((m) => m.data.decision === "auto_rejected").data.reason).toBe("Venue no longer available for this period");
    });
    it("one message lost out of several still counts as a failure and notifies nobody", async () => {
      world([bk(1), bk(2)]);
      setPublisherForTest({ publish: async (m) => { published.push(m); return m.recipients.userIds[0] !== "COORD-102"; } });
      expect(await decide(decision)).toMatchObject({ status: "ok", autoRejectedIds: [2], coordinatorsNotified: 0, notificationsFailed: true });
      world([bk(1), bk(2)]);
      setPublisherForTest({ publish: async (m) => { published.push(m); return m.recipients.userIds[0] !== "COORD-101"; } });
      expect(await decide(decision)).toMatchObject({ status: "ok", autoRejectedIds: [2], coordinatorsNotified: 0, notificationsFailed: true });
    });
    it("when every message goes out, both coordinators are counted", async () => {
      world([bk(1), bk(2)]);
      expect(await decide(decision)).toMatchObject({ coordinatorsNotified: 2, notificationsFailed: false });
    });
    it("a failed broker zeroes the notified count but keeps every write", async () => {
      world([bk(1), bk(2)]);
      publishOk = false;
      expect(await decide(decision)).toMatchObject({ status: "ok", autoRejectedIds: [2], coordinatorsNotified: 0, notificationsFailed: true });
      expect(row(1).status).toBe(decision);
      expect(row(2).status).toBe("Rejected");
    });
    it("error when the losers cannot be found or rejected", async () => {
      world([bk(1), bk(2)]);
      db.failOn("venue_bookings", "select", 1, (c) => c.filters.some((f) => f.col === "status" && f.value === "Requested"));
      expect(await decide(decision)).toEqual({ status: "error" });
      world([bk(1), bk(2)]);
      db.failOn("venue_bookings", "update", 1, (c) => c.payload?.decision_reason === AUTO_REJECT_REASON);
      expect(await decide(decision)).toEqual({ status: "error" });
      world([bk(1), bk(2)]);
      let n = 0;
      ev.fetchVenueBookingInfo.mockImplementation(async (ids: number[]) => (++n === 2 ? { status: "error" } : { status: "ok", events: ids.map((i) => events[i]).filter(Boolean) }));
      expect(await decide(decision)).toEqual({ status: "error" });
    });
    it("only auto-rejects Requested rows that are still Requested at write time", async () => {
      world([bk(1), bk(2)]);
      await decide(decision);
      const upd = db.calls.find((c) => c.op === "update" && c.payload?.decision_reason === AUTO_REJECT_REASON)!;
      expect(upd.filters).toEqual(expect.arrayContaining([{ col: "id", kind: "in", value: [2] }, { col: "status", kind: "eq", value: "Requested" }]));
    });
  });
});

describe("decideBooking: serialisation per venue", () => {
  it("two simultaneous approvals of overlapping bookings: exactly one wins", async () => {
    world([bk(1), bk(2)], { events: [evt(102, { startTime: "11:00", endTime: "13:00" })] });
    const [a, b] = await Promise.all([decide("Approved", {}, 1), decide("Approved", {}, 2)]);
    // the second decision queued behind the first, saw its Approved booking and lost
    expect(a.status).toBe("ok");
    expect(b).toMatchObject({ status: "conflict", conflict: { bookingId: 1 } });
    const statuses = [row(1).status, row(2).status].sort();
    expect(statuses).toEqual(["Approved", "Rejected"]);
  });
  it("different venues proceed independently", async () => {
    world([bk(1), bk(2, { venue_id: 2 })], { venues: [venueRow(), venueRow({ id: 2, name: "Annex" })] });
    const [a, b] = await Promise.all([decide("Approved", {}, 1), decide("Approved", {}, 2)]);
    expect([a.status, b.status]).toEqual(["ok", "ok"]);
  });
});

describe("expireLapsedHolds", () => {
  const venues = new Map([[1, { id: 1, name: "Grand Hall" }], [2, { id: 2, name: "Annex" }]]);

  it("does nothing for an empty list", async () => {
    await expireLapsedHolds(db as never, [], venues, AUTH);
    expect(db.calls).toHaveLength(0);
  });
  it("expires only rows still On Hold, tells each coordinator, reconciles each venue once", async () => {
    world([bk(1, { status: "On Hold", hold_expires_at: "2026-09-13T00:00:00Z" }), bk(2, { status: "On Hold", hold_expires_at: "2026-09-13T00:00:00Z", venue_id: 2 }), bk(3, { status: "On Hold", hold_expires_at: "2026-09-13T00:00:00Z" }), bk(4, { status: "Approved" })]);
    await expireLapsedHolds(db as never, [row(1), row(2), row(3)] as never, venues, AUTH);
    expect([1, 2, 3].map((i) => row(i).status)).toEqual(["Expired", "Expired", "Expired"]);
    expect(row(4).status).toBe("Approved");
    expect(published.map((m) => [m.type, m.eventId, m.data.venueName])).toEqual([["hold.expired", 101, "Grand Hall"], ["hold.expired", 102, "Annex"], ["hold.expired", 103, "Grand Hall"]]);
    expect(rec.reconcileBufferOverlapsSafely.mock.calls.map((c) => c[1])).toEqual([1, 2]);
  });
  it("stops quietly when the write fails", async () => {
    world([bk(1, { status: "On Hold", hold_expires_at: "2026-09-13T00:00:00Z" })]);
    db.failOn("venue_bookings", "update");
    await expireLapsedHolds(db as never, [row(1)] as never, venues, AUTH);
    expect(published).toEqual([]);
    expect(rec.reconcileBufferOverlapsSafely).not.toHaveBeenCalled();
  });
  it("still expires but notifies nobody when events cannot be read, the venue is unknown or there is no coordinator", async () => {
    world([bk(1, { status: "On Hold", hold_expires_at: "2026-09-13T00:00:00Z" })]);
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    await expireLapsedHolds(db as never, [row(1)] as never, venues, AUTH);
    expect(row(1).status).toBe("Expired");
    world([bk(1, { status: "On Hold", hold_expires_at: "2026-09-13T00:00:00Z" })]);
    await expireLapsedHolds(db as never, [row(1)] as never, new Map(), AUTH);
    world([bk(1, { status: "On Hold", hold_expires_at: "2026-09-13T00:00:00Z" })], { events: [evt(101, { coordinatorId: null })] });
    await expireLapsedHolds(db as never, [row(1)] as never, venues, AUTH);
    expect(published).toEqual([]);
  });
});

describe("sweepExpiringHolds (warn 12h ahead)", () => {
  const hold = (id: number, hours: number, o: Record<string, unknown> = {}) =>
    bk(id, { status: "On Hold", hold_expires_at: new Date(NOW.getTime() + hours * H).toISOString(), expiry_warning_sent_at: null, ...o });

  it("warns for holds expiring within 12 hours (inclusive), not later, not already expired (exclusive), not already warned", async () => {
    world([hold(1, 12), hold(2, 12.0001), hold(3, 0.0001), hold(4, 0), hold(5, 6, { expiry_warning_sent_at: "2026-09-14T01:00:00Z" }), hold(6, 6, { status: "Approved" }), hold(7, 6)]);
    await sweepExpiringHolds(db as never);
    expect(published.map((m) => m.eventId).sort()).toEqual([101, 103, 107]);
    expect(published[0]).toMatchObject({ type: "hold.expiring", actorId: null, data: { venueName: "Grand Hall", eventName: expect.any(String), expiresAt: expect.any(String) } });
    expect(row(1).expiry_warning_sent_at).toBe(NOW.toISOString());
    expect(row(2).expiry_warning_sent_at).toBeNull();
    expect(row(4).expiry_warning_sent_at).toBeNull();
    expect(row(5).expiry_warning_sent_at).toBe("2026-09-14T01:00:00Z");
    expect(ev.fetchVenueBookingInfoInternal).toHaveBeenCalled();
    expect(ev.fetchVenueBookingInfo).not.toHaveBeenCalled();
  });
  it("does nothing when the lookup errors or finds nothing", async () => {
    world([hold(1, 6)]);
    db.failOn("venue_bookings", "select");
    await sweepExpiringHolds(db as never);
    world([hold(1, 40)]);
    await sweepExpiringHolds(db as never);
    expect(published).toEqual([]);
    expect(db.writes("venue_bookings")).toHaveLength(0);
  });
  it("treats a null result like no rows rather than failing", async () => {
    world([hold(1, 6)]);
    db.nullOn("venue_bookings", "select");
    await expect(sweepExpiringHolds(db as never)).resolves.toBeUndefined();
    expect(published).toEqual([]);
    expect(db.writes("venue_bookings")).toHaveLength(0);
  });
  it("stops (nothing stamped) when venues cannot be read", async () => {
    world([hold(1, 6)]);
    db.failOn("venues", "select");
    await sweepExpiringHolds(db as never);
    expect(published).toEqual([]);
    expect(row(1).expiry_warning_sent_at).toBeNull();
  });
  it("stamps every considered booking even if nobody could be told", async () => {
    world([hold(1, 6), hold(2, 6, { venue_id: 9 })], { events: [evt(101, { coordinatorId: null })] });
    await sweepExpiringHolds(db as never);
    expect(published).toEqual([]);
    expect(row(1).expiry_warning_sent_at).toBe(NOW.toISOString());
    expect(row(2).expiry_warning_sent_at).toBe(NOW.toISOString());
  });
  it("still warns from venue data when events-service is down? no coordinator can be found, but rows are stamped", async () => {
    world([hold(1, 6)]);
    ev.fetchVenueBookingInfoInternal.mockResolvedValue({ status: "error" });
    await sweepExpiringHolds(db as never);
    expect(published).toEqual([]);
    expect(row(1).expiry_warning_sent_at).toBe(NOW.toISOString());
  });
});

describe("blockingWindows", () => {
  const venue = { id: 1, name: "Grand Hall", location: "N", setup_minutes: 30, turnaround_minutes: 30 };
  it("null on a query or events error", async () => {
    world([bk(1, { status: "Approved" })]);
    db.failOn("venue_bookings", "select");
    expect(await blockingWindows(db as never, venue, AUTH, 99)).toBeNull();
    world([bk(1, { status: "Approved" })]);
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    expect(await blockingWindows(db as never, venue, AUTH, 99)).toBeNull();
  });
  it("[] without asking events-service when nothing blocks", async () => {
    world([bk(1, { status: "Requested" })]);
    expect(await blockingWindows(db as never, venue, AUTH, 99)).toEqual([]);
    expect(ev.fetchVenueBookingInfo).not.toHaveBeenCalled();
  });
  it("excludes the named booking and lapsed holds, and returns padded windows", async () => {
    world([bk(1, { status: "Approved" }), bk(2, { status: "Approved" }), bk(3, { status: "On Hold", hold_expires_at: "2026-09-14T07:59:59Z" }), bk(4, { status: "On Hold", hold_expires_at: "2026-09-15T00:00:00Z" })]);
    const out = await blockingWindows(db as never, venue, AUTH, 1);
    expect(out!.map((x) => x.booking.id)).toEqual([2, 4]);
    expect(out![0].window).toEqual({ startMs: Date.UTC(2026, 8, 20, 9, 30), endMs: Date.UTC(2026, 8, 20, 12, 30) });
  });
});

describe("yieldsTo: which of two rival bookings gives way", () => {
  const row = (id: number, decided_at: string | null) => ({
    id, venue_id: 1, event_id: id, status: "Approved" as const, hold_expires_at: null, decision_reason: null, decided_by: null, decided_at,
  });
  const T1 = "2026-11-10T10:00:00.000Z";
  const T2 = "2026-11-10T10:00:00.001Z";

  it("my booking yields to a rival that was decided first, and not to one decided after it", () => {
    expect(yieldsTo(row(9, T1), row(1, T2))).toBe(true);
    expect(yieldsTo(row(1, T2), row(9, T1))).toBe(false);
  });

  it("an earlier decision wins whatever the ids are", () => {
    expect(yieldsTo(row(5, T1), row(2, T2))).toBe(true);
    expect(yieldsTo(row(2, T2), row(5, T1))).toBe(false);
  });

  it("at the same instant the higher id yields to the lower, never the other way round", () => {
    expect(yieldsTo(row(1, T1), row(2, T1))).toBe(true);
    expect(yieldsTo(row(2, T1), row(1, T1))).toBe(false);
  });

  it("a booking never yields to itself", () => {
    expect(yieldsTo(row(3, T1), row(3, T1))).toBe(false);
    expect(yieldsTo(row(3, null), row(3, null))).toBe(false);
  });

  it("a missing decision time counts as the very beginning", () => {
    expect(yieldsTo(row(9, null), row(1, T1))).toBe(true);
    expect(yieldsTo(row(1, T1), row(9, null))).toBe(false);
    expect(yieldsTo(row(1, null), row(2, null))).toBe(true);
    expect(yieldsTo(row(2, null), row(1, null))).toBe(false);
  });
});
