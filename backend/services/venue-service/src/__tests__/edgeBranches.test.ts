/**
 * The leftover edges the route/lib suites do not reach:
 *  - a driver handing back `{ data: null, error: null }` (every `data ?? []` fallback);
 *  - route params that arrive as arrays (Express never does this over HTTP, so the handlers are called directly);
 *  - a handful of data shapes: null buffers, events events-service no longer returns, undated events, sort ties.
 * Each assertion pins the exact outcome, so changing a fallback or a comparison fails here.
 */
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";
import { ATTENDEE, COORD, STAFF, appWith, callRoute } from "./helpers/app.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { from: (t: string) => h.db.from(t) } }));
const ev = vi.hoisted(() => ({
  fetchEvent: vi.fn(), fetchVenueBookingInfo: vi.fn(), fetchVenueBookingInfoInternal: vi.fn(), fetchPublicEvents: vi.fn(), reportArrangementsChanged: vi.fn(),
}));
vi.mock("../lib/eventsClient.js", async (orig) => ({ ...(await orig<typeof import("../lib/eventsClient.js")>()), ...ev }));
const rec = vi.hoisted(() => ({ reconcileBufferOverlaps: vi.fn() }));
vi.mock("../lib/bufferOverlapReview.js", async (orig) => ({ ...(await orig<typeof import("../lib/bufferOverlapReview.js")>()), ...rec }));

import { attendeeInfoRouter } from "../routes/attendeeInfo.js";
import { eventBookingsRouter } from "../routes/eventBookings.js";
import { publicVenuesRouter } from "../routes/publicVenues.js";
import { staffRouter } from "../routes/staff.js";
import { suitabilityRouter } from "../routes/suitability.js";
import { unavailabilityRouter } from "../routes/unavailability.js";
import { venuesRouter } from "../routes/venues.js";
import { decideBooking, sweepExpiringHolds, blockingWindows, AUTO_REJECT_REASON } from "../lib/bookingDecisions.js";
import { reconcileBufferOverlaps } from "../lib/bufferOverlapReview.js";
import { releaseBookingsForCancelledEvent } from "../lib/eventCancellation.js";
import { findAllBufferOverlaps, loadLiveBookings } from "../lib/venueChanges.js";

const NOW = new Date("2026-09-14T08:00:00.000Z");
const published: any[] = [];

const venue = (id: number, o: Record<string, unknown> = {}) => ({
  id, name: `Venue ${id}`, location: "North", description: "d", capacity: 100, accessibility: ["Ramp"], layouts: ["Theatre"], facilities: ["Projector"],
  setup_minutes: 30, turnaround_minutes: 30, status: "Available", active: true, staff_id: "VEN-0001", opening_time: "08:00", closing_time: "22:00", ...o,
});
const info = (id: number, o: Record<string, unknown> = {}) => ({
  id, status: "Planning", name: `Event ${id}`, coordinatorId: `C-${id}`, proposedDate: "2026-09-20", startTime: "10:00", endTime: "12:00", expectedAttendance: 10,
  venue: null, accessibility: null, equipment: null, technicalSupport: null, ...o,
});
const bk = (id: number, o: Record<string, unknown> = {}) => ({
  id, venue_id: 1, event_id: 100 + id, status: "Requested", hold_expires_at: null, decision_reason: null, decided_by: null, decided_at: null, ...o,
});
const evtDetails = { name: "Gala", proposedDate: "2026-09-20", startTime: "10:00", endTime: "12:00", expectedAttendance: 80 };
const okEvent = (o: Record<string, unknown> = {}) => ({ status: "ok", event: { id: 7, status: "Planning", coordinator_id: "COORD-0001", submitted_details: evtDetails, ...o } });
const setEvents = (list: any[]) => {
  ev.fetchVenueBookingInfo.mockImplementation(async (ids: number[]) => ({ status: "ok", events: list.filter((e) => ids.includes(e.id)) }));
  ev.fetchVenueBookingInfoInternal.mockImplementation(async (ids: number[]) => ({ status: "ok", events: list.filter((e) => ids.includes(e.id)) }));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.db = createFakeDb({ venues: [venue(1), venue(2, { capacity: 300 })] });
  published.length = 0;
  setPublisherForTest({ publish: async (m) => { published.push(m); return true; } });
  ev.fetchEvent.mockReset().mockResolvedValue(okEvent());
  ev.fetchPublicEvents.mockReset().mockResolvedValue({ status: "ok", events: [] });
  ev.reportArrangementsChanged.mockReset().mockResolvedValue(true);
  rec.reconcileBufferOverlaps.mockReset().mockResolvedValue({ inserted: [] });
  setEvents([]);
});
afterEach(() => vi.useRealTimers());

