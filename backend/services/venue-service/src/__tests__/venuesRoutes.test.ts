import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";
import { ATTENDEE, COORD, ORGANISER, STAFF, appWith } from "./helpers/app.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { from: (t: string) => h.db.from(t) } }));
const ev = vi.hoisted(() => ({ fetchEvent: vi.fn(), fetchVenueBookingInfo: vi.fn() }));
vi.mock("../lib/eventsClient.js", async (orig) => ({ ...(await orig<typeof import("../lib/eventsClient.js")>()), ...ev }));
const wd = vi.hoisted(() => ({ withdrawBooking: vi.fn() }));
vi.mock("../lib/bookingWithdrawal.js", async (orig) => ({ ...(await orig<typeof import("../lib/bookingWithdrawal.js")>()), ...wd }));

import { venuesRouter } from "../routes/venues.js";

const app = appWith("/v", venuesRouter);
const published: any[] = [];
let publishOk = true;
const COORD_ID = "COORD-0001";

const venue = (id: number, o: Record<string, unknown> = {}) => ({
  id, name: `Venue ${id}`, location: "North", description: "d", capacity: 100, accessibility: ["Ramp"], layouts: ["Theatre"], facilities: ["Projector"],
  setup_minutes: 30, turnaround_minutes: 30, status: "Available", active: true, staff_id: "VEN-0001", opening_time: "08:00:00", closing_time: "22:00:00", ...o,
});
const details = (o: Record<string, unknown> = {}) => ({ name: "Gala", proposedDate: "2026-09-20", startTime: "10:00", endTime: "12:00", expectedAttendance: 80, venue: "", ...o });
const event = (o: Record<string, unknown> = {}, d: Record<string, unknown> = {}) => ({ id: 7, status: "Planning", coordinator_id: COORD_ID, submitted_details: details(d), ...o });
const info = (id: number, o: Record<string, unknown> = {}) => ({ id, status: "Planning", name: `Event ${id}`, coordinatorId: `C-${id}`, proposedDate: "2026-09-20", startTime: "10:00", endTime: "12:00", expectedAttendance: 10, venue: null, accessibility: null, equipment: null, technicalSupport: null, ...o });
const bk = (id: number, o: Record<string, unknown> = {}) => ({ id, venue_id: 1, event_id: 100 + id, status: "Approved", hold_expires_at: null, ...o });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-14T08:00:00.000Z")); // UTC, so the suite does not depend on the machine timezone
  h.db = createFakeDb({ venues: [venue(1), venue(2, { capacity: 300 })] });
  published.length = 0;
  publishOk = true;
  setPublisherForTest({ publish: async (m) => { published.push(m); return publishOk; } });
  ev.fetchEvent.mockReset().mockResolvedValue({ status: "ok", event: event() });
  ev.fetchVenueBookingInfo.mockReset().mockResolvedValue({ status: "ok", events: [] });
  wd.withdrawBooking.mockReset();
});
afterEach(() => vi.useRealTimers());

const get = (path: string, auth = COORD) => request(app).get(`/v${path}`).set("Authorization", auth);
const post = (path: string, body: unknown = {}, auth = COORD) => request(app).post(`/v${path}`).set("Authorization", auth).send(body as object);
const events = (list: any[]) => ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events: list });
const row = (id: number) => h.db.rows("venue_bookings").find((r) => r.id === id)!;

describe("access", () => {
  it.each([["get", "/"], ["get", "/filters"], ["get", "/recommendations/7"], ["get", "/1/availability"], ["get", "/bookings/1/availability-check"], ["post", "/bookings"], ["post", "/bookings/1/withdraw"], ["post", "/bookings/1/release"], ["post", "/bookings/1/flag-for-rebooking"]] as const)("%s %s: 401 without login, 403 for non-coordinators", async (method, path) => {
    expect((await request(app)[method](`/v${path}`)).status).toBe(401);
    for (const auth of [STAFF, ORGANISER, ATTENDEE]) {
      const res = await request(app)[method](`/v${path}`).set("Authorization", auth);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only coordinators can search venues" });
    }
  });
});

describe("GET /filters", () => {
  it("derives the options (and capacity range) from Available venues only", async () => {
    h.db.rows("venues").push(venue(3, { status: "Unavailable", location: "Hidden", capacity: 9999, layouts: ["Secret layout"] }));
    const res = await get("/filters");
    expect(res.status).toBe(200);
    expect(res.body.locations).toEqual(["North"]);
    expect(res.body.layouts).not.toContain("Secret layout");
    expect(res.body.capacity).toEqual({ min: 100, max: 300 });
  });
  it("capacity is null with no venues; 500 when the lookup fails", async () => {
    h.db = createFakeDb();
    expect((await get("/filters")).body.capacity).toBeNull();
    h.db.failOn("venues", "select");
    const res = await get("/filters");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load venue filters" });
  });
});

