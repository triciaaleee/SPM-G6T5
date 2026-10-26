import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";
import { COORD, STAFF, appWith, bearer } from "./helpers/app.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { from: (t: string) => h.db.from(t) } }));
const ev = vi.hoisted(() => ({ fetchVenueBookingInfo: vi.fn() }));
vi.mock("../lib/eventsClient.js", async (orig) => ({ ...(await orig<typeof import("../lib/eventsClient.js")>()), ...ev }));
const dec = vi.hoisted(() => ({ decideBooking: vi.fn(), expireLapsedHolds: vi.fn() }));
vi.mock("../lib/bookingDecisions.js", async (orig) => ({ ...(await orig<typeof import("../lib/bookingDecisions.js")>()), ...dec }));
const rec = vi.hoisted(() => ({ reconcileBufferOverlaps: vi.fn() }));
vi.mock("../lib/bufferOverlapReview.js", async (orig) => ({ ...(await orig<typeof import("../lib/bufferOverlapReview.js")>()), ...rec }));

import { staffRouter } from "../routes/staff.js";

const app = appWith("/s", staffRouter);
const published: any[] = [];
let publishOk = true;

const venueRow = (id = 1, o: Record<string, unknown> = {}) => ({
  id, name: `Hall ${id}`, location: "North", description: "d", capacity: 100, accessibility: ["Ramp"], layouts: ["Theatre"], facilities: ["Projector"],
  setup_minutes: 15, turnaround_minutes: 20, opening_time: "08:00:00", closing_time: "22:00:00", status: "Available", staff_id: "VEN-0001", ...o,
});
const info = (id: number, o: Record<string, unknown> = {}) => ({
  id, status: "Planning", name: `Event ${id}`, coordinatorId: `COORD-${id}`, proposedDate: "2026-09-20", startTime: "10:00", endTime: "12:00",
  expectedAttendance: 80, venue: "Theatre layout with a projector", accessibility: null, equipment: null, technicalSupport: null, ...o,
});
const form = (o: Record<string, unknown> = {}) => ({
  name: "New Hall", location: "South", description: "Nice", capacity: 60, setupMinutes: 10, turnaroundMinutes: 5, openingTime: "08:00", closingTime: "20:00",
  layouts: ["Theatre"], facilities: ["Projector"], accessibility: ["Ramp"], ...o,
});