const appV = appWith("/v", venuesRouter);
const appS = appWith("/s", staffRouter);
const appU = appWith("/u", unavailabilityRouter);
const appE = appWith("/e", eventBookingsRouter);
const appA = appWith("/a", attendeeInfoRouter);
const appP = appWith("/p", publicVenuesRouter);
const appQ = appWith("/q", suitabilityRouter);
const row = (id: number) => h.db.rows("venue_bookings").find((r) => r.id === id)!;
const only = (col: string, kind = "in") => (c: any) => c.filters.length === 1 && c.filters[0].col === col && c.filters[0].kind === kind;

describe("a null result with no error is read as 'no rows'", () => {
  it("attendee-info", async () => {
    h.db.nullOn("venue_bookings", "select");
    const res = await request(appA).get("/a?eventIds=1").set("Authorization", ATTENDEE);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ venues: [] });
  });
  it("an event's bookings", async () => {
    h.db.nullOn("venue_bookings", "select");
    expect((await request(appE).get("/e/7/bookings").set("Authorization", COORD)).body).toEqual({ bookings: [] });
  });
  it("suitability: no bookings, and no venues (so a booking's venue cannot be judged)", async () => {
    h.db.nullOn("venue_bookings", "select");
    const a = await request(appQ).get("/q/7").set("Authorization", COORD);
    expect(a.status).toBe(200);
    expect(a.body.bookings).toEqual([]);
    h.db.clearFailures();
    h.db.tables.venue_bookings = [{ id: 1, venue_id: 1, event_id: 7, status: "Approved", created_at: "1" }];
    h.db.nullOn("venues", "select");
    const b = await request(appQ).get("/q/7").set("Authorization", COORD);
    expect(b.body.bookings[0].suitability).toBeNull();
  });
  it("public venues", async () => {
    h.db.nullOn("venues", "select");
    expect((await request(appP).get("/p")).body).toEqual({ venues: [] });
  });
  it("staff pickers and options", async () => {
    h.db.nullOn("venues", "select");
    expect((await request(appS).get("/s/venues").set("Authorization", STAFF)).body).toEqual({ venues: [] });
    h.db.clearFailures();
    h.db.nullOn("venues", "select");
    const options = await request(appS).get("/s/venue-options").set("Authorization", STAFF);
    expect(options.status).toBe(200);
    expect(options.body.locations).toEqual([]);
    h.db.clearFailures();
    h.db.nullOn("venues", "select");
    expect((await request(appS).get("/s/my-venues").set("Authorization", STAFF)).body).toEqual({ venues: [] });
  });
  it("staff buffer overlaps: no flagged rows; flagged rows whose bookings cannot be read keep their ids but lose event names", async () => {
    h.db.nullOn("venue_buffer_overlaps", "select");
    expect((await request(appS).get("/s/venues/1/buffer-overlaps").set("Authorization", STAFF)).body).toEqual({ overlaps: [] });
    h.db.clearFailures();
    h.db.tables.venue_buffer_overlaps = [{ id: 1, venue_id: 1, booking_id_a: 1, booking_id_b: 2, window_a: "a", window_b: "b", detected_at: "d" }];
    h.db.nullOn("venue_bookings", "select");
    const res = await request(appS).get("/s/venues/1/buffer-overlaps").set("Authorization", STAFF);
    expect(res.body.overlaps[0].first).toEqual({ bookingId: 1, eventId: null, eventName: null, window: "a" });
  });
  it("staff schedule and queue", async () => {
    h.db.nullOn("venue_bookings", "select");
    expect((await request(appS).get("/s/1/bookings").set("Authorization", STAFF)).body.bookings).toEqual([]);
    h.db.clearFailures();
    h.db.nullOn("venue_bookings", "select");
    expect((await request(appS).get("/s/requests").set("Authorization", STAFF)).body).toEqual({ requests: [] });
    h.db.clearFailures();
    h.db.tables.venue_bookings = [bk(1)];
    setEvents([info(101)]);
    h.db.nullOn("venues", "select", -1, (c) => c.filters.some((f) => f.kind === "in"));
    expect((await request(appS).get("/s/requests").set("Authorization", STAFF)).body).toEqual({ requests: [] });
  });
  it("unavailability: preview with no bookings, and an empty period list", async () => {
    h.db.nullOn("venue_bookings", "select");
    const res = await request(appU).post("/u/preview").set("Authorization", STAFF).send({ venueId: 1, startDate: "2026-09-14", reason: "r" });
    expect(res.status).toBe(200);
    expect(res.body.affected).toEqual([]);
    h.db.clearFailures();
    h.db.nullOn("venue_unavailability", "select");
    expect((await request(appU).get("/u?venueId=1").set("Authorization", STAFF)).body).toEqual({ periods: [] });
  });
  it("venue search, filters, recommendations", async () => {
    h.db.nullOn("venues", "select");
    expect((await request(appV).get("/v/filters").set("Authorization", COORD)).body.capacity).toBeNull();
    h.db.clearFailures();
    h.db.nullOn("venues", "select");
    expect((await request(appV).get("/v").set("Authorization", COORD)).body.venues).toEqual([]);
    h.db.clearFailures();
    h.db.nullOn("venues", "select");
    expect((await request(appV).get("/v/recommendations/7").set("Authorization", COORD)).body.venues).toEqual([]);
    h.db.clearFailures();
    h.db.nullOn("venue_bookings", "select");
    const dated = await request(appV).get("/v?date=2026-09-20").set("Authorization", COORD);
    expect(dated.body.venues.map((v: any) => v.id)).toEqual([1, 2]);
  });
  it("venue availability: no bookings, no periods", async () => {
    h.db.nullOn("venue_bookings", "select");
    h.db.nullOn("venue_unavailability", "select");
    const res = await request(appV).get("/v/1/availability?from=2026-09-14&to=2026-09-20").set("Authorization", COORD);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bookings: [], unavailability: [] });
  });
  describe("requesting a venue", () => {
    const req = (body: Record<string, unknown> = {}) => request(appV).post("/v/bookings").set("Authorization", COORD).send({ eventId: 7, venueId: 1, ...body });
    it("no venues at all → venue not found", async () => {
      h.db.nullOn("venues", "select", 1);
      expect((await req()).body).toEqual({ error: "Venue not found" });
    });
    it("no existing bookings → carries on and creates the request", async () => {
      h.db.nullOn("venue_bookings", "select", 1, (c) => c.filters.some((f) => f.col === "venue_id") && c.filters.some((f) => f.col === "event_id"));
      expect((await req()).status).toBe(201);
    });
    it("no main-programme rows → treated as not yet covered", async () => {
      h.db.tables.venue_bookings = [];
      h.db.nullOn("venue_bookings", "select", 1, (c) => c.filters.some((f) => f.col === "event_id") && !c.filters.some((f) => f.col === "venue_id"));
      expect((await req()).status).toBe(201);
    });
    it("no blocking bookings → carries on", async () => {
      h.db.nullOn("venue_bookings", "select", 1, only("status"));
      expect((await req()).status).toBe(201);
    });
  });
});

