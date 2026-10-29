import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";
import { ATTENDEE, COORD, ORGANISER, STAFF, appWith } from "./helpers/app.js";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { from: (t: string) => h.db.from(t) } }));
const ev = vi.hoisted(() => ({ fetchEvent: vi.fn(), fetchPublicEvents: vi.fn() }));
vi.mock("../lib/eventsClient.js", async (orig) => ({ ...(await orig<typeof import("../lib/eventsClient.js")>()), ...ev }));

import { attendeeInfoRouter } from "../routes/attendeeInfo.js";
import { eventBookingsRouter } from "../routes/eventBookings.js";
import { suitabilityRouter } from "../routes/suitability.js";
import { publicVenuesRouter } from "../routes/publicVenues.js";

const venueRow = (id: number, o: Record<string, unknown> = {}) => ({
  id, name: `Venue ${id}`, location: "North", description: null, capacity: 100,
  accessibility: ["Ramp"], layouts: ["Theatre"], facilities: ["Projector"], status: "Available", ...o,
});

beforeEach(() => {
  h.db = createFakeDb();
  ev.fetchEvent.mockReset();
  ev.fetchPublicEvents.mockReset();
});

describe("GET /attendee-info", () => {
  const app = appWith("/info", attendeeInfoRouter);
  const get = (q: string, auth = ATTENDEE) => request(app).get(`/info${q}`).set("Authorization", auth);

  it("requires a login", async () => {
    expect((await request(app).get("/info?eventIds=1")).status).toBe(401);
  });
  it.each([["coordinator", COORD], ["staff", STAFF], ["organiser", ORGANISER]])("is attendee-only (%s → 403)", async (_n, auth) => {
    const res = await get("?eventIds=1", auth);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
  });
  it.each(["", "?eventIds=", "?eventIds=abc", "?eventIds=0", "?eventIds=-1", "?eventIds=1,,2", "?eventIds=1,a", "?eventIds=01", "?eventIds=1.5", "?eventIds=12abc", "?eventIds=x12", "?eventIds=1 2", "?eventIds=7,12abc"])("rejects %j", async (q) => {
    const res = await get(q);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("eventIds must be 1–100 comma-separated event ids");
  });
  it("accepts exactly 100 ids and rejects 101", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(",");
    expect((await get(`?eventIds=${ids(100)}`)).status).toBe(200);
    expect((await get(`?eventIds=${ids(101)}`)).status).toBe(400);
  });
  it("accepts id 1 and tolerates spaces around ids", async () => {
    expect((await get("?eventIds=1")).status).toBe(200);
    expect((await get("?eventIds=1,%202")).status).toBe(200);
  });
  it("returns venue names of Approved bookings only, de-duplicating the request ids", async () => {
    h.db = createFakeDb({
      venue_bookings: [
        { id: 1, event_id: 7, status: "Approved", venues: { name: "Grand Ballroom" } },
        { id: 2, event_id: 7, status: "Requested", venues: { name: "Hidden" } },
        { id: 3, event_id: 8, status: "Approved", venues: [{ name: "Hall B" }] },
        { id: 4, event_id: 9, status: "Approved", venues: null },
        { id: 5, event_id: 10, status: "Approved", venues: { name: "Not asked for" } },
      ],
    });
    const res = await get("?eventIds=7,7,8,9");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ venues: [{ eventId: 7, venueName: "Grand Ballroom" }, { eventId: 8, venueName: "Hall B" }] });
    expect(h.db.calls[0].filters).toContainEqual({ col: "event_id", kind: "in", value: [7, 8, 9] });
  });
  it("500s when the lookup fails", async () => {
    h.db.failOn("venue_bookings", "select");
    const res = await get("?eventIds=7");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load venues" });
  });
});