beforeEach(() => {
  // "today" decides which bookings are future ones, so pin the date (only Date, so I/O still runs)
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 14, 8, 0));
  h.db = createFakeDb({ venues: [venueRow(1), venueRow(2, { staff_id: "VEN-0002", name: "Other" })] });
  published.length = 0;
  publishOk = true;
  setPublisherForTest({ publish: async (m) => { published.push(m); return publishOk; } });
  ev.fetchVenueBookingInfo.mockReset().mockResolvedValue({ status: "ok", events: [] });
  dec.decideBooking.mockReset();
  dec.expireLapsedHolds.mockReset().mockResolvedValue(undefined);
  rec.reconcileBufferOverlaps.mockReset().mockResolvedValue({ inserted: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.useRealTimers());

const get = (path: string, auth = STAFF) => request(app).get(`/s${path}`).set("Authorization", auth);
const post = (path: string, body: unknown = {}, auth = STAFF) => request(app).post(`/s${path}`).set("Authorization", auth).send(body as object);
const patch = (path: string, body: unknown = {}, auth = STAFF) => request(app).patch(`/s${path}`).set("Authorization", auth).send(body as object);

describe("access", () => {
  it.each([["get", "/venues"], ["get", "/venue-options"], ["get", "/my-venues"], ["post", "/venues"], ["patch", "/venues/1"], ["get", "/requests"], ["get", "/1/bookings"], ["post", "/bookings/1/approve"], ["get", "/venues/1/buffer-overlaps"]] as const)("%s %s needs login and the venue_staff role", async (method, path) => {
    expect((await request(app)[method](`/s${path}`)).status).toBe(401);
    for (const auth of [COORD, bearer("ORG-1", "organiser"), bearer("A-1", "attendee")]) {
      const res = await request(app)[method](`/s${path}`).set("Authorization", auth);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only venue staff can view venue schedules" });
    }
  });
});

describe("venue pickers", () => {
  it("GET /venues lists Available venues by name, as id+name only", async () => {
    h.db.rows("venues").push(venueRow(3, { name: "Aardvark", status: "Unavailable" }), venueRow(4, { name: "Aaa" }));
    const res = await get("/venues");
    expect(res.body).toEqual({ venues: [{ id: 4, name: "Aaa" }, { id: 1, name: "Hall 1" }, { id: 2, name: "Other" }].map((v) => ({ id: v.id, name: v.name })) });
    expect(Object.keys(res.body.venues[0]).sort()).toEqual(["id", "name"].sort());
  });
  it("GET /venues → 500 on failure; empty list is fine", async () => {
    h.db.failOn("venues", "select");
    const res = await get("/venues");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load venues" });
    h.db = createFakeDb();
    expect((await get("/venues")).body).toEqual({ venues: [] });
  });
  it("GET /venue-options merges catalogue and existing values", async () => {
    const res = await get("/venue-options");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["accessibility", "facilities", "layouts", "locations"]);
    expect(res.body.locations).toContain("North");
    expect(res.body.facilities).toContain("Projector");
  });
  it("GET /venue-options → 500 on failure", async () => {
    h.db.failOn("venues", "select");
    const res = await get("/venue-options");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load venue options" });
  });
  it("GET /my-venues returns only the caller's venues, in full form, ordered by name", async () => {
    h.db.rows("venues").push(venueRow(5, { name: "A First", opening_time: null, closing_time: null, setup_minutes: null, turnaround_minutes: null, description: null }));
    const res = await get("/my-venues");
    expect(res.body.venues.map((v: any) => v.name)).toEqual(["A First", "Hall 1"]);
    expect(res.body.venues[0]).toEqual({
      id: 5, name: "A First", location: "North", description: "", capacity: 100, accessibility: ["Ramp"], layouts: ["Theatre"], facilities: ["Projector"],
      setupMinutes: 0, turnaroundMinutes: 0, openingTime: "08:00", closingTime: "22:00", status: "Available",
    });
    expect(res.body.venues[1]).toMatchObject({ openingTime: "08:00", closingTime: "22:00", setupMinutes: 15 });
  });
  it("GET /my-venues → 500 on failure", async () => {
    h.db.failOn("venues", "select");
    expect((await get("/my-venues")).body).toEqual({ error: "Failed to load your venues" });
  });
});