describe("route params that arrive as arrays use their first element", () => {
  const bad = ["abc", "1"]; // first is invalid, second valid: taking [1] instead of [0] would sail past validation
  const ctx = () => ({ supabase: h.db, user: { id: "COORD-0001", role: "coordinator" } });
  const staffCtx = () => ({ supabase: h.db, user: { id: "VEN-0001", role: "venue_staff" } });

  it.each([
    ["event bookings", () => callRoute(eventBookingsRouter, "get", "/:eventId/bookings", { ...ctx(), params: { eventId: bad } }), "Invalid event id"],
    ["suitability", () => callRoute(suitabilityRouter, "get", "/:eventId", { ...ctx(), params: { eventId: bad } }), "Invalid event id"],
    ["recommendations", () => callRoute(venuesRouter, "get", "/recommendations/:eventId", { ...ctx(), params: { eventId: bad } }), "Invalid event id"],
    ["availability", () => callRoute(venuesRouter, "get", "/:venueId/availability", { ...ctx(), params: { venueId: bad } }), "Invalid venue id"],
    ["availability-check", () => callRoute(venuesRouter, "get", "/bookings/:bookingId/availability-check", { ...ctx(), params: { bookingId: bad } }), "Invalid booking id"],
    ["flag-for-rebooking", () => callRoute(venuesRouter, "post", "/bookings/:bookingId/flag-for-rebooking", { ...ctx(), params: { bookingId: bad } }), "Invalid booking id"],
    ["withdraw", () => callRoute(venuesRouter, "post", "/bookings/:bookingId/withdraw", { ...ctx(), params: { bookingId: bad } }), "Invalid booking id"],
    ["release", () => callRoute(venuesRouter, "post", "/bookings/:bookingId/release", { ...ctx(), params: { bookingId: bad } }), "Invalid booking id"],
    ["staff schedule", () => callRoute(staffRouter, "get", "/:venueId/bookings", { ...staffCtx(), params: { venueId: bad } }), "Invalid venue id"],
    ["staff venue edit", () => callRoute(staffRouter, "patch", "/venues/:venueId", { ...staffCtx(), params: { venueId: bad } }), "Invalid venue id"],
    ["staff buffer overlaps", () => callRoute(staffRouter, "get", "/venues/:venueId/buffer-overlaps", { ...staffCtx(), params: { venueId: bad } }), "Invalid venue id"],
    ["staff decision", () => callRoute(staffRouter, "post", "/bookings/:bookingId/approve", { ...staffCtx(), params: { bookingId: bad } }), "Invalid booking id"],
    ["unavailability edit", () => callRoute(unavailabilityRouter, "put", "/:id", { ...staffCtx(), params: { id: bad } }), "Invalid period id"],
    ["unavailability remove", () => callRoute(unavailabilityRouter, "delete", "/:id", { ...staffCtx(), params: { id: bad } }), "Invalid period id"],
  ])("%s", async (_n, call, message) => {
    const res = await call();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: message });
    expect(h.db.calls).toHaveLength(0);
  });

  it("and a valid first element is the one that is used", async () => {
    h.db.tables.venue_unavailability = [
      { id: 1, venue_id: 1, start_date: "2026-09-14", end_date: "2026-09-14", all_day: true, start_time: null, end_time: null, reason: "r" },
      { id: 2, venue_id: 1, start_date: "2026-09-15", end_date: "2026-09-15", all_day: true, start_time: null, end_time: null, reason: "r" },
    ];
    const res = await callRoute(unavailabilityRouter, "delete", "/:id", { ...staffCtx(), params: { id: ["2", "1"] } });
    expect(res.status).toBe(204);
    expect(h.db.rows("venue_unavailability").map((r) => r.id)).toEqual([1]);
  });
});