describe("GET /:eventId/bookings", () => {
  const app = appWith("/ev", eventBookingsRouter);
  const get = (id: string, auth = ORGANISER) => request(app).get(`/ev/${id}/bookings`).set("Authorization", auth);

  it("requires a login", async () => expect((await request(app).get("/ev/1/bookings")).status).toBe(401));
  it.each(["0", "abc", "-3", "1.5", "01", "12abc", "1x", "x1"])("rejects event id %j", async (id) => {
    const res = await get(id);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid event id" });
    expect(ev.fetchEvent).not.toHaveBeenCalled();
  });
  it("404s when events-service says the event is not the caller's", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "not_found" });
    const res = await get("7");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });
    expect(h.db.calls).toHaveLength(0);
  });
  it("502s when events-service is down", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "error" });
    const res = await get("7");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });
  });
  it("forwards the caller's token to events-service", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: { id: 7 } });
    await get("7");
    expect(ev.fetchEvent).toHaveBeenCalledWith(7, ORGANISER);
  });
  it("lists the event's bookings oldest first, normalising the embedded venue", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: { id: 7 } });
    const v = { id: 1, name: "A", location: "L", capacity: 5 };
    h.db = createFakeDb({
      venue_bookings: [
        { id: 2, event_id: 7, status: "Rejected", hold_expires_at: null, decision_reason: "Too small", created_at: "2026-01-02", venues: [v] },
        { id: 1, event_id: 7, status: "On Hold", hold_expires_at: "2026-02-01T00:00:00Z", decision_reason: null, created_at: "2026-01-01", venues: v },
        { id: 3, event_id: 7, status: "Requested", hold_expires_at: null, decision_reason: null, created_at: "2026-01-03", venues: [] },
        { id: 4, event_id: 99, status: "Approved", venues: v, created_at: "2026-01-01" },
      ],
    });
    const res = await get("7");
    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([
      { id: 1, status: "On Hold", holdExpiresAt: "2026-02-01T00:00:00Z", decisionReason: null, createdAt: "2026-01-01", venue: v },
      { id: 2, status: "Rejected", holdExpiresAt: null, decisionReason: "Too small", createdAt: "2026-01-02", venue: v },
      { id: 3, status: "Requested", holdExpiresAt: null, decisionReason: null, createdAt: "2026-01-03", venue: null },
    ]);
  });
  it("returns an empty list for an event with no bookings", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: { id: 7 } });
    expect((await get("7")).body).toEqual({ bookings: [] });
  });
  it("500s when the bookings lookup fails", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: { id: 7 } });
    h.db.failOn("venue_bookings", "select");
    const res = await get("7");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the event's venue requests" });
  });
});

describe("GET /suitability/:eventId", () => {
  const app = appWith("/s", suitabilityRouter);
  const get = (id: string, auth = COORD) => request(app).get(`/s/${id}`).set("Authorization", auth);
  const okEvent = (details: Record<string, unknown> = { expectedAttendance: 80 }) =>
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: { id: 7, submitted_details: details } });

  it("requires a login and the coordinator role", async () => {
    expect((await request(app).get("/s/7")).status).toBe(401);
    for (const auth of [STAFF, ORGANISER, ATTENDEE]) {
      const res = await get("7", auth);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only coordinators can check venue suitability" });
    }
  });
  it.each(["0", "x", "-1", "2.5", "12abc", "1x", "x1", "01"])("rejects event id %j", async (id) => {
    const res = await get(id);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid event id" });
    expect(ev.fetchEvent).not.toHaveBeenCalled();
  });
  it.each(["10", "12", "907"])("accepts the multi-digit event id %s", async (id) => {
    okEvent();
    expect((await get(id)).status).toBe(200);
    expect(ev.fetchEvent).toHaveBeenCalledWith(Number(id), COORD);
  });
  it("lists bookings oldest first, whatever order they are stored in", async () => {
    okEvent();
    h.db = createFakeDb({
      venues: [],
      venue_bookings: [
        { id: 3, event_id: 7, venue_id: 1, status: "Requested", created_at: "2026-01-03T00:00:00Z" },
        { id: 1, event_id: 7, venue_id: 1, status: "Requested", created_at: "2026-01-01T00:00:00Z" },
        { id: 2, event_id: 7, venue_id: 1, status: "Requested", created_at: "2026-01-02T00:00:00Z" },
      ],
    });
    const res = await get("7");
    expect(res.body.bookings.map((b: { bookingId: number }) => b.bookingId)).toEqual([1, 2, 3]);
    expect(res.body.bookings.every((b: { suitability: unknown }) => b.suitability === null)).toBe(true);
  });
  it("maps events-service answers: not_found → 404, error → 502", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "not_found" });
    expect((await get("7")).body).toEqual({ error: "Event not found" });
    ev.fetchEvent.mockResolvedValue({ status: "error" });
    const res = await get("7");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });
  });
  it("500s when bookings or venues cannot be loaded", async () => {
    okEvent();
    h.db.failOn("venue_bookings", "select");
    expect((await get("7")).body).toEqual({ error: "Failed to load the event's venue bookings" });
    h.db.clearFailures();
    h.db.failOn("venues", "select");
    const res = await get("7");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load venues" });
  });
  it("works with no bookings and an event with no details", async () => {
    ev.fetchEvent.mockResolvedValue({ status: "ok", event: { id: 7, submitted_details: null } });
    const res = await get("7");
    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([]);
    expect(res.body.defaults).toMatchObject({ attendance: null, liveBookingCount: 0, hasMainProgramme: false });
  });
  it("judges each booking on its own plan; counts live bookings; flags a vanished venue", async () => {
    okEvent({ expectedAttendance: 80, equipment: "projector" });
    h.db = createFakeDb({
      venues: [venueRow(1, { capacity: 80 }), venueRow(2, { capacity: 10, facilities: [] })],
      venue_bookings: [
        { id: 10, venue_id: 1, event_id: 7, status: "Approved", created_at: "1" },
        { id: 11, venue_id: 2, event_id: 7, status: "Requested", purpose: "Breakout", headcount: 20, required_facilities: ["Projector"], created_at: "2" },
        { id: 12, venue_id: 3, event_id: 7, status: "Withdrawn", created_at: "3" },
        { id: 13, venue_id: 1, event_id: 8, status: "Approved", created_at: "4" },
      ],
    });
    const res = await get("7");
    expect(res.status).toBe(200);
    expect(res.body.defaults).toMatchObject({ attendance: 80, liveBookingCount: 2, hasMainProgramme: true });
    const [main, breakout, gone] = res.body.bookings;
    expect(main).toMatchObject({ bookingId: 10, purpose: "Main programme", headcount: 80, suitability: { suitable: true, reasons: [] } });
    expect(breakout).toMatchObject({ bookingId: 11, status: "Requested", purpose: "Breakout", headcount: 20 });
    expect(breakout.suitability).toEqual({
      suitable: false,
      reasons: [{ kind: "capacity", capacity: 10, headcount: 20 }, { kind: "facilities", missing: ["Projector"] }],
    });
    expect(gone).toMatchObject({ bookingId: 12, suitability: null });
    expect(res.body.bookings).toHaveLength(3);
  });
  it("hasMainProgramme is false when the only main booking was withdrawn", async () => {
    okEvent();
    h.db = createFakeDb({ venue_bookings: [{ id: 1, venue_id: 1, event_id: 7, status: "Withdrawn", created_at: "1" }] });
    expect((await get("7")).body.defaults).toMatchObject({ hasMainProgramme: false, liveBookingCount: 0 });
  });
});