describe("POST /venues (E4-1)", () => {
  it("rejects incomplete input, naming what is missing, writing nothing", async () => {
    const res = await post("/venues", form({ name: "", capacity: "" }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required details: name, maximum capacity");
    expect(res.body.missing).toEqual(["name", "maximum capacity"]);
    expect(res.body.fields).toMatchObject({ name: "Enter the venue's name.", capacity: "Enter the maximum capacity." });
    expect(h.db.rows("venues")).toHaveLength(2);
  });
  it("rejects invalid-but-present values with the generic message", async () => {
    const res = await post("/venues", form({ capacity: 0 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Some venue details are invalid");
    expect(res.body.missing).toEqual([]);
  });
  it("creates an Available, active venue owned by the caller and returns it in form shape", async () => {
    const res = await post("/venues", form());
    expect(res.status).toBe(201);
    expect(res.body.venue).toMatchObject({ id: 3, name: "New Hall", capacity: 60, setupMinutes: 10, turnaroundMinutes: 5, openingTime: "08:00", closingTime: "20:00", status: "Available" });
    expect(h.db.rows("venues")[2]).toMatchObject({ status: "Available", active: true, staff_id: "VEN-0001", setup_minutes: 10, turnaround_minutes: 5, opening_time: "08:00", closing_time: "20:00" });
  });
  it("500s when the insert fails", async () => {
    h.db.failOn("venues", "insert");
    const res = await post("/venues", form());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to add the venue" });
    expect(h.db.rows("venues")).toHaveLength(2);
  });
});

describe("venue edit: preview and save", () => {
  const live = (rows: any[], events: any[]) => {
    h.db.tables.venue_bookings = rows;
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events });
  };
  const approved = (id: number, event_id: number) => ({ id, venue_id: 1, event_id, status: "Approved", hold_expires_at: null, headcount: null });

  describe.each([["preview", (id: string, b: unknown) => post(`/venues/${id}/preview`, b)], ["save", (id: string, b: unknown) => patch(`/venues/${id}`, b)]] as const)("%s validation", (_n, send) => {
    it.each(["0", "abc", "-1", "01", "1.5"])("rejects venue id %j", async (id) => {
      const res = await send(id, form());
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid venue id" });
    });
    it("rejects invalid input before touching the database", async () => {
      const res = await send("1", form({ name: "" }));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Missing required details: name");
      expect(h.db.calls).toHaveLength(0);
    });
    it("404s an unknown venue, 403s someone else's, 500s when the load fails", async () => {
      expect((await send("99", form())).body).toEqual({ error: "Venue not found" });
      const forbidden = await send("2", form());
      expect(forbidden.status).toBe(403);
      expect(forbidden.body).toEqual({ error: "You are not assigned to this venue" });
      h.db.failOn("venues", "select");
      const res = await send("1", form());
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Failed to load the venue" });
    });
    it("502s when the venue's bookings cannot be checked", async () => {
      h.db.failOn("venue_bookings", "select");
      const res = await send("1", form());
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Failed to check this venue's bookings" });
    });
  });

  it("preview reports capacity shortfalls and new setup overlaps without writing", async () => {
    live([approved(1, 5), approved(2, 6)], [info(5, { expectedAttendance: 90 }), info(6, { startTime: "13:00", endTime: "15:00", expectedAttendance: 10 })]);
    const res = await post("/venues/1/preview", form({ capacity: 50, setupMinutes: 15, turnaroundMinutes: 90 }));
    expect(res.status).toBe(200);
    expect(res.body.capacityShortfalls).toEqual([
      { bookingId: 1, eventId: 5, eventName: "Event 5", date: "2026-09-20", expectedAttendance: 90, hasCoordinator: true },
    ]);
    expect(res.body.bufferOverlaps).toHaveLength(1);
    expect(res.body.bufferOverlaps[0].first).toMatchObject({ bookingId: 1, hasCoordinator: true });
    expect(JSON.stringify(res.body)).not.toContain("COORD-");
    expect(h.db.writes("venues")).toHaveLength(0);
    expect(published).toEqual([]);
  });
  it("preview with nothing booked reports no impact", async () => {
    const res = await post("/venues/1/preview", form());
    expect(res.body).toEqual({ capacityShortfalls: [], bufferOverlaps: [] });
  });

  it("save writes the new values, notifies coordinators of the impact and reports the count", async () => {
    live([approved(1, 5), approved(2, 6)], [info(5, { expectedAttendance: 90 }), info(6, { startTime: "13:00", endTime: "15:00", expectedAttendance: 10 })]);
    const res = await patch("/venues/1", form({ name: "Renamed", capacity: 50, setupMinutes: 15, turnaroundMinutes: 90 }));
    expect(res.status).toBe(200);
    expect(h.db.rows("venues")[0]).toMatchObject({ name: "Renamed", capacity: 50, setup_minutes: 15, turnaround_minutes: 90, opening_time: "08:00", closing_time: "20:00" });
    expect(h.db.rows("venues")[0].staff_id).toBe("VEN-0001");
    expect(res.body.venue).toMatchObject({ id: 1, name: "Renamed", capacity: 50 });
    expect(res.body.capacityShortfalls).toHaveLength(1);
    expect(published.map((m) => m.type)).toEqual(["venue.capacity_reduced", "booking.setup_conflict", "booking.setup_conflict", "booking.setup_conflict"]);
    expect(res.body.coordinatorsNotified).toBe(3); // C5, C6, staff
    expect(res.body.notificationsFailed).toBe(false);
    expect(rec.reconcileBufferOverlaps).toHaveBeenCalledWith(expect.anything(), 1, STAFF);
  });
  it("save with no impact sends nothing and reports 0 notified", async () => {
    const res = await patch("/venues/1", form());
    expect(res.status).toBe(200);
    expect(published).toEqual([]);
    expect(res.body).toMatchObject({ coordinatorsNotified: 0, notificationsFailed: false });
  });
  it("a failed broker is reported, not fatal", async () => {
    live([approved(1, 5)], [info(5, { expectedAttendance: 90 })]);
    publishOk = false;
    const res = await patch("/venues/1", form({ capacity: 50 }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ coordinatorsNotified: 0, notificationsFailed: true });
    expect(h.db.rows("venues")[0].capacity).toBe(50);
  });
  it("a failing reconciliation is logged and never changes the response", async () => {
    rec.reconcileBufferOverlaps.mockRejectedValue(new Error("boom"));
    const res = await patch("/venues/1", form());
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith("[buffer-overlap-review] reconciliation failed for venue 1", expect.any(Error));
  });
  it("500s and keeps the old values when the update fails", async () => {
    h.db.failOn("venues", "update");
    const res = await patch("/venues/1", form({ capacity: 5 }));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to update the venue" });
    expect(h.db.rows("venues")[0].capacity).toBe(100);
    expect(published).toEqual([]);
  });
});

describe("GET /venues/:venueId/buffer-overlaps", () => {
  it.each(["0", "x", "-3"])("rejects id %j", async (id) => {
    expect((await get(`/venues/${id}/buffer-overlaps`)).body).toEqual({ error: "Invalid venue id" });
  });
  it("404 unknown, 403 not assigned, 500 on load failure", async () => {
    expect((await get("/venues/99/buffer-overlaps")).status).toBe(404);
    const forbidden = await get("/venues/2/buffer-overlaps");
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ error: "You are not assigned to this venue" });
    h.db.failOn("venues", "select");
    const res = await get("/venues/1/buffer-overlaps");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the venue" });
  });
  it("reconciles first, then lists oldest first with event names where known", async () => {
    h.db.tables.venue_buffer_overlaps = [
      { id: 2, venue_id: 1, booking_id_a: 3, booking_id_b: 4, window_a: "wc", window_b: "wd", detected_at: "2026-09-02" },
      { id: 1, venue_id: 1, booking_id_a: 1, booking_id_b: 2, window_a: "wa", window_b: "wb", detected_at: "2026-09-01" },
      { id: 3, venue_id: 2, booking_id_a: 1, booking_id_b: 2, window_a: "x", window_b: "y", detected_at: "2026-09-01" },
    ];
    h.db.tables.venue_bookings = [{ id: 1, event_id: 5 }, { id: 2, event_id: 6 }, { id: 3, event_id: 7 }];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events: [info(5), info(6)] });
    const res = await get("/venues/1/buffer-overlaps");
    expect(res.status).toBe(200);
    expect(rec.reconcileBufferOverlaps).toHaveBeenCalledWith(expect.anything(), 1, STAFF);
    expect(res.body.overlaps).toEqual([
      { id: 1, detectedAt: "2026-09-01", first: { bookingId: 1, eventId: 5, eventName: "Event 5", window: "wa" }, second: { bookingId: 2, eventId: 6, eventName: "Event 6", window: "wb" } },
      { id: 2, detectedAt: "2026-09-02", first: { bookingId: 3, eventId: 7, eventName: null, window: "wc" }, second: { bookingId: 4, eventId: null, eventName: null, window: "wd" } },
    ]);
  });
  it("still lists the pairs (without names) when events-service is down, and when reconciliation throws", async () => {
    h.db.tables.venue_buffer_overlaps = [{ id: 1, venue_id: 1, booking_id_a: 1, booking_id_b: 2, window_a: "wa", window_b: "wb", detected_at: "d" }];
    h.db.tables.venue_bookings = [{ id: 1, event_id: 5 }, { id: 2, event_id: 6 }];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    rec.reconcileBufferOverlaps.mockRejectedValue(new Error("x"));
    const res = await get("/venues/1/buffer-overlaps");
    expect(res.status).toBe(200);
    expect(res.body.overlaps[0].first).toEqual({ bookingId: 1, eventId: 5, eventName: null, window: "wa" });
    expect(console.error).toHaveBeenCalledWith("[buffer-overlap-review] reconciliation failed for venue 1", expect.any(Error));
  });
  it("an empty list is fine", async () => {
    expect((await get("/venues/1/buffer-overlaps")).body).toEqual({ overlaps: [] });
  });
  it("500 when the overlaps or their bookings cannot be read", async () => {
    h.db.failOn("venue_buffer_overlaps", "select");
    expect((await get("/venues/1/buffer-overlaps")).body).toEqual({ error: "Failed to load flagged bookings" });
    h.db.clearFailures();
    h.db.tables.venue_buffer_overlaps = [{ id: 1, venue_id: 1, booking_id_a: 1, booking_id_b: 2, window_a: "a", window_b: "b", detected_at: "d" }];
    h.db.failOn("venue_bookings", "select");
    const res = await get("/venues/1/buffer-overlaps");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load flagged bookings" });
  });
});