describe("venue records with missing buffers", () => {
  it("a conflict at a venue with no buffers reports 0/0 (decision and request)", async () => {
    h.db = createFakeDb({ venues: [venue(1, { setup_minutes: null, turnaround_minutes: null })], venue_bookings: [bk(1), bk(2, { status: "Approved" })] });
    setEvents([info(101), info(102, { startTime: "11:00", endTime: "13:00" })]);
    const decided = await decideBooking(h.db as never, { bookingId: 1, decision: "Approved", staffId: "VEN-0001", authorization: "t" });
    expect(decided).toMatchObject({ status: "conflict", conflict: { setupMinutes: 0, turnaroundMinutes: 0, window: "2026-09-20 11:00–13:00", requestedWindow: "2026-09-20 10:00–12:00" } });

    ev.fetchEvent.mockResolvedValue(okEvent());
    h.db.tables.venue_bookings = [{ id: 5, venue_id: 1, event_id: 102, status: "Approved", hold_expires_at: null }];
    const requested = await request(appV).post("/v/bookings").set("Authorization", COORD).send({ eventId: 7, venueId: 1 });
    expect(requested.status).toBe(409);
    expect(requested.body.conflict).toMatchObject({ setupMinutes: 0, turnaroundMinutes: 0 });
  });
});