describe("GET / (search)", () => {
  it("returns every Available venue, smallest capacity first, with only the public columns", async () => {
    h.db.rows("venues").push(venue(3, { status: "Unavailable" }));
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.body.venues.map((v: any) => v.id)).toEqual([1, 2]);
    expect(res.body.relax).toEqual([]);
    expect(Object.keys(res.body.venues[0]).sort()).toEqual(["accessibility", "capacity", "description", "facilities", "id", "layouts", "location", "name", "setup_minutes", "turnaround_minutes"]);
    expect(ev.fetchVenueBookingInfo).not.toHaveBeenCalled(); // no date → no availability work
  });
  it("rejects an invalid search naming the fields", async () => {
    const res = await get("/?capacityMin=0&date=2026-02-30");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid search", fields: { capacityMin: "Must be a whole number greater than 0", date: "Date must be a valid date (YYYY-MM-DD)" } });
  });
  it("filters by capacity, text and features, and offers what to relax when nothing matches", async () => {
    expect((await get("/?capacityMin=200")).body.venues.map((v: any) => v.id)).toEqual([2]);
    expect((await get("/?capacityMax=100")).body.venues.map((v: any) => v.id)).toEqual([1]);
    expect((await get("/?q=venue 2")).body.venues.map((v: any) => v.id)).toEqual([2]);
    const none = await get("/?capacityMin=200&facilities=Stage");
    expect(none.body.venues).toEqual([]);
    // dropping "capacity" still leaves no Stage venue (count 0, hidden); dropping "facilities" finds venue 2
    expect(none.body.relax).toEqual([{ key: "facilities", label: "Facilities", count: 1 }]);
  });
  it("500 when venues cannot be loaded", async () => {
    h.db.failOn("venues", "select");
    const res = await get("/");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to search venues" });
  });

  describe("by date and time", () => {
    const q = "/?date=2026-09-20&startTime=10:00&endTime=12:00";
    const ids = async (path = q) => (await get(path)).body.venues.map((v: any) => v.id);

    it("excludes a venue with an overlapping Approved booking, using each venue's own padding", async () => {
      h.db.tables.venue_bookings = [bk(1, { venue_id: 1 })];
      events([info(101)]);
      expect(await ids()).toEqual([2]);
    });
    it("an unexpired hold excludes; a lapsed hold, a Requested and a Rejected booking do not", async () => {
      for (const [status, hold, expectBlocked] of [["On Hold", "2026-09-15T00:00:00Z", true], ["On Hold", "2026-09-14T07:59:00Z", false], ["Requested", null, false], ["Rejected", null, false]] as const) {
        h.db.tables.venue_bookings = [bk(1, { venue_id: 1, status, hold_expires_at: hold })];
        events([info(101)]);
        expect(await ids()).toEqual(expectBlocked ? [2] : [1, 2]);
      }
    });
    it("touching padded windows are free, a one-minute overlap is not (venue 1 pads 30/30)", async () => {
      h.db.tables.venue_bookings = [bk(1, { venue_id: 1 })];
      // booking 14:00–16:00 → 13:30–16:30; wanted 10:00–12:00 → 09:30–12:30  (free)
      events([info(101, { startTime: "14:00", endTime: "16:00" })]);
      expect(await ids()).toEqual([1, 2]);
      // booking 13:00–15:00 → 12:30–15:30 touches 12:30 exactly (free)
      events([info(101, { startTime: "13:00", endTime: "15:00" })]);
      expect(await ids()).toEqual([1, 2]);
      events([info(101, { startTime: "12:59", endTime: "15:00" })]);
      expect(await ids()).toEqual([2]);
    });
    it("a booking on another day, at another venue, or with an unknown event does not exclude", async () => {
      h.db.tables.venue_bookings = [bk(1, { venue_id: 1 }), bk(2, { venue_id: 2, event_id: 999 })];
      events([info(101, { proposedDate: "2026-09-21" })]);
      expect(await ids()).toEqual([1, 2]);
    });
    it("a block-out excludes the venue; one that only touches the padded window does not", async () => {
      h.db.tables.venue_unavailability = [{ id: 1, venue_id: 1, start_date: "2026-09-20", end_date: "2026-09-20", all_day: false, start_time: "12:00", end_time: "14:00", reason: "x" }];
      expect(await ids()).toEqual([2]);
      h.db.tables.venue_unavailability[0].start_time = "12:30";
      expect(await ids()).toEqual([1, 2]);
    });
    it("500 when block-outs, bookings or their events cannot be checked", async () => {
      h.db.failOn("venue_unavailability", "select");
      expect((await get(q)).body).toEqual({ error: "Failed to check venue availability" });
      h.db.clearFailures();
      h.db.failOn("venue_bookings", "select");
      expect((await get(q)).status).toBe(500);
      h.db.clearFailures();
      h.db.tables.venue_bookings = [bk(1)];
      ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
      expect((await get(q)).status).toBe(500);
    });
    it("a date alone (no times) treats the whole day as wanted", async () => {
      h.db.tables.venue_bookings = [bk(1, { venue_id: 1 })];
      events([info(101, { startTime: "20:00", endTime: "21:00" })]);
      expect(await ids("/?date=2026-09-20")).toEqual([2]);
    });
  });
});

describe("GET /recommendations/:eventId", () => {
  it.each(["0", "x", "-1", "01", "12abc", "1x", "x1", "1 2"])("rejects event id %j", async (id) => {
    expect((await get(`/recommendations/${id}`)).body).toEqual({ error: "Invalid event id" });
  });
  it.each(["10", "12", "907"])("accepts the multi-digit event id %s", async (id) => {
    const res = await get(`/recommendations/${id}`);
    expect(res.status).toBe(200);
    expect(ev.fetchEvent).toHaveBeenCalledWith(Number(id), expect.any(String));
  });
  it("404 / 502 from events-service; 500 when venues fail", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "not_found" });
    expect((await get("/recommendations/7")).status).toBe(404);
    ev.fetchEvent.mockResolvedValue({ status: "error" });
    expect((await get("/recommendations/7")).body).toEqual({ error: "Failed to load the event" });
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event() });
    h.db.failOn("venues", "select");
    const res = await get("/recommendations/7");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load venues" });
    expect(ev.fetchEvent).toHaveBeenCalledWith(7, COORD);
  });
  it("recommends venues that fit the attendance, tightest first, and echoes the requirements it used", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({}, { expectedAttendance: 150.5 }) });
    const res = await get("/recommendations/7");
    expect(res.status).toBe(200);
    expect(res.body.requirements).toMatchObject({ attendance: 151, date: "2026-09-20", startTime: "10:00", endTime: "12:00" });
    expect(res.body.venues.map((v: any) => v.id)).toEqual([2]);
  });
  it("capacity exactly equal to attendance counts", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({}, { expectedAttendance: 100 }) });
    expect((await get("/recommendations/7")).body.venues.map((v: any) => v.id)).toEqual([1, 2]);
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({}, { expectedAttendance: 101 }) });
    expect((await get("/recommendations/7")).body.venues.map((v: any) => v.id)).toEqual([2]);
  });
  it("an event's own existing booking does not make its venue unavailable, another event's does", async () => {
    h.db.tables.venue_bookings = [bk(1, { venue_id: 1, event_id: 7 }), bk(2, { venue_id: 2, event_id: 8 })];
    events([info(7), info(8)]);
    expect((await get("/recommendations/7")).body.venues.map((v: any) => v.id)).toEqual([1]);
  });
  it("a booking plan in the query overrides attendance and needs", async () => {
    const res = await get("/recommendations/7?headcount=20&facilities=Stage");
    expect(res.status).toBe(200);
    expect(res.body.requirements).toMatchObject({ attendance: 20, facilities: ["Stage"] });
    expect(res.body.venues).toEqual([]);
  });
  it("a headcount above the event's attendance is a 400 with the field named", async () => {
    const res = await get("/recommendations/7?headcount=81");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid booking plan", fields: { headcount: "The headcount can't be more than the event's expected attendance (80)." } });
  });
  it("an event with an impossible date is a 422", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({}, { proposedDate: "2026-02-30" }) });
    const res = await get("/recommendations/7");
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("This event's date, time or attendance is invalid");
    expect(res.body.fields).toHaveProperty("date");
  });
  it("an event with no details still works (nothing to match on)", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({ submitted_details: null }) });
    const res = await get("/recommendations/7");
    expect(res.status).toBe(200);
    expect(res.body.requirements.attendance).toBeNull();
  });
  it("500 when availability cannot be checked", async () => {
    h.db.failOn("venue_unavailability", "select");
    const res = await get("/recommendations/7");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to check venue availability" });
  });
});