describe("GET /:venueId/bookings (schedule)", () => {
  const bookings = () => {
    h.db.tables.venue_bookings = [
      { id: 1, venue_id: 1, event_id: 5, status: "Approved" },
      { id: 2, venue_id: 1, event_id: 6, status: "Requested", purpose: "Breakout", headcount: 20, required_layouts: ["Cabaret"], required_facilities: [], required_accessibility: ["Ramp"] },
      { id: 3, venue_id: 1, event_id: 7, status: "Approved" },
      { id: 4, venue_id: 1, event_id: 8, status: "Approved" },
      { id: 5, venue_id: 2, event_id: 5, status: "Approved" },
    ];
    ev.fetchVenueBookingInfo.mockResolvedValue({
      status: "ok",
      events: [info(5, { startTime: "14:00", endTime: "16:00" }), info(6, { startTime: "09:00", endTime: "10:00", expectedAttendance: 30 }), info(7, { proposedDate: "2026-10-30" }), info(8, { proposedDate: null })],
    });
  };

  it.each(["0", "abc", "-1", "01"])("rejects venue id %j", async (id) => {
    expect((await get(`/${id}/bookings`)).body).toEqual({ error: "Invalid venue id" });
  });
  it("validates the date range, naming each bad field", async () => {
    const fields = async (q: string) => (await get(`/1/bookings${q}`)).body.fields;
    expect(await fields("?from=2026-09-01")).toEqual({ to: "Enter a valid date (YYYY-MM-DD)." });
    expect(await fields("?to=2026-09-01")).toEqual({ from: "Enter a valid date (YYYY-MM-DD)." });
    expect(await fields("?from=2026-02-30&to=2026-03-01")).toEqual({ from: "Enter a valid date (YYYY-MM-DD)." });
    expect(await fields("?from=2026-09-02&to=2026-09-01")).toEqual({ to: "The end date must not be before the start date." });
    expect(await fields("?from=2026-09-01&to=2026-10-13")).toEqual({ to: "The range can cover at most 42 days." });
    expect((await get("/1/bookings?from=2026-09-01&to=2026-10-12")).status).toBe(200);
    expect((await get("/1/bookings?from=2026-09-01&to=2026-09-01")).status).toBe(200);
    expect((await get("/1/bookings?from=x&to=y")).body.error).toBe("Invalid date range");
  });
  it("404 for an unknown or unavailable venue; 500 on load failures; 502 when events are unavailable", async () => {
    expect((await get("/99/bookings")).body).toEqual({ error: "Venue not found" });
    h.db.rows("venues")[0].status = "Unavailable";
    expect((await get("/1/bookings")).status).toBe(404);
    h.db.rows("venues")[0].status = "Available";
    h.db.failOn("venues", "select");
    expect((await get("/1/bookings")).body).toEqual({ error: "Failed to load the venue" });
    h.db.clearFailures();
    h.db.failOn("venue_bookings", "select");
    expect((await get("/1/bookings")).body).toEqual({ error: "Failed to load bookings" });
    h.db.clearFailures();
    bookings();
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    const res = await get("/1/bookings");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the booked events" });
  });
  it("with no range lists every dated booking of this venue, earliest first, with its setup", async () => {
    bookings();
    const res = await get("/1/bookings");
    expect(res.status).toBe(200);
    expect(res.body.venue).toEqual({ id: 1, name: "Hall 1" });
    expect(res.body.bookings.map((b: any) => [b.id, b.date, b.startTime, b.endTime])).toEqual([
      [2, "2026-09-20", "09:00", "10:00"],
      [1, "2026-09-20", "14:00", "16:00"],
      [3, "2026-10-30", "10:00", "12:00"],
    ]);
    expect(res.body.bookings[0]).toMatchObject({
      status: "Requested", kind: "event",
      event: { id: 6, name: "Event 6", expectedAttendance: 30, layouts: ["Theatre"], facilities: ["Projector"] },
      setup: { purpose: "Breakout", headcount: 20, layouts: ["Cabaret"], facilities: [], accessibility: ["Ramp"] },
    });
    expect(res.body.bookings[1].setup).toEqual({ purpose: "Main programme", headcount: 80, layouts: ["Theatre"], facilities: ["Projector"], accessibility: [] });
    expect(ev.fetchVenueBookingInfo.mock.calls[0][0]).toEqual([5, 6, 7, 8]);
  });
  it("a range includes both edge dates and excludes the days either side", async () => {
    bookings();
    const inRange = async (from: string, to: string) => (await get(`/1/bookings?from=${from}&to=${to}`)).body.bookings.map((b: any) => b.id);
    expect(await inRange("2026-09-20", "2026-09-20")).toEqual([2, 1]);
    expect(await inRange("2026-09-21", "2026-10-30")).toEqual([3]);
    expect(await inRange("2026-09-01", "2026-09-19")).toEqual([]);
    expect(await inRange("2026-10-01", "2026-10-30")).toEqual([3]);
    expect(await inRange("2026-10-01", "2026-10-29")).toEqual([]);
  });
  it("treats missing times as empty strings and a pre-plan booking as the whole event", async () => {
    h.db.tables.venue_bookings = [{ id: 1, venue_id: 1, event_id: 5, status: "Approved" }];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events: [info(5, { startTime: null, endTime: null, expectedAttendance: null })] });
    const res = await get("/1/bookings");
    expect(res.body.bookings[0]).toMatchObject({ startTime: "", endTime: "", setup: { headcount: null } });
  });
  it("a venue with no bookings returns an empty list without calling events-service for names", async () => {
    expect((await get("/1/bookings")).body.bookings).toEqual([]);
  });
});