describe("bookingDecisions edges", () => {
  const decide = (decision: "Approved" | "On Hold" | "Rejected", id = 1) => decideBooking(h.db as never, { bookingId: id, decision, staffId: "VEN-0001", authorization: "t", reason: "r" });

  it("requests whose event is gone, undated or on another day are left alone; when nothing overlaps nothing is rejected", async () => {
    h.db = createFakeDb({ venues: [venue(1)], venue_bookings: [bk(1), bk(2), bk(3), bk(4)] });
    setEvents([info(101), info(103, { proposedDate: null }), info(104, { proposedDate: "2026-09-21" })]); // event 102 unknown
    const r = await decide("Approved");
    expect(r).toMatchObject({ status: "ok", autoRejectedIds: [] });
    expect([2, 3, 4].map((i) => row(i).status)).toEqual(["Requested", "Requested", "Requested"]);
    expect(h.db.writes("venue_bookings").some((c) => c.payload?.decision_reason === AUTO_REJECT_REASON)).toBe(false);
  });
  it("no Requested rows (null result) means nothing to reject", async () => {
    h.db = createFakeDb({ venues: [venue(1)], venue_bookings: [bk(1)] });
    setEvents([info(101)]);
    h.db.nullOn("venue_bookings", "select", 1, (c) => c.filters.some((f) => f.col === "status" && f.value === "Requested"));
    expect(await decide("Approved")).toMatchObject({ status: "ok", autoRejectedIds: [] });
  });
  it("blockingWindows reads a null result as no blockers", async () => {
    h.db = createFakeDb({ venues: [venue(1)] });
    h.db.nullOn("venue_bookings", "select");
    expect(await blockingWindows(h.db as never, venue(1) as never, "t", 0)).toEqual([]);
  });
  it("a decision whose own row came back without decided_at never yields to a rival decided earlier", async () => {
    h.db = createFakeDb({ venues: [venue(1)], venue_bookings: [bk(1)] });
    setEvents([info(101), info(102)]);
    h.db.mapOn("venue_bookings", "update", (r) => {
      // the rival appears just after our write, and our row is read back without a timestamp
      h.db.tables.venue_bookings.push(bk(2, { status: "Approved", decided_at: "2026-09-14T07:00:00.000Z" }));
      return { ...r, data: { ...r.data, decided_at: null } };
    }, 1);
    const r = await decide("Approved");
    expect(r.status).toBe("ok");
    expect(row(1).status).toBe("Approved");
  });
  it("sweepExpiringHolds: a null venue list means no message, but the bookings are still stamped", async () => {
    h.db = createFakeDb({ venues: [venue(1)], venue_bookings: [bk(1, { status: "On Hold", hold_expires_at: new Date(NOW.getTime() + 3600_000).toISOString(), expiry_warning_sent_at: null })] });
    setEvents([info(101)]);
    h.db.nullOn("venues", "select");
    await sweepExpiringHolds(h.db as never);
    expect(published).toEqual([]);
    expect(row(1).expiry_warning_sent_at).toBe(NOW.toISOString());
  });
});