describe("GET /:venueId/availability", () => {
  const url = (q = "from=2026-09-14&to=2026-09-27", id = "1") => `/${id}/availability?${q}`;

  it.each(["10", "12", "907"])("accepts the multi-digit venue id %s", async (id) => {
    const res = await get(url(undefined, id));
    expect(res.body).not.toEqual({ error: "Invalid venue id" });
  });

  it.each(["0", "x", "-1", "01", "12abc", "1x", "x1", "1 2"])("rejects venue id %j", async (id) => {
    expect((await get(url(undefined, id))).body).toEqual({ error: "Invalid venue id" });
  });
  it("validates the range: missing, bad, reversed and too wide", async () => {
    const fields = async (q: string) => (await get(url(q))).body.fields;
    expect(await fields("")).toEqual({ from: "Enter a valid date (YYYY-MM-DD).", to: "Enter a valid date (YYYY-MM-DD)." });
    expect(await fields("from=2026-02-30&to=2026-03-01")).toEqual({ from: "Enter a valid date (YYYY-MM-DD)." });
    expect(await fields("from=2026-09-02&to=2026-09-01")).toEqual({ to: "The end date must not be before the start date." });
    expect(await fields("from=2026-09-01&to=2026-10-13")).toEqual({ to: "The range can cover at most 42 days." });
    expect((await get(url("from=2026-09-01&to=2026-10-12"))).status).toBe(200);
    expect((await get(url("from=2026-09-01&to=2026-09-01"))).status).toBe(200);
  });
  it("validates the target: date, order and times", async () => {
    const fields = async (t: string) => (await get(url(`from=2026-09-14&to=2026-09-27&${t}`))).body.fields;
    expect(await fields("targetStart=09:00")).toEqual({ targetFrom: "Enter a target date." });
    expect(await fields("targetFrom=2026-13-01")).toEqual({ targetFrom: "Enter a target date." });
    expect(await fields("targetFrom=2026-09-20&targetTo=2026-02-30")).toEqual({ targetTo: "Enter a valid date (YYYY-MM-DD)." });
    expect(await fields("targetFrom=2026-09-20&targetTo=2026-09-19")).toEqual({ targetTo: "The end date must not be before the start date." });
    expect(await fields("targetFrom=2026-09-20&targetStart=25:00&targetEnd=26:00")).toEqual({ targetStart: "Enter a valid time (HH:MM).", targetEnd: "Enter a valid time (HH:MM)." });
    expect(await fields("targetFrom=2026-09-20&targetStart=10:00&targetEnd=10:00")).toEqual({ targetEnd: "The end time must be after the start time." });
    expect(await fields("targetFrom=2026-09-20&targetStart=10:01&targetEnd=10:00")).toEqual({ targetEnd: "The end time must be after the start time." });
    expect((await get(url("from=2026-09-14&to=2026-09-27&targetFrom=2026-09-20&targetStart=10:00&targetEnd=10:01"))).status).toBe(200);
  });
  it("404 for an unknown or inactive venue; 500 when the venue, bookings or periods fail; 502 when events fail", async () => {
    expect((await get(url(undefined, "99"))).body).toEqual({ error: "Venue not found" });
    h.db.rows("venues")[0].active = false;
    expect((await get(url())).status).toBe(404);
    h.db.rows("venues")[0].active = true;
    h.db.failOn("venues", "select");
    expect((await get(url())).body).toEqual({ error: "Failed to load the venue" });
    h.db.clearFailures();
    h.db.failOn("venue_bookings", "select");
    expect((await get(url())).body).toEqual({ error: "Failed to load venue availability" });
    h.db.clearFailures();
    h.db.failOn("venue_unavailability", "select");
    expect((await get(url())).status).toBe(500);
    h.db.clearFailures();
    h.db.tables.venue_bookings = [bk(1)];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    const res = await get(url());
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the booked events" });
  });
  it("shows the venue with buffers and hours, and nothing else when the venue is idle", async () => {
    const res = await get(url());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      venue: { id: 1, name: "Venue 1", location: "North", capacity: 100, setupMinutes: 30, turnaroundMinutes: 30, openingTime: "08:00", closingTime: "22:00" },
      bookings: [], unavailability: [], target: null, freeSlots: [],
    });
  });
  it("lists blocking bookings in range with padded times; holds expose their expiry; lapsed holds, Requested and out-of-range ones are left out", async () => {
    h.db.tables.venue_bookings = [
      bk(1, { event_id: 101 }),
      bk(2, { event_id: 102, status: "On Hold", hold_expires_at: "2026-09-16T00:00:00Z" }),
      bk(3, { event_id: 103, status: "On Hold", hold_expires_at: "2026-09-14T07:00:00Z" }),
      bk(4, { event_id: 104, status: "Requested" }),
      bk(5, { event_id: 105 }), bk(6, { event_id: 106 }), bk(7, { event_id: 107 }), bk(8, { event_id: 108, venue_id: 2 }),
    ];
    events([
      info(101, { proposedDate: "2026-09-21", startTime: "14:00", endTime: "16:00" }),
      info(102, { proposedDate: "2026-09-21", startTime: "09:00", endTime: "10:00" }),
      info(103), info(104),
      info(105, { proposedDate: "2026-09-13" }), info(106, { proposedDate: "2026-09-28" }), info(107, { proposedDate: null }), info(108),
    ]);
    const res = await get(url());
    expect(res.body.bookings).toEqual([
      { id: 2, status: "On Hold", date: "2026-09-21", startTime: "09:00", endTime: "10:00", occupiedStart: "08:30", occupiedEnd: "10:30", holdExpiresAt: "2026-09-16T00:00:00Z", event: { id: 102, name: "Event 102" } },
      { id: 1, status: "Approved", date: "2026-09-21", startTime: "14:00", endTime: "16:00", occupiedStart: "13:30", occupiedEnd: "16:30", holdExpiresAt: null, event: { id: 101, name: "Event 101" } },
    ]);
    expect(ev.fetchVenueBookingInfo.mock.calls[0][0]).toEqual([101, 102, 105, 106, 107]);
  });
  it("range edges are inclusive", async () => {
    h.db.tables.venue_bookings = [bk(1, { event_id: 101 }), bk(2, { event_id: 102 })];
    events([info(101, { proposedDate: "2026-09-14" }), info(102, { proposedDate: "2026-09-27" })]);
    expect((await get(url())).body.bookings.map((b: any) => b.id)).toEqual([1, 2]);
  });
  it("includes block-out periods touching the range (edges inclusive) for this venue only", async () => {
    h.db.tables.venue_unavailability = [
      { id: 1, venue_id: 1, start_date: "2026-09-10", end_date: "2026-09-14", all_day: true, start_time: null, end_time: null, reason: "a" },
      { id: 2, venue_id: 1, start_date: "2026-09-27", end_date: "2026-09-30", all_day: true, start_time: null, end_time: null, reason: "b" },
      { id: 3, venue_id: 1, start_date: "2026-09-01", end_date: "2026-09-13", all_day: true, start_time: null, end_time: null, reason: "c" },
      { id: 4, venue_id: 2, start_date: "2026-09-15", end_date: "2026-09-15", all_day: true, start_time: null, end_time: null, reason: "d" },
    ];
    expect((await get(url())).body.unavailability.map((p: any) => p.id)).toEqual([1, 2]);
  });
  it("with a target, returns free slots around bookings and block-outs", async () => {
    h.db.tables.venue_bookings = [bk(1, { event_id: 101 })];
    events([info(101, { proposedDate: "2026-09-21", startTime: "12:00", endTime: "14:00" })]);
    const res = await get(url("from=2026-09-14&to=2026-09-27&targetFrom=2026-09-21&targetStart=08:00&targetEnd=22:00"));
    expect(res.body.target).toEqual({ fromDate: "2026-09-21", toDate: "2026-09-21", startTime: "08:00", endTime: "22:00" });
    expect(res.body.freeSlots.length).toBeGreaterThan(0);
    const slots = res.body.freeSlots as { date: string; start: string; end: string }[];
    expect(slots.every((s) => s.date === "2026-09-21")).toBe(true);
    // nothing is free inside the booking's padded 11:30–14:30
    expect(slots.some((s) => s.start < "14:30" && s.end > "11:30")).toBe(false);
  });
  it("a venue with no operating hours reads as open all day", async () => {
    h.db.rows("venues")[0].opening_time = null;
    h.db.rows("venues")[0].closing_time = null;
    const res = await get(url());
    expect(res.body.venue).toMatchObject({ openingTime: "00:00", closingTime: "24:00" });
  });
});