describe("GET /requests (decision queue)", () => {
  const seed = (rows: any[], events: any[]) => {
    h.db.tables.venue_bookings = rows;
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events });
  };
  const pend = (id: number, event_id: number, o: Record<string, unknown> = {}) => ({
    id, venue_id: 1, event_id, status: "Requested", hold_expires_at: null, decision_reason: null, decided_by: null, decided_at: null, ...o,
  });

  it("[] when the caller looks after no venues, without reading bookings", async () => {
    const res = await get("/requests", bearer("VEN-0099", "venue_staff"));
    expect(res.body).toEqual({ requests: [] });
    expect(h.db.calls.some((c) => c.table === "venue_bookings")).toBe(false);
  });
  it("500s when assignments, bookings or venues cannot be read", async () => {
    h.db.failOn("venues", "select", 1);
    expect((await get("/requests")).body).toEqual({ error: "Failed to load your venues" });
    h.db.clearFailures();
    h.db.failOn("venue_bookings", "select");
    expect((await get("/requests")).body).toEqual({ error: "Failed to load booking requests" });
    h.db.clearFailures();
    h.db.failOn("venues", "select", -1, (c) => c.filters.some((f) => f.kind === "in"));
    expect((await get("/requests")).body).toEqual({ error: "Failed to load your venues" });
  });
  it("502 when the queued events cannot be loaded", async () => {
    h.db.tables.venue_bookings = [pend(1, 5)];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    const res = await get("/requests");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the requested events" });
  });
  it("lists only this staff member's pending bookings, earliest event first, with venue and event details", async () => {
    seed(
      [pend(1, 5), pend(2, 6, { status: "On Hold", hold_expires_at: "2099-01-01T00:00:00Z" }), pend(3, 7), pend(4, 8, { status: "Approved" }), pend(5, 9, { venue_id: 2 }), pend(6, 10)],
      [info(5, { proposedDate: "2026-09-21", startTime: "09:00" }), info(6, { proposedDate: "2026-09-20", startTime: "15:00" }), info(7, { proposedDate: "2026-09-20", startTime: "08:00" }), info(10, { proposedDate: null, startTime: null })],
    );
    const res = await get("/requests");
    expect(res.status).toBe(200);
    // undated event first (empty string sorts lowest), then by date and start time
    expect(res.body.requests.map((r: any) => r.id)).toEqual([6, 3, 2, 1]);
    expect(res.body.requests[2]).toEqual({
      id: 2, status: "On Hold", holdExpiresAt: "2099-01-01T00:00:00Z",
      venue: { id: 1, name: "Hall 1", location: "North", setupMinutes: 15, turnaroundMinutes: 20 },
      event: { id: 6, name: "Event 6", date: "2026-09-20", startTime: "15:00", endTime: "12:00", expectedAttendance: 80, layouts: ["Theatre"], facilities: ["Projector"] },
      setup: { purpose: "Main programme", headcount: 80, layouts: ["Theatre"], facilities: ["Projector"], accessibility: [] },
    });
    expect(ev.fetchVenueBookingInfo.mock.calls[0][0]).toEqual([5, 6, 7, 10]);
  });
  it("sweeps lapsed holds to Expired first and leaves them out; an On Hold with time left or no expiry stays", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    seed(
      [pend(1, 5, { status: "On Hold", hold_expires_at: past }), pend(2, 6, { status: "On Hold", hold_expires_at: new Date(Date.now() + 60_000).toISOString() }), pend(3, 7, { status: "On Hold", hold_expires_at: null }), pend(4, 8)],
      [info(5), info(6), info(7), info(8)],
    );
    const res = await get("/requests");
    expect(res.body.requests.map((r: any) => r.id)).toEqual([2, 3, 4]);
    expect(dec.expireLapsedHolds).toHaveBeenCalledTimes(1);
    const [, lapsed, venues, auth] = dec.expireLapsedHolds.mock.calls[0];
    expect(lapsed.map((b: any) => b.id)).toEqual([1]);
    expect(venues.get(1)).toMatchObject({ id: 1, name: "Hall 1" });
    expect(auth).toBe(STAFF);
    expect(ev.fetchVenueBookingInfo.mock.calls[0][0]).toEqual([6, 7, 8]);
  });
  it("drops bookings whose event or venue is no longer there", async () => {
    seed([pend(1, 5), pend(2, 6)], [info(5)]);
    expect((await get("/requests")).body.requests.map((r: any) => r.id)).toEqual([1]);
  });
  it("defaults missing venue buffers to 0 in the response", async () => {
    h.db.rows("venues")[0].setup_minutes = null;
    h.db.rows("venues")[0].turnaround_minutes = null;
    seed([pend(1, 5)], [info(5)]);
    expect((await get("/requests")).body.requests[0].venue).toMatchObject({ setupMinutes: 0, turnaroundMinutes: 0 });
  });
});