describe("other libs", () => {
  it("reconcileBufferOverlaps reads a null stored list as empty and inserts the current pairs", async () => {
    h.db = createFakeDb({ venues: [venue(1, { turnaround_minutes: 90, setup_minutes: 0 })], venue_bookings: [bk(1, { status: "Approved" }), bk(2, { status: "Approved" })] });
    setEvents([info(101), info(102, { startTime: "13:00", endTime: "15:00" })]);
    h.db.nullOn("venue_buffer_overlaps", "select", 1);
    const real = await vi.importActual<typeof import("../lib/bufferOverlapReview.js")>("../lib/bufferOverlapReview.js");
    const out = await real.reconcileBufferOverlaps(h.db as never, 1, "t", new Date(2026, 8, 14, 9, 0));
    expect(out!.inserted).toHaveLength(1);
    expect(h.db.rows("venue_buffer_overlaps")).toHaveLength(1);
    expect(reconcileBufferOverlaps).toBe(rec.reconcileBufferOverlaps); // the mocked one is what the routes see
  });
  it("releaseBookingsForCancelledEvent: a null update result releases nothing; null venue rows still release but notify nobody", async () => {
    h.db = createFakeDb({ venues: [venue(1)], venue_bookings: [bk(1)] });
    h.db.nullOn("venue_bookings", "update", 1);
    expect(await releaseBookingsForCancelledEvent(h.db as never, 101, "ORG-1", "Gala")).toEqual({ released: 0 });
    expect(row(1).status).toBe("Requested");
    h.db.nullOn("venues", "select", 1);
    expect(await releaseBookingsForCancelledEvent(h.db as never, 101, "ORG-1", "Gala")).toEqual({ released: 1 });
    expect(published).toEqual([]);
  });
  it("loadLiveBookings reads a null result as none", async () => {
    h.db = createFakeDb();
    h.db.nullOn("venue_bookings", "select");
    expect(await loadLiveBookings(h.db as never, 1, "t")).toEqual([]);
  });
  it("overlap sides carry a null coordinator when the event has none", () => {
    const booking = (id: number, eventId: number, o: Record<string, unknown> = {}) => ({ id, status: "Approved", headcount: null, event: info(eventId, { coordinatorId: undefined, ...o }) });
    const [pair] = findAllBufferOverlaps([booking(1, 1), booking(2, 2, { startTime: "11:00", endTime: "13:00" })] as never, { setup_minutes: 0, turnaround_minutes: 0 }, "2026-09-14");
    expect(pair.first.coordinatorId).toBeNull();
    expect(pair.second.coordinatorId).toBeNull();
  });
});