describe("GET /bookings/:bookingId/availability-check", () => {
  const url = (q = "proposedDate=2026-09-20&startTime=10:00&endTime=12:00", id = "1") => `/bookings/${id}/availability-check?${q}`;
  beforeEach(() => { h.db.tables.venue_bookings = [bk(1, { event_id: 101 })]; });

  it.each(["0", "x", "-1", "01", "12abc", "1x", "x1", "1 2"])("rejects booking id %j", async (id) => {
    expect((await get(url(undefined, id))).body).toEqual({ error: "Invalid booking id" });
  });
  it("validates the proposed schedule", async () => {
    const fields = async (q: string) => (await get(url(q))).body.fields;
    expect(await fields("")).toEqual({ proposedDate: "This field is required." });
    expect(await fields("proposedDate=2026-09-20&startTime=9:00&endTime=25:00")).toEqual({ startTime: "Enter a valid time (HH:MM).", endTime: "Enter a valid time (HH:MM)." });
    const bad = await get(url("proposedDate=tomorrow"));
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: "Invalid request", fields: { proposedDate: "Enter a valid date." } });
  });
  it("404 for an unknown booking or venue; 500 on lookup failures", async () => {
    expect((await get(url(undefined, "99"))).body).toEqual({ error: "Booking not found" });
    h.db.rows("venues").length = 0;
    expect((await get(url())).body).toEqual({ error: "Venue not found" });
    h.db.failOn("venue_bookings", "select");
    expect((await get(url())).body).toEqual({ error: "Failed to load the booking" });
    h.db.clearFailures();
    h.db.failOn("venues", "select");
    expect((await get(url())).body).toEqual({ error: "Failed to load the venue" });
  });
  it("is available when nothing clashes, ignoring the booking's own hold", async () => {
    events([info(101)]);
    const res = await get(url());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true, unavailabilityConflict: null, bookingConflict: null });
  });
  it("reports another booking that clashes, with its status and window", async () => {
    h.db.tables.venue_bookings.push(bk(2, { event_id: 102 }));
    events([info(101), info(102, { startTime: "11:00", endTime: "13:00" })]);
    const res = await get(url());
    expect(res.body).toEqual({ available: false, unavailabilityConflict: null, bookingConflict: { bookingId: 2, status: "Approved", window: "2026-09-20 10:30–13:30" } });
  });
  it("reports a block-out that clashes, with its reason and description", async () => {
    h.db.tables.venue_unavailability = [{ id: 1, venue_id: 1, start_date: "2026-09-20", end_date: "2026-09-21", all_day: true, start_time: null, end_time: null, reason: "Painting" }];
    const res = await get(url());
    expect(res.body).toEqual({ available: false, unavailabilityConflict: { reason: "Painting", description: "from 2026-09-20 to 2026-09-21 (all day)" }, bookingConflict: null });
  });
  it("touching windows are available; a one-minute overlap is not (venue pads 30/30 → 09:30–12:30)", async () => {
    h.db.tables.venue_bookings.push(bk(2, { event_id: 102 }));
    events([info(101), info(102, { startTime: "13:00", endTime: "15:00" })]);
    expect((await get(url())).body.available).toBe(true);
    events([info(101), info(102, { startTime: "12:59", endTime: "15:00" })]);
    expect((await get(url())).body.available).toBe(false);
  });
  it("500 when the block-out check fails, 502 when other bookings cannot be checked", async () => {
    h.db.failOn("venue_unavailability", "select");
    const a = await get(url());
    expect(a.status).toBe(500);
    expect(a.body).toEqual({ error: "Failed to check the venue's availability" });
    h.db.clearFailures();
    h.db.tables.venue_bookings.push(bk(2, { event_id: 102 }));
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    const b = await get(url());
    expect(b.status).toBe(502);
    expect(b.body).toEqual({ error: "Failed to check other bookings for this venue" });
  });
  it("times are optional (whole day)", async () => {
    h.db.tables.venue_bookings.push(bk(2, { event_id: 102 }));
    events([info(101), info(102, { startTime: "20:00", endTime: "21:00" })]);
    expect((await get(url("proposedDate=2026-09-20"))).body.available).toBe(false);
  });
});