describe("public venues", () => {
  const app = appWith("/pub", publicVenuesRouter);
  const pubEvent = (id: number, proposedDate: string | null, startTime: string | null) => ({ id, name: `E${id}`, proposedDate, startTime });

  describe("GET /", () => {
    it("lists only Available venues by name, with no staff/setup details, and attaches approved public events in start order", async () => {
      h.db = createFakeDb({
        venues: [venueRow(2, { name: "B Hall" }), venueRow(1, { name: "A Hall" }), venueRow(3, { name: "Closed", status: "Unavailable" })],
        venue_bookings: [
          { id: 1, event_id: 20, venue_id: 1, status: "Approved" },
          { id: 2, event_id: 10, venue_id: 1, status: "Approved" },
          { id: 3, event_id: 10, venue_id: 1, status: "Approved" },
          { id: 4, event_id: 30, venue_id: 1, status: "Requested" },
          { id: 5, event_id: 99, venue_id: 1, status: "Approved" },
          { id: 6, event_id: 40, venue_id: 2, status: "Approved" },
        ],
      });
      ev.fetchPublicEvents.mockResolvedValue({
        status: "ok",
        events: [pubEvent(20, "2026-10-02", "09:00"), pubEvent(10, "2026-10-01", "18:00"), pubEvent(30, "2026-10-03", "10:00"), pubEvent(40, null, null)],
      });
      const res = await request(app).get("/pub");
      expect(res.status).toBe(200);
      expect(res.body.venues.map((v: { name: string }) => v.name)).toEqual(["A Hall", "B Hall"]);
      expect(res.body.venues[0].upcomingEvents).toEqual([
        { id: 10, name: "E10", proposedDate: "2026-10-01", startTime: "18:00" },
        { id: 20, name: "E20", proposedDate: "2026-10-02", startTime: "09:00" },
      ]);
      expect(res.body.venues[1].upcomingEvents).toEqual([{ id: 40, name: "E40", proposedDate: null, startTime: null }]);
      expect(Object.keys(res.body.venues[0]).sort()).toEqual(["accessibility", "capacity", "description", "facilities", "id", "layouts", "location", "name", "upcomingEvents"]);
    });
    it("sorts events with a date but no time before a later day, and undated events last", async () => {
      h.db = createFakeDb({
        venues: [venueRow(1)],
        venue_bookings: [10, 20, 30].map((e, i) => ({ id: i, event_id: e, venue_id: 1, status: "Approved" })),
      });
      ev.fetchPublicEvents.mockResolvedValue({ status: "ok", events: [pubEvent(10, null, null), pubEvent(20, "2026-10-02", null), pubEvent(30, "2026-10-01", "23:59")] });
      const res = await request(app).get("/pub");
      expect(res.body.venues[0].upcomingEvents.map((e: { id: number }) => e.id)).toEqual([30, 20, 10]);
    });
    it("skips the bookings query when no event is listed", async () => {
      h.db = createFakeDb({ venues: [venueRow(1)] });
      ev.fetchPublicEvents.mockResolvedValue({ status: "ok", events: [] });
      const res = await request(app).get("/pub");
      expect(res.body.venues[0].upcomingEvents).toEqual([]);
      expect(h.db.calls.filter((c) => c.table === "venue_bookings")).toHaveLength(0);
    });
    it("500s on a venue lookup failure, 502s when events cannot be listed, 500s on a bookings failure", async () => {
      h.db.failOn("venues", "select");
      expect((await request(app).get("/pub")).body).toEqual({ error: "Failed to load venues" });
      h.db.clearFailures();
      ev.fetchPublicEvents.mockResolvedValue({ status: "error" });
      const r502 = await request(app).get("/pub");
      expect(r502.status).toBe(502);
      expect(r502.body).toEqual({ error: "Failed to load events" });
      ev.fetchPublicEvents.mockResolvedValue({ status: "ok", events: [pubEvent(1, null, null)] });
      h.db.failOn("venue_bookings", "select");
      const r500 = await request(app).get("/pub");
      expect(r500.status).toBe(500);
      expect(r500.body).toEqual({ error: "Failed to load venues" });
    });
  });

  describe("GET /event-venues", () => {
    it.each(["", "?eventIds=", "?eventIds=x", "?eventIds=0", "?eventIds=1,,2"])("rejects %j", async (q) => {
      const res = await request(app).get(`/pub/event-venues${q}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("eventIds must be 1–100 comma-separated event ids");
    });
    it("accepts 100 ids and rejects 101", async () => {
      ev.fetchPublicEvents.mockResolvedValue({ status: "ok", events: [] });
      const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(",");
      expect((await request(app).get(`/pub/event-venues?eventIds=${ids(100)}`)).status).toBe(200);
      expect((await request(app).get(`/pub/event-venues?eventIds=${ids(101)}`)).status).toBe(400);
    });
    it("ignores ids that are not publicly listed, and non-approved bookings", async () => {
      ev.fetchPublicEvents.mockResolvedValue({ status: "ok", events: [pubEvent(1, null, null), pubEvent(2, null, null)] });
      h.db = createFakeDb({
        venue_bookings: [
          { id: 1, event_id: 1, status: "Approved", venues: { name: "Hall" } },
          { id: 2, event_id: 2, status: "Requested", venues: { name: "Held" } },
          { id: 3, event_id: 3, status: "Approved", venues: { name: "Private event" } },
          { id: 4, event_id: 1, status: "Approved", venues: [{ name: "Annex" }] },
          { id: 5, event_id: 1, status: "Approved", venues: null },
        ],
      });
      const res = await request(app).get("/pub/event-venues?eventIds=1,2,3,1");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ venues: [{ eventId: 1, venueName: "Hall" }, { eventId: 1, venueName: "Annex" }] });
      expect(h.db.calls[0].filters).toContainEqual({ col: "event_id", kind: "in", value: [1, 2] });
    });
    it("makes no bookings query when none of the ids is public", async () => {
      ev.fetchPublicEvents.mockResolvedValue({ status: "ok", events: [pubEvent(1, null, null)] });
      const res = await request(app).get("/pub/event-venues?eventIds=5");
      expect(res.body).toEqual({ venues: [] });
      expect(h.db.calls).toHaveLength(0);
    });
    it("502s when events cannot be listed, 500s when bookings fail", async () => {
      ev.fetchPublicEvents.mockResolvedValue({ status: "error" });
      expect((await request(app).get("/pub/event-venues?eventIds=1")).status).toBe(502);
      ev.fetchPublicEvents.mockResolvedValue({ status: "ok", events: [pubEvent(1, null, null)] });
      h.db.failOn("venue_bookings", "select");
      const res = await request(app).get("/pub/event-venues?eventIds=1");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Failed to load venues" });
    });
  });
});