describe("venue routes: remaining data shapes", () => {
  const post = (body: Record<string, unknown> = {}) => request(appV).post("/v/bookings").set("Authorization", COORD).send({ eventId: 7, venueId: 1, ...body });

  it("blocking bookings whose venue is not bookable, whose event is gone or undated are ignored when requesting", async () => {
    h.db.rows("venues").push(venue(3, { status: "Unavailable" }));
    h.db.tables.venue_bookings = [
      { id: 1, venue_id: 3, event_id: 101, status: "Approved", hold_expires_at: null }, // venue not in the Available list
      { id: 2, venue_id: 1, event_id: 102, status: "Approved", hold_expires_at: null }, // event unknown
      { id: 3, venue_id: 1, event_id: 103, status: "Approved", hold_expires_at: null }, // event undated
    ];
    setEvents([info(101), info(103, { proposedDate: null })]);
    expect((await post()).status).toBe(201);
  });
  it("availability with only a target date leaves the times null", async () => {
    const res = await request(appV).get("/v/1/availability?from=2026-09-14&to=2026-09-20&targetFrom=2026-09-15").set("Authorization", COORD);
    expect(res.body.target).toEqual({ fromDate: "2026-09-15", toDate: "2026-09-15", startTime: null, endTime: null });
    expect(res.body.freeSlots.length).toBeGreaterThan(0);
  });
  it("recommendations for an event with no details but a plan still run", async () => {
    ev.fetchEvent.mockResolvedValue(okEvent({ submitted_details: null }));
    const res = await request(appV).get("/v/recommendations/7?headcount=5").set("Authorization", COORD);
    expect(res.status).toBe(200);
    expect(res.body.requirements.attendance).toBe(5);
    expect(res.body.venues.map((v: any) => v.id)).toEqual([1, 2]);
  });
  it("flag-for-rebooking names the venue generically if its name is missing", async () => {
    h.db.tables.venue_bookings = [{ id: 1, venue_id: 1, event_id: 7, status: "Approved" }];
    h.db.mapOn("venues", "select", (r) => ({ ...r, data: { ...r.data, name: null } }));
    const res = await request(appV).post("/v/bookings/1/flag-for-rebooking").set("Authorization", COORD).send({ reason: "r" });
    expect(res.status).toBe(200);
    expect(published[0].data.venueName).toBe("This venue");
  });
});

describe("ordering ties", () => {
  it("the queue puts undated events first and breaks date ties by start time, undated times first", async () => {
    h.db = createFakeDb({
      venues: [venue(1)],
      venue_bookings: [bk(1), bk(2), bk(3), bk(4), bk(5)],
    });
    setEvents([
      info(101, { proposedDate: null, startTime: null }), info(102, { proposedDate: null, startTime: null }),
      info(103, { proposedDate: "2026-09-20", startTime: null }), info(104, { proposedDate: "2026-09-20", startTime: "10:00" }), info(105, { proposedDate: "2026-09-20", startTime: null }),
    ]);
    const ids = async () => (await request(appS).get("/s/requests").set("Authorization", STAFF)).body.requests.map((r: any) => r.id);
    expect(await ids()).toEqual([1, 2, 3, 5, 4]);
    // the sort is stable: equal keys keep the order the rows came back in
    h.db.tables.venue_bookings = [bk(5), bk(4), bk(3), bk(2), bk(1)];
    expect(await ids()).toEqual([2, 1, 5, 3, 4]);
  });
  it("affected bookings on one day with no start time sort stably after the dated ones are compared", async () => {
    h.db = createFakeDb({ venues: [venue(1)], venue_bookings: [bk(1, { status: "Approved" }), bk(2, { status: "Approved" }), bk(3, { status: "Approved" })] });
    setEvents([info(101, { startTime: null, endTime: null }), info(102, { startTime: null, endTime: null }), info(103, { startTime: "09:00", endTime: "10:00" })]);
    const res = await request(appU).post("/u/preview").set("Authorization", STAFF).send({ venueId: 1, startDate: "2026-09-20", reason: "r" });
    expect(res.body.affected).toHaveLength(3);
    expect(res.body.affected[0].bookingId).not.toBe(3); // times missing sort before "09:00"
  });
  it("an invalid period with a valid venue id reports only the period's own problems", async () => {
    for (const path of ["/u/preview", "/u"]) {
      const res = await request(appU).post(path).set("Authorization", STAFF).send({ venueId: 1, startDate: "nope", reason: "r" });
      expect(res.status).toBe(400);
      expect(res.body.fields).toEqual({ startDate: "Enter a valid start date.", endDate: "Enter a valid end date." });
    }
  });
});