describe("POST /bookings/:bookingId/flag-for-rebooking", () => {
  const flag = (body: unknown = { reason: "Capacity exceeded" }, id = "1") => post(`/bookings/${id}/flag-for-rebooking`, body);
  beforeEach(() => { h.db.tables.venue_bookings = [{ id: 1, venue_id: 1, event_id: 7, status: "Approved" }]; });

  it.each(["0", "x", "01", "12abc", "1x", "x1", "1 2"])("rejects booking id %j", async (id) => {
    expect((await flag(undefined, id)).body).toEqual({ error: "Invalid booking id" });
  });
  it.each([{}, { reason: "" }, { reason: "   " }, { reason: 5 }, { reason: null }])("requires a real reason (%j)", async (body) => {
    const res = await flag(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A reason is required" });
  });
  it("404 unknown booking; 500 on lookup failure", async () => {
    expect((await flag(undefined, "99")).body).toEqual({ error: "Booking not found" });
    h.db.failOn("venue_bookings", "select");
    expect((await flag()).body).toEqual({ error: "Failed to load the booking" });
  });
  it("maps the event lookup: 404, 502, and only the assigned coordinator may flag", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "not_found" });
    expect((await flag()).body).toEqual({ error: "Event not found" });
    ev.fetchEvent.mockResolvedValue({ status: "error" });
    expect((await flag()).status).toBe(502);
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({ coordinator_id: "COORD-0002" }) });
    const res = await flag();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only the event's assigned coordinator can flag this booking" });
    expect(row(1).status).toBe("Approved");
  });
  it.each(["Requested", "On Hold", "Rejected", "Expired", "Withdrawn", "Cancelled", "Replacement Required"])("a %s booking cannot be flagged (409)", async (status) => {
    row(1).status = status;
    const res = await flag();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: `A booking in "${status}" can't be flagged for rebooking` });
    expect(row(1).status).toBe(status);
  });
  it("flags an Approved booking with the reason and decider, and tells the venue's staff", async () => {
    const res = await flag({ reason: "  Capacity exceeded  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ booking: { id: 1, status: "Replacement Required" }, staffNotified: true });
    expect(row(1)).toMatchObject({ status: "Replacement Required", decision_reason: "Capacity exceeded", decided_by: COORD_ID, decided_at: new Date().toISOString() });
    expect(published).toEqual([
      { type: "booking.flagged_for_rebooking", eventId: 7, actorId: COORD_ID, recipients: { userIds: ["VEN-0001"], roles: [] }, data: { venueName: "Venue 1", reason: "Capacity exceeded" } },
    ]);
  });
  it("a venue with nobody assigned is flagged without a message; a broker failure is reported", async () => {
    h.db.rows("venues")[0].staff_id = null;
    expect((await flag()).body).toEqual({ booking: { id: 1, status: "Replacement Required" }, staffNotified: false });
    expect(published).toEqual([]);
    h.db.rows("venues")[0].staff_id = "VEN-0001";
    row(1).status = "Approved";
    publishOk = false;
    expect((await flag()).body.staffNotified).toBe(false);
  });
  it("uses a generic venue name if the venue row is gone", async () => {
    h.db.rows("venues").length = 0;
    // no venue → no staff id → no message; booking still flagged
    expect((await flag()).body.staffNotified).toBe(false);
  });
  it("500 on write failure; 409 when someone changed it meanwhile", async () => {
    h.db.failOn("venue_bookings", "update");
    expect((await flag()).body).toEqual({ error: "Failed to flag the booking" });
    h.db.clearFailures();
    h.db.failOn("venue_bookings", "update", 1, () => { row(1).status = "Withdrawn"; return false; });
    const res = await flag();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This booking changed while it was being flagged. Refresh and try again." });
    expect(published).toEqual([]);
  });
});