describe("booking decisions (hold / approve / reject)", () => {
  const okResult = {
    status: "ok",
    booking: { id: 7, status: "Approved", hold_expires_at: null, decision_reason: "r", decided_at: "2026-09-14T08:00:00Z", venue_id: 1, event_id: 5, decided_by: "VEN-0001" },
    venue: { id: 1, name: "Hall 1", location: "North", setup_minutes: 15, turnaround_minutes: 20 },
    autoRejectedIds: [8, 9], coordinatorsNotified: 3, notificationsFailed: false,
  };
  const actions = [["hold", "On Hold"], ["approve", "Approved"], ["reject", "Rejected"]] as const;

  it.each(["0", "abc", "-1", "01", "1.5"])("rejects booking id %j", async (id) => {
    const res = await post(`/bookings/${id}/approve`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid booking id" });
    expect(dec.decideBooking).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "   ", 5, null])("a rejection needs a real reason (%j)", async (reason) => {
    const res = await post("/bookings/7/reject", { reason });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A reason is required", fields: { reason: "Give a reason for rejecting this request." } });
    expect(dec.decideBooking).not.toHaveBeenCalled();
  });
  it("a rejection with no body at all is refused the same way", async () => {
    expect((await request(app).post("/s/bookings/7/reject").set("Authorization", STAFF)).status).toBe(400);
  });
  it("hold and approve need no reason", async () => {
    dec.decideBooking.mockResolvedValue(okResult);
    expect((await post("/bookings/7/hold")).status).toBe(200);
    expect((await post("/bookings/7/approve")).status).toBe(200);
  });
  it.each(actions)("%s passes the right decision, ids, token and reason to the decision logic", async (path, decision) => {
    dec.decideBooking.mockResolvedValue(okResult);
    await post(`/bookings/7/${path}`, { reason: "  because  " });
    expect(dec.decideBooking).toHaveBeenCalledWith(expect.anything(), { bookingId: 7, decision, staffId: "VEN-0001", authorization: STAFF, reason: "  because  " });
  });
  it("hold/approve without a body send an empty reason", async () => {
    dec.decideBooking.mockResolvedValue(okResult);
    await post("/bookings/7/approve");
    expect(dec.decideBooking.mock.calls[0][1].reason).toBe("");
  });
  it("returns the decision, the venue, the auto-rejected ids and the notification outcome", async () => {
    dec.decideBooking.mockResolvedValue(okResult);
    const res = await post("/bookings/7/approve");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      booking: { id: 7, status: "Approved", holdExpiresAt: null, decisionReason: "r", decidedAt: "2026-09-14T08:00:00Z", venue: { id: 1, name: "Hall 1", location: "North" } },
      autoRejectedBookingIds: [8, 9], coordinatorsNotified: 3, notificationsFailed: false,
    });
  });
  it.each([
    [{ status: "not_found" }, 404, { error: "Booking not found" }],
    [{ status: "not_assigned" }, 403, { error: "You are not assigned to this venue" }],
    [{ status: "blocked", message: "Nope" }, 409, { error: "Nope" }],
    [{ status: "conflict", message: "Taken", conflict: { bookingId: 2 } }, 409, { error: "Taken", conflict: { bookingId: 2 } }],
    [{ status: "event_error" }, 502, { error: "Failed to load the booked event" }],
    [{ status: "error" }, 500, { error: "Failed to update the booking" }],
  ])("maps %j to HTTP %i", async (result, code, body) => {
    dec.decideBooking.mockResolvedValue(result);
    const res = await post("/bookings/7/approve");
    expect(res.status).toBe(code);
    expect(res.body).toEqual(body);
  });
});