describe("POST /bookings (request a venue)", () => {
  const req = (body: Record<string, unknown> = {}) => post("/bookings", { eventId: 7, venueId: 1, ...body });

  it("validates ids", async () => {
    for (const body of [{}, { eventId: 7 }, { venueId: 1 }, { eventId: 0, venueId: 1 }, { eventId: 7, venueId: -1 }, { eventId: 1.5, venueId: 1 }, { eventId: "x", venueId: 1 }]) {
      const res = await post("/bookings", body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid booking request");
    }
    expect((await post("/bookings", {})).body.fields).toEqual({ eventId: "Choose an event to request a venue for.", venueId: "Choose a venue to request." });
    expect((await request(app).post("/v/bookings").set("Authorization", COORD)).status).toBe(400);
  });
  it("accepts string ids", async () => {
    expect((await req({ eventId: "7", venueId: "1" })).status).toBe(201);
  });
  it("event lookups: 404, 502; only the assigned coordinator (403); only Planning / Needs Review (409)", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "not_found" });
    expect((await req()).body).toEqual({ error: "Event not found" });
    ev.fetchEvent.mockResolvedValue({ status: "error" });
    expect((await req()).body).toEqual({ error: "Failed to load the event" });
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({ coordinator_id: "COORD-0002" }) });
    const forbidden = await req();
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toEqual({ error: "Only the event's assigned coordinator can request a venue for it" });
    for (const status of ["Draft", "Unassigned", "Requested", "Clarification Requested", "Safety Review", "Confirmed", "Rejected", "Completed", "Cancelled"]) {
      ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({ status }) });
      const res = await req();
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "A venue can only be requested while the event is in Planning or Needs Review" });
    }
    for (const status of ["Planning", "Needs Review"]) {
      ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({ status }) });
      expect((await req()).status).toBe(201);
      h.db.tables.venue_bookings = [];
    }
    expect(h.db.writes("venue_bookings").length).toBeGreaterThan(0);
  });
  it("500 when venues fail; 404 for a venue that is unknown or not Available", async () => {
    h.db.failOn("venues", "select", 1);
    expect((await req()).body).toEqual({ error: "Failed to load venues" });
    expect((await req({ venueId: 99 })).body).toEqual({ error: "Venue not found" });
    h.db.rows("venues")[0].status = "Unavailable";
    expect((await req()).status).toBe(404);
  });
  it("422 when the event has no valid date or time", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({}, { proposedDate: "2026-02-30" }) });
    const res = await req();
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("This event's date or time is invalid");
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({}, { proposedDate: null }) });
    const none = await req();
    expect(none.status).toBe(422);
    expect(none.body.fields).toEqual({ date: "This event has no date to book a venue for." });
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({ submitted_details: null }) });
    expect((await req()).status).toBe(422);
  });
  it("400 for an invalid plan, naming the fields", async () => {
    const res = await req({ purpose: "Party", headcount: 81 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid booking request");
    expect(res.body.fields).toMatchObject({ purpose: expect.stringContaining("Choose one of"), headcount: expect.stringContaining("80") });
    expect(h.db.writes("venue_bookings")).toHaveLength(0);
  });
  it("409 when the event already has a live booking for this venue; a finished one does not count", async () => {
    h.db.tables.venue_bookings = [{ id: 1, venue_id: 1, event_id: 7, status: "Requested" }];
    const res = await req();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This event already has a Requested booking for this venue", booking: { id: 1, status: "Requested" } });
    for (const status of ["Rejected", "Expired", "Withdrawn", "Cancelled", "Replacement Required"]) {
      h.db.tables.venue_bookings = [{ id: 1, venue_id: 1, event_id: 7, status }];
      expect((await req()).status).toBe(201);
    }
  });
  it("a booking for another venue or another event does not block", async () => {
    h.db.tables.venue_bookings = [{ id: 1, venue_id: 2, event_id: 7, status: "Requested" }, { id: 2, venue_id: 1, event_id: 8, status: "Requested" }];
    // venue 2 already holds the main programme → a plan is needed for another venue
    expect((await req()).status).toBe(400);
    expect((await req({ purpose: "Breakout", headcount: 10 })).status).toBe(201);
  });
  it("500 when the existing-bookings checks fail", async () => {
    h.db.failOn("venue_bookings", "select", 1);
    expect((await req()).body).toEqual({ error: "Failed to check existing bookings" });
    h.db.clearFailures();
    h.db.failOn("venue_bookings", "select", 1, (c) => c.filters.some((f) => f.col === "status" && f.kind === "in") && !c.filters.some((f) => f.col === "venue_id"));
    expect((await req()).body).toEqual({ error: "Failed to check existing bookings" });
  });
  it("once the main venue is covered, a plan-less request is refused; one with a plan goes through", async () => {
    h.db.tables.venue_bookings = [{ id: 1, venue_id: 2, event_id: 7, status: "Approved" }];
    const refused = await req();
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/main venue is already booked/);
    expect(refused.body.fields).toEqual({ purpose: "Choose what this venue is for.", headcount: "Enter how many people this venue is for." });
    // a withdrawn main booking no longer counts
    h.db.tables.venue_bookings = [{ id: 1, venue_id: 2, event_id: 7, status: "Withdrawn" }];
    expect((await req()).status).toBe(201);
  });
  it("blocking-window failures are a 500 (queries or events)", async () => {
    h.db.failOn("venue_bookings", "select", 1, (c) => c.filters.length === 1 && c.filters[0].kind === "in");
    expect((await req()).body).toEqual({ error: "Failed to check venue availability" });
    h.db.clearFailures();
    h.db.tables.venue_bookings = [bk(1, { event_id: 105 })];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    expect((await req()).status).toBe(500);
  });
  it("409 with both windows when an On Hold or Approved booking overlaps (this venue pads 30/30 → 09:30–12:30)", async () => {
    h.db.tables.venue_bookings = [bk(1, { event_id: 105, status: "On Hold", hold_expires_at: "2026-09-15T00:00:00Z" })];
    events([info(105, { startTime: "11:00", endTime: "13:00" })]);
    const res = await req();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Venue is not available for this period",
      conflict: { bookingId: 1, status: "On Hold", window: "2026-09-20 10:30–13:30", requestedWindow: "2026-09-20 09:30–12:30", setupMinutes: 30, turnaroundMinutes: 30 },
    });
    expect(h.db.writes("venue_bookings")).toHaveLength(0);
  });
  it("overlap rules: Requested / lapsed hold / other venue / the event's own booking elsewhere / touching or other-day window do not block", async () => {
    for (const [o, ev2] of [
      [{ status: "Requested" }, {}], [{ status: "On Hold", hold_expires_at: "2026-09-14T07:00:00Z" }, {}], [{ venue_id: 2 }, {}],
      [{ event_id: 7, venue_id: 2 }, {}], [{}, { startTime: "13:00", endTime: "14:00" }], [{}, { proposedDate: "2026-09-21" }],
    ] as const) {
      h.db.tables.venue_bookings = [bk(1, { event_id: 105, ...o })];
      events([info(105, ev2), info(7)]);
      const res = await req({ purpose: "Breakout", headcount: 5 });
      expect(res.status, JSON.stringify([o, ev2])).toBe(201);
    }
    h.db.tables.venue_bookings = [bk(1, { event_id: 105 })];
    events([info(105, { startTime: "12:59", endTime: "14:00" })]);
    expect((await req()).status).toBe(409);
  });
  it("409 over a block-out, naming the period; 500 if the block-out check fails", async () => {
    h.db.tables.venue_unavailability = [{ id: 1, venue_id: 1, start_date: "2026-09-20", end_date: "2026-09-20", all_day: true, start_time: null, end_time: null, reason: "Roof repair" }];
    const res = await req();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "Venue is unavailable on 2026-09-20 (all day): Roof repair", unavailability: { id: 1, reason: "Roof repair" }, requestedWindow: "2026-09-20 09:30–12:30" });
    h.db.clearFailures();
    h.db.failOn("venue_unavailability", "select");
    expect((await req()).body).toEqual({ error: "Failed to check venue availability" });
  });
  it("creates a Requested booking with no plan columns when none was sent, and notifies the venue's staff", async () => {
    const res = await req();
    expect(res.status).toBe(201);
    expect(h.db.rows("venue_bookings")).toEqual([{ id: 1, venue_id: 1, event_id: 7, status: "Requested" }]);
    expect(res.body).toEqual({
      staffNotified: true,
      booking: {
        id: 1, status: "Requested", venue: { id: 1, name: "Venue 1", location: "North" },
        purpose: "Main programme", purposeDetail: null, headcount: 80, suitability: { suitable: true, reasons: [] },
      },
    });
    expect(published).toEqual([
      { type: "booking.requested", eventId: 7, actorId: COORD_ID, recipients: { userIds: ["VEN-0001"], roles: [] }, data: { eventName: "Gala", venueName: "Venue 1", when: "2026-09-20, 10:00–12:00" } },
    ]);
  });
  it("stores the plan when one is sent and reports suitability against it", async () => {
    const res = await req({ purpose: "Breakout", headcount: 80, layouts: ["Banquet"], facilities: [], accessibility: [] });
    expect(res.status).toBe(201);
    expect(h.db.rows("venue_bookings")[0]).toMatchObject({
      status: "Requested", purpose: "Breakout", purpose_detail: null, headcount: 80, required_layouts: ["Banquet"], required_facilities: [], required_accessibility: [],
    });
    expect(res.body.booking).toMatchObject({ purpose: "Breakout", headcount: 80, suitability: { suitable: false, reasons: [{ kind: "layouts", missing: ["Banquet"] }] } });
  });
  it("an unsuitable venue can still be requested (suitability is shown, not enforced)", async () => {
    h.db.rows("venues")[0].capacity = 10;
    const res = await req();
    expect(res.status).toBe(201);
    expect(res.body.booking.suitability).toEqual({ suitable: false, reasons: [{ kind: "capacity", capacity: 10, headcount: 80 }] });
  });
  it("500 when the insert fails, writing nothing and notifying nobody", async () => {
    h.db.failOn("venue_bookings", "insert");
    const res = await req();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to submit the booking request" });
    expect(published).toEqual([]);
  });
  describe("the staff notification", () => {
    it("is skipped (staffNotified false) when the venue has nobody assigned, when the lookup fails or the broker is down", async () => {
      h.db.rows("venues")[0].staff_id = null;
      expect((await req()).body.staffNotified).toBe(false);
      expect(published).toEqual([]);
      h.db.rows("venues")[0].staff_id = "VEN-0001";
      h.db.tables.venue_bookings = [];
      h.db.failOn("venues", "select", 1, (c) => c.filters.length === 1 && c.filters[0].col === "id" && c.op === "select" && h.db.calls.filter((x) => x.table === "venues").length >= 2);
      publishOk = false;
      h.db.clearFailures();
      expect((await req()).body.staffNotified).toBe(false);
    });
    it.each([
      [{ name: "", proposedDate: "2026-09-20", startTime: "10:00", endTime: "12:00" }, "Event #7", "2026-09-20, 10:00–12:00"],
      [{ name: "Gala", proposedDate: "2026-09-20", startTime: "10:00", endTime: null }, "Gala", "2026-09-20"],
      [{ name: "Gala", proposedDate: "2026-09-20", startTime: null, endTime: "12:00" }, "Gala", "2026-09-20"],
      [{ name: 5, proposedDate: "2026-09-20", startTime: "10:00", endTime: "12:00" }, "Event #7", "2026-09-20, 10:00–12:00"],
      [{ name: "Gala", proposedDate: "2026-09-20", startTime: 1000, endTime: "12:00" }, "Gala", "2026-09-20"],
      [{ name: "Gala", proposedDate: "2026-09-20", startTime: "10:00", endTime: 1200 }, "Gala", "2026-09-20"],
    ])("describes %j as %s at %s", async (d, name, when) => {
      ev.fetchEvent.mockResolvedValue({ status: "ok", event: event({}, d) });
      await req();
      expect(published[0].data).toEqual({ eventName: name, venueName: "Venue 1", when });
    });
  });
});

describe("POST /bookings/:bookingId/withdraw and /release", () => {
  it.each(["withdraw", "release"])("%s rejects a bad booking id", async (action) => {
    for (const id of ["0", "x", "01", "12abc", "1x", "x1", "1 2"]) {
      expect((await post(`/bookings/${id}/${action}`)).body).toEqual({ error: "Invalid booking id" });
    }
    expect(wd.withdrawBooking).not.toHaveBeenCalled();
  });
  it.each(["withdraw", "release"] as const)("%s passes the caller, token and action through", async (action) => {
    wd.withdrawBooking.mockResolvedValue({ status: "ok", booking: { id: 5, status: "Withdrawn", event_id: 7 }, venue: { id: 1, name: "V", location: "L" }, staffNotified: true });
    const res = await post(`/bookings/5/${action}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ booking: { id: 5, status: "Withdrawn", venue: { id: 1, name: "V", location: "L" } }, staffNotified: true });
    expect(wd.withdrawBooking).toHaveBeenCalledWith(expect.anything(), { bookingId: 5, action, coordinatorId: COORD_ID, authorization: COORD });
  });
  it.each([
    ["withdraw", { status: "not_found" }, 404, { error: "Booking not found" }],
    ["withdraw", { status: "not_owner" }, 403, { error: "Only the event's assigned coordinator can withdraw this booking" }],
    ["release", { status: "not_owner" }, 403, { error: "Only the event's assigned coordinator can release this booking" }],
    ["release", { status: "blocked", message: "Nope" }, 409, { error: "Nope" }],
    ["withdraw", { status: "event_error" }, 502, { error: "Failed to load the booked event" }],
    ["withdraw", { status: "error" }, 500, { error: "Failed to withdraw the booking" }],
    ["release", { status: "error" }, 500, { error: "Failed to release the booking" }],
  ])("%s: %j → %i", async (action, result, code, body) => {
    wd.withdrawBooking.mockResolvedValue(result);
    const res = await post(`/bookings/5/${action}`);
    expect(res.status).toBe(code);
    expect(res.body).toEqual(body);
  });
});

describe("mutation-run follow-ups", () => {
  const avail = (q: string, id = "1") => get(`/${id}/availability?${q}`);
  const RANGE = "from=2026-09-14&to=2026-09-27";

  it("recommendations: an unknown event is a 404 with a message", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "not_found" });
    const res = await get("/recommendations/7");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });
  });

  it("availability: query values are trimmed, and a repeated parameter counts as missing", async () => {
    expect((await avail("from=%202026-09-14%20&to=%202026-09-27%20")).status).toBe(200);
    const repeated = await avail("from=2026-09-14&from=2026-09-15&to=2026-09-27");
    expect(repeated.status).toBe(400);
    expect(repeated.body.fields).toEqual({ from: "Enter a valid date (YYYY-MM-DD)." });
  });

  it.each(["10:00x", "x10:00", "1:00", "10:0", "24:00"])("availability: target time %j is not a time", async (bad) => {
    expect((await avail(`${RANGE}&targetFrom=2026-09-20&targetStart=${bad}`)).body.fields).toEqual({ targetStart: "Enter a valid time (HH:MM)." });
    expect((await avail(`${RANGE}&targetFrom=2026-09-20&targetEnd=${bad}`)).body.fields).toEqual({ targetEnd: "Enter a valid time (HH:MM)." });
  });

  it("availability: a bad time never also earns the 'must be after' message for the other one", async () => {
    const fields = async (t: string) => (await avail(`${RANGE}&targetFrom=2026-09-20&${t}`)).body.fields;
    expect(await fields("targetStart=99:99&targetEnd=09:00")).toEqual({ targetStart: "Enter a valid time (HH:MM)." });
    expect(await fields("targetStart=10:00&targetEnd=99:99")).toEqual({ targetEnd: "Enter a valid time (HH:MM)." });
    expect(await fields("targetStart=99:99&targetEnd=88:88")).toEqual({
      targetStart: "Enter a valid time (HH:MM).",
      targetEnd: "Enter a valid time (HH:MM).",
    });
    expect((await avail(`${RANGE}&targetFrom=2026-09-20&targetStart=10:00`)).status).toBe(200);
    expect((await avail(`${RANGE}&targetFrom=2026-09-20&targetEnd=10:00`)).status).toBe(200);
  });

  it("availability: the error wrapper says 'Invalid request'", async () => {
    expect((await avail("")).body.error).toBe("Invalid request");
  });

  it("availability: block-outs come back earliest first whatever order they are stored in", async () => {
    const period = (id: number, start_date: string) => ({ id, venue_id: 1, start_date, end_date: start_date, all_day: true, start_time: null, end_time: null, reason: "r" });
    h.db.tables.venue_unavailability = [period(3, "2026-09-25"), period(1, "2026-09-15"), period(2, "2026-09-20")];
    expect((await avail(RANGE)).body.unavailability.map((p: { id: number }) => p.id)).toEqual([1, 2, 3]);
  });

  it("availability: only a hold shows an expiry, even if an Approved row still carries an old one", async () => {
    h.db.tables.venue_bookings = [bk(1, { event_id: 101, status: "Approved", hold_expires_at: "2026-09-16T00:00:00Z" })];
    events([info(101, { proposedDate: "2026-09-21" })]);
    expect((await avail(RANGE)).body.bookings[0]).toMatchObject({ id: 1, status: "Approved", holdExpiresAt: null });
  });

  it("availability-check: times must be exactly HH:MM, and the wrapper says 'Invalid request'", async () => {
    const check = (q: string) => get(`/bookings/1/availability-check?${q}`);
    h.db.tables.venue_bookings = [bk(1, { event_id: 101 })];
    for (const bad of ["10:00x", "x10:00", "1:00"]) {
      const start = await check(`proposedDate=2026-09-20&startTime=${bad}&endTime=12:00`);
      expect(start.status).toBe(400);
      expect(start.body).toEqual({ error: "Invalid request", fields: { startTime: "Enter a valid time (HH:MM)." } });
      expect((await check(`proposedDate=2026-09-20&startTime=10:00&endTime=${bad}`)).body.fields).toEqual({ endTime: "Enter a valid time (HH:MM)." });
    }
    expect((await check("")).body.error).toBe("Invalid request");
  });

  it("flag-for-rebooking: a request with no body is a 400 for the missing reason, not a crash", async () => {
    const res = await request(app).post("/v/bookings/1/flag-for-rebooking").set("Authorization", COORD);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A reason is required" });
  });

  it("flag-for-rebooking: events-service being down is a 502 with a message", async () => {
    h.db.tables.venue_bookings = [{ id: 1, venue_id: 1, event_id: 7, status: "Approved" }];
    ev.fetchEvent.mockResolvedValue({ status: "error" });
    const res = await post("/bookings/1/flag-for-rebooking", { reason: "Too small" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });
  });

  it("request a venue: ids of exactly 1 are valid", async () => {
    const res = await post("/bookings", { eventId: 1, venueId: 1 });
    expect(res.status).toBe(201);
  });

  it("request a venue: no row and no error back from the insert is still a failure", async () => {
    h.db.nullOn("venue_bookings", "insert");
    const res = await post("/bookings", { eventId: 7, venueId: 1 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to submit the booking request" });
  });
});