describe("mutation-run follow-ups", () => {
  const pending = (id: number, event_id: number) => ({
    id, venue_id: 1, event_id, status: "Requested", hold_expires_at: null, decision_reason: null, decided_by: null, decided_at: null,
  });

  it("the schedule reads the event's free text against the venue's own feature names, and trims HH:MM:SS to HH:MM", async () => {
    h.db.rows("venues")[0].facilities = ["Projector", "Karaoke machine"];
    h.db.tables.venue_bookings = [{ id: 1, venue_id: 1, event_id: 5, status: "Approved" }];
    ev.fetchVenueBookingInfo.mockResolvedValue({
      status: "ok",
      events: [info(5, { startTime: "09:30:15", endTime: "11:45:59", venue: "Theatre layout with a projector and a karaoke machine" })],
    });

    const res = await get("/1/bookings");

    expect(res.body.bookings).toHaveLength(1);
    const [booking] = res.body.bookings;
    expect(booking.startTime).toBe("09:30");
    expect(booking.endTime).toBe("11:45");
    expect(booking.event.facilities).toEqual(["Projector", "Karaoke machine"]);
    expect(booking.setup.facilities).toEqual(["Projector", "Karaoke machine"]);
  });

  it("the decision queue does the same", async () => {
    h.db.rows("venues")[0].facilities = ["Projector", "Karaoke machine"];
    h.db.tables.venue_bookings = [pending(1, 5)];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events: [info(5, { venue: "a karaoke machine, please" })] });

    const [request] = (await get("/requests")).body.requests;

    expect(request.event.facilities).toEqual(["Karaoke machine"]);
    expect(request.setup.facilities).toEqual(["Karaoke machine"]);
  });

  it("answers 404 with a message for a venue that is not there", async () => {
    const res = await get("/venues/99/buffer-overlaps");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Venue not found" });
  });

  it("a database that answers with no row and no error is still a failed save", async () => {
    h.db.nullOn("venues", "insert");
    const added = await post("/venues", form());
    expect(added.status).toBe(500);
    expect(added.body).toEqual({ error: "Failed to add the venue" });

    h.db.clearFailures();
    h.db.nullOn("venues", "update");
    const saved = await patch("/venues/1", form());
    expect(saved.status).toBe(500);
    expect(saved.body).toEqual({ error: "Failed to update the venue" });
  });
});
