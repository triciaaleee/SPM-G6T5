import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";
import { COORD, STAFF, appWith } from "./helpers/app.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb }));
vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { from: (t: string) => h.db.from(t) } }));
const ev = vi.hoisted(() => ({ fetchVenueBookingInfo: vi.fn(), reportArrangementsChanged: vi.fn() }));
vi.mock("../lib/eventsClient.js", async (orig) => ({ ...(await orig<typeof import("../lib/eventsClient.js")>()), ...ev }));
const rec = vi.hoisted(() => ({ reconcileBufferOverlapsSafely: vi.fn() }));
vi.mock("../lib/bufferOverlapReview.js", async (orig) => ({ ...(await orig<typeof import("../lib/bufferOverlapReview.js")>()), ...rec }));

import { unavailabilityRouter } from "../routes/unavailability.js";

const app = appWith("/u", unavailabilityRouter);
const published: any[] = [];
let publishOk = true;

const venue = (o: Record<string, unknown> = {}) => ({ id: 1, name: "Grand Hall", active: true, setup_minutes: 30, turnaround_minutes: 30, ...o });
const period = (o: Record<string, unknown> = {}) => ({
  id: 1, venue_id: 1, start_date: "2026-09-14", end_date: "2026-09-16", all_day: true, start_time: null, end_time: null, reason: "Maintenance", ...o,
});
const info = (id: number, o: Record<string, unknown> = {}) => ({
  id, name: `Event ${id}`, coordinatorId: `COORD-000${id}`, proposedDate: "2026-09-15", startTime: "10:00", endTime: "12:00", ...o,
});
const booking = (id: number, event_id: number, status = "Approved", venue_id = 1) => ({ id, event_id, venue_id, status });
const body = (o: Record<string, unknown> = {}) => ({ venueId: 1, startDate: "2026-09-14", endDate: "2026-09-16", reason: "Maintenance", ...o });

beforeEach(() => {
  h.db = createFakeDb({ venues: [venue()] });
  published.length = 0;
  publishOk = true;
  setPublisherForTest({ publish: async (m) => { published.push(m); return publishOk; } });
  ev.fetchVenueBookingInfo.mockReset().mockResolvedValue({ status: "ok", events: [] });
  ev.reportArrangementsChanged.mockReset().mockResolvedValue(true);
  rec.reconcileBufferOverlapsSafely.mockReset().mockResolvedValue(undefined);
});

describe("access", () => {
  it.each([["get", "/u?venueId=1"], ["post", "/u"], ["post", "/u/preview"], ["put", "/u/1"], ["delete", "/u/1"]] as const)("%s %s needs a login and the venue_staff role", async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
    const res = await request(app)[method](path).set("Authorization", COORD);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only venue staff can manage venue unavailability" });
  });
});

describe("GET / (list)", () => {
  const get = (q: Record<string, string>) => request(app).get("/u").query(q).set("Authorization", STAFF);

  it.each([["missing", {}], ["zero", { venueId: "0" }], ["text", { venueId: "x" }], ["negative", { venueId: "-1" }], ["leading zero", { venueId: "01" }], ["trailing text", { venueId: "12abc" }], ["leading text", { venueId: "x12" }]])("rejects a %s venueId", async (_n, q) => {
    const res = await get(q);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid request", fields: { venueId: "Pick a venue." } });
  });
  it("rejects bad or one-sided ranges, naming the field", async () => {
    expect((await get({ venueId: "1", from: "2026-09-01" })).body.fields).toEqual({ to: "Enter a valid date (YYYY-MM-DD)." });
    expect((await get({ venueId: "1", to: "2026-09-01" })).body.fields).toEqual({ from: "Enter a valid date (YYYY-MM-DD)." });
    expect((await get({ venueId: "1", from: "2026-02-30", to: "2026-03-01" })).body.fields).toEqual({ from: "Enter a valid date (YYYY-MM-DD)." });
    expect((await get({ venueId: "1", from: "2026-09-02", to: "2026-09-01" })).body.fields).toEqual({ to: "The end date must not be before the start date." });
  });
  it("allows a 42-day span (41 days apart) and rejects 43 days (42 apart)", async () => {
    expect((await get({ venueId: "1", from: "2026-09-01", to: "2026-10-12" })).status).toBe(200);
    const res = await get({ venueId: "1", from: "2026-09-01", to: "2026-10-13" });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ to: "The range can cover at most 42 days." });
  });
  it("accepts a one-day range (from = to)", async () => {
    expect((await get({ venueId: "1", from: "2026-09-01", to: "2026-09-01" })).status).toBe(200);
  });
  it("returns this venue's periods that touch the range, edges inclusive, earliest first", async () => {
    h.db = createFakeDb({
      venue_unavailability: [
        period({ id: 1, start_date: "2026-09-20", end_date: "2026-09-22" }),
        period({ id: 2, start_date: "2026-08-25", end_date: "2026-09-01" }), // ends exactly on `from`
        period({ id: 3, start_date: "2026-09-10", end_date: "2026-09-10", all_day: false, start_time: "13:00:00", end_time: "15:00:00" }),
        period({ id: 4, start_date: "2026-09-10", end_date: "2026-09-10", all_day: false, start_time: "09:00:00", end_time: "10:00:00" }),
        period({ id: 5, start_date: "2026-09-30", end_date: "2026-10-02" }), // starts exactly on `to`
        period({ id: 6, start_date: "2026-08-20", end_date: "2026-08-31" }), // ends the day before
        period({ id: 7, start_date: "2026-10-01", end_date: "2026-10-02" }), // starts the day after
        period({ id: 8, venue_id: 2, start_date: "2026-09-10", end_date: "2026-09-10" }),
      ],
    });
    const res = await get({ venueId: "1", from: "2026-09-01", to: "2026-09-30" });
    expect(res.status).toBe(200);
    expect(res.body.periods.map((p: { id: number }) => p.id)).toEqual([2, 4, 3, 1, 5]);
    expect(res.body.periods[1]).toEqual({ id: 4, venueId: 1, startDate: "2026-09-10", endDate: "2026-09-10", allDay: false, startTime: "09:00", endTime: "10:00", reason: "Maintenance" });
  });
  it("with no range returns every period", async () => {
    h.db = createFakeDb({ venue_unavailability: [period({ id: 1, start_date: "2020-01-01", end_date: "2020-01-02" }), period({ id: 2, start_date: "2031-01-01", end_date: "2031-01-02" })] });
    expect((await get({ venueId: "1" })).body.periods).toHaveLength(2);
  });
  it("500s when the lookup fails", async () => {
    h.db.failOn("venue_unavailability", "select");
    const res = await get({ venueId: "1" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load unavailability" });
  });
});

describe.each([["preview", "post", "/u/preview"], ["create", "post", "/u"]] as const)("%s validation and venue lookup", (_n, method, path) => {
  const send = (b: unknown) => request(app)[method](path).set("Authorization", STAFF).send(b as object);

  it("rejects an invalid period and a missing venue id, naming both fields", async () => {
    const res = await send({ startDate: "nope", reason: "" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Invalid block-out period",
      fields: { startDate: "Enter a valid start date.", endDate: "Enter a valid end date.", reason: "Give a reason.", venueId: "Pick a venue." },
    });
  });
  it("rejects a venue id alone being bad", async () => {
    const res = await send(body({ venueId: "abc" }));
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ venueId: "Pick a venue." });
  });
  it("accepts a numeric or a string venue id", async () => {
    expect((await send(body({ venueId: "1" }))).status).toBeLessThan(300);
    expect((await send(body({ venueId: 1 }))).status).toBeLessThan(300);
  });
  it("404s for an unknown or inactive venue, 500s when the venue lookup fails", async () => {
    expect((await send(body({ venueId: 99 }))).status).toBe(404);
    h.db = createFakeDb({ venues: [venue({ active: false })] });
    const inactive = await send(body());
    expect(inactive.status).toBe(404);
    expect(inactive.body).toEqual({ error: "Venue not found" });
    h.db.failOn("venues", "select");
    const res = await send(body());
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the venue" });
  });
  it("502s when live bookings or their events cannot be checked, and writes nothing", async () => {
    h.db.failOn("venue_bookings", "select");
    const a = await send(body());
    expect(a.status).toBe(502);
    expect(a.body).toEqual({ error: "Failed to check this venue's bookings" });
    h.db.clearFailures();
    h.db.rows("venue_bookings").push(booking(1, 5));
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    expect((await send(body())).status).toBe(502);
    expect(h.db.rows("venue_unavailability")).toHaveLength(0);
    expect(published).toHaveLength(0);
  });
});

describe("which bookings a period affects", () => {
  const preview = (b: Record<string, unknown> = {}) => request(app).post("/u/preview").set("Authorization", STAFF).send(body(b));
  const seed = (rows: any[], events: any[]) => {
    h.db = createFakeDb({ venues: [venue()], venue_bookings: rows });
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events });
  };

  it("only looks at Requested / On Hold / Approved bookings of this venue, asking events-service once per distinct event", async () => {
    seed(
      [booking(1, 5, "Requested"), booking(2, 5, "On Hold"), booking(3, 6, "Approved"), booking(4, 7, "Rejected"), booking(5, 8, "Withdrawn"), booking(6, 9, "Cancelled"), booking(7, 10, "Replacement Required"), booking(8, 11, "Expired"), booking(9, 12, "Approved", 2)],
      [],
    );
    await preview();
    expect(ev.fetchVenueBookingInfo.mock.calls[0][0]).toEqual([5, 6]);
    expect(ev.fetchVenueBookingInfo.mock.calls[0][1]).toBe(STAFF);
  });
  it("reports the venue's setup/turnaround and strips coordinator ids", async () => {
    seed([booking(1, 5)], [info(5)]);
    const res = await preview();
    expect(res.status).toBe(200);
    expect(res.body.setupMinutes).toBe(30);
    expect(res.body.turnaroundMinutes).toBe(30);
    expect(res.body.affected).toEqual([
      {
        bookingId: 1, status: "Approved", eventId: 5, eventName: "Event 5", date: "2026-09-15", startTime: "10:00", endTime: "12:00",
        occupiedStart: "09:30", occupiedEnd: "12:30", hasCoordinator: true, replacementRequired: true,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("COORD-");
  });
  it("pending bookings are listed but do not need replacement; events without a coordinator say so", async () => {
    seed([booking(1, 5, "Requested"), booking(2, 6, "On Hold")], [info(5), info(6, { coordinatorId: null })]);
    const res = await preview();
    expect(res.body.affected.map((a: any) => [a.bookingId, a.replacementRequired, a.hasCoordinator])).toEqual([[1, false, true], [2, false, false]]);
  });
  it("skips events with no date, events outside the period, and bookings whose event is unknown", async () => {
    seed(
      [booking(1, 5), booking(2, 6), booking(3, 7), booking(4, 8)],
      [info(5, { proposedDate: null }), info(6, { proposedDate: "2026-09-17" }), info(7, { proposedDate: "2026-09-13" })],
    );
    expect((await preview()).body.affected).toEqual([]);
  });
  it("period date edges are inclusive", async () => {
    seed([booking(1, 5), booking(2, 6)], [info(5, { proposedDate: "2026-09-14" }), info(6, { proposedDate: "2026-09-16" })]);
    expect((await preview()).body.affected.map((a: any) => a.bookingId)).toEqual([1, 2]);
  });
  it("a timed block clashes on a partial overlap (padding included) but not when merely touching", async () => {
    // event 10:00–12:00 with 30min padding occupies 09:30–12:30
    seed([booking(1, 5)], [info(5)]);
    const timed = (startTime: string, endTime: string) => preview({ allDay: false, startTime, endTime, startDate: "2026-09-15", endDate: "2026-09-15" });
    expect((await timed("12:29", "14:00")).body.affected).toHaveLength(1);
    expect((await timed("12:30", "14:00")).body.affected).toHaveLength(0);
    expect((await timed("08:00", "09:31")).body.affected).toHaveLength(1);
    expect((await timed("08:00", "09:30")).body.affected).toHaveLength(0);
    expect((await timed("10:30", "11:00")).body.affected).toHaveLength(1);
  });
  it("an event with no times is treated as occupying the whole day", async () => {
    seed([booking(1, 5)], [info(5, { startTime: null, endTime: null })]);
    const res = await preview({ allDay: false, startTime: "00:00", endTime: "00:01", startDate: "2026-09-15", endDate: "2026-09-15" });
    expect(res.body.affected).toHaveLength(1);
    expect(res.body.affected[0]).toMatchObject({ occupiedStart: null, occupiedEnd: null });
  });
  it("sorts by date, then start time", async () => {
    seed(
      [booking(1, 5), booking(2, 6), booking(3, 7), booking(4, 8)],
      [info(5, { proposedDate: "2026-09-16", startTime: "08:00" }), info(6, { startTime: "14:00", endTime: "15:00" }), info(7, { startTime: "09:00", endTime: "10:00" }), info(8, { startTime: null, endTime: null })],
    );
    expect((await preview()).body.affected.map((a: any) => a.bookingId)).toEqual([4, 3, 2, 1]);
  });
  it("preview never writes", async () => {
    seed([booking(1, 5)], [info(5)]);
    await preview();
    expect(h.db.writes("venue_bookings")).toHaveLength(0);
    expect(h.db.writes("venue_unavailability")).toHaveLength(0);
    expect(published).toHaveLength(0);
  });
});

describe("POST / (create)", () => {
  const create = (b: Record<string, unknown> = {}) => request(app).post("/u").set("Authorization", STAFF).send(body(b));
  const seed = (rows: any[], events: any[]) => {
    h.db = createFakeDb({ venues: [venue()], venue_bookings: rows });
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events });
  };

  it("saves the period against the venue with the caller as creator", async () => {
    const res = await create({ reason: "  Renovation " });
    expect(res.status).toBe(201);
    expect(h.db.rows("venue_unavailability")).toEqual([
      { id: 1, venue_id: 1, start_date: "2026-09-14", end_date: "2026-09-16", all_day: true, start_time: null, end_time: null, reason: "Renovation", created_by: "VEN-0001" },
    ]);
    expect(res.body).toEqual({
      period: { id: 1, venueId: 1, startDate: "2026-09-14", endDate: "2026-09-16", allDay: true, startTime: null, endTime: null, reason: "Renovation" },
      affected: [], coordinatorsNotified: 0, notificationsFailed: false,
    });
  });
  it("500s and keeps nothing if the insert fails", async () => {
    h.db.failOn("venue_unavailability", "insert");
    const res = await create();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to save the block-out period" });
    expect(h.db.rows("venue_unavailability")).toHaveLength(0);
  });
  it("cancels Approved bookings with the reason, leaves pending ones alone, and tells each coordinator the right thing", async () => {
    seed([booking(1, 5, "Approved"), booking(2, 6, "Requested"), booking(3, 7, "On Hold")], [info(5), info(6), info(7)]);
    const res = await create({ reason: "Fire safety" });
    expect(res.status).toBe(201);
    const rows = h.db.rows("venue_bookings");
    expect(rows.find((r) => r.id === 1)).toMatchObject({ status: "Cancelled", decision_reason: "Grand Hall became unavailable: Fire safety" });
    expect(rows.find((r) => r.id === 1)!.decided_at).toEqual(expect.any(String));
    expect(rows.find((r) => r.id === 2)!.status).toBe("Requested");
    expect(rows.find((r) => r.id === 3)!.status).toBe("On Hold");
    expect(rows.find((r) => r.id === 2)).not.toHaveProperty("decision_reason");

    const byEvent = Object.fromEntries(published.map((m) => [m.eventId, m]));
    expect(byEvent[5]).toMatchObject({
      type: "booking.replacement_required", actorId: "VEN-0001", recipients: { userIds: ["COORD-0005"], roles: [] },
      data: { eventName: "Event 5", venueName: "Grand Hall", period: expect.stringMatching(/^14 Sep\w* 2026 – 16 Sep\w* 2026 \(all day\)$/), reason: "Fire safety", date: expect.stringMatching(/^15 Sep\w* 2026$/) },
    });
    expect(byEvent[6].type).toBe("booking.unavailability_clash");
    expect(byEvent[7].type).toBe("booking.unavailability_clash");
    expect(res.body.coordinatorsNotified).toBe(3);
    expect(res.body.notificationsFailed).toBe(false);
    expect(res.body.affected).toHaveLength(3);
  });
  it("describes a one-day timed period without a date range", async () => {
    seed([booking(1, 5)], [info(5)]);
    await create({ allDay: false, startTime: "10:00", endTime: "11:00", startDate: "2026-09-15", endDate: "2026-09-15" });
    // "Sep" or "Sept" depending on the ICU build, so don't pin the month spelling
    expect(published[0].data.period).toMatch(/^15 Sep\w* 2026, 10:00–11:00$/);
  });
  it("only flips a booking that is still Approved (decided in the meantime → untouched)", async () => {
    seed([booking(1, 5)], [info(5)]);
    // the optimistic guard is in the query: status must still be Approved
    await create();
    expect(h.db.calls.find((c) => c.table === "venue_bookings" && c.op === "update")!.filters).toEqual(
      expect.arrayContaining([{ col: "id", kind: "in", value: [1] }, { col: "status", kind: "eq", value: "Approved" }]),
    );
  });
  it("makes no booking write when nothing needs replacing", async () => {
    seed([booking(1, 5, "Requested")], [info(5)]);
    await create();
    expect(h.db.writes("venue_bookings")).toHaveLength(0);
    expect(ev.reportArrangementsChanged).not.toHaveBeenCalled();
    expect(rec.reconcileBufferOverlapsSafely).not.toHaveBeenCalled();
  });
  it("tells events-service once per affected event with the venue and reason, then reconciles the venue", async () => {
    seed([booking(1, 5), booking(2, 5), booking(3, 6)], [info(5), info(6)]);
    await create({ reason: "Flood" });
    expect(ev.reportArrangementsChanged.mock.calls.map((c) => c[0]).sort()).toEqual([5, 6]);
    expect(ev.reportArrangementsChanged).toHaveBeenCalledWith(5, "Grand Hall is unavailable (Flood)");
    expect(rec.reconcileBufferOverlapsSafely).toHaveBeenCalledTimes(1);
    expect(rec.reconcileBufferOverlapsSafely.mock.calls[0][1]).toBe(1);
    expect(rec.reconcileBufferOverlapsSafely.mock.calls[0][2]).toBe(STAFF);
  });
  it("500s with the saved period when the bookings could not be flagged, without notifying anyone", async () => {
    seed([booking(1, 5)], [info(5)]);
    h.db.failOn("venue_bookings", "update");
    const res = await create();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("The period was saved, but the affected bookings couldn't be flagged. Please try again.");
    expect(res.body.period).toMatchObject({ id: 1, venueId: 1 });
    expect(h.db.rows("venue_unavailability")).toHaveLength(1);
    expect(published).toHaveLength(0);
    expect(ev.reportArrangementsChanged).not.toHaveBeenCalled();
  });
  it("skips coordinators who don't exist and counts distinct recipients only", async () => {
    seed([booking(1, 5), booking(2, 6, "Requested"), booking(3, 7)], [info(5), info(6, { coordinatorId: "COORD-0005" }), info(7, { coordinatorId: null })]);
    const res = await create();
    expect(published).toHaveLength(2);
    expect(res.body.coordinatorsNotified).toBe(1);
    expect(res.body.affected).toHaveLength(3);
  });
  it("reports a failed notification without undoing the block-out", async () => {
    seed([booking(1, 5)], [info(5)]);
    publishOk = false;
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ coordinatorsNotified: 0, notificationsFailed: true });
    expect(h.db.rows("venue_bookings")[0].status).toBe("Cancelled");
  });
});

describe("PUT /:id (edit)", () => {
  const put = (id: string, b: Record<string, unknown> = {}) => request(app).put(`/u/${id}`).set("Authorization", STAFF).send(body(b));
  beforeEach(() => {
    h.db = createFakeDb({ venues: [venue()], venue_unavailability: [period({ id: 4 })], venue_bookings: [] });
  });

  it.each(["0", "abc", "-1", "01", "12abc", "x12"])("rejects period id %j", async (id) => {
    const res = await put(id);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid period id" });
  });
  it("rejects an invalid body", async () => {
    const res = await put("4", { reason: "" });
    expect(res.status).toBe(400);
    expect(res.body.fields).toEqual({ reason: "Give a reason." });
  });
  it("404s for an unknown period; 500s when it cannot be loaded", async () => {
    const missing = await put("99");
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Block-out period not found" });
    h.db.failOn("venue_unavailability", "select");
    const res = await put("4");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the block-out period" });
  });
  it("404s/500s on the period's venue, and 502s when bookings cannot be checked", async () => {
    h.db.rows("venues")[0].active = false;
    expect((await put("4")).body).toEqual({ error: "Venue not found" });
    h.db.rows("venues")[0].active = true;
    h.db.failOn("venues", "select");
    expect((await put("4")).status).toBe(500);
    h.db.clearFailures();
    h.db.failOn("venue_bookings", "select");
    expect((await put("4")).status).toBe(502);
  });
  it("updates the period in place; the venue cannot be changed by the body", async () => {
    const res = await put("4", { venueId: 2, startDate: "2026-10-01", endDate: "2026-10-02", reason: "New plan", allDay: false, startTime: "09:00", endTime: "13:00" });
    expect(res.status).toBe(200);
    expect(h.db.rows("venue_unavailability")).toEqual([
      expect.objectContaining({ id: 4, venue_id: 1, start_date: "2026-10-01", end_date: "2026-10-02", all_day: false, start_time: "09:00", end_time: "13:00", reason: "New plan" }),
    ]);
    expect(res.body.period).toEqual({ id: 4, venueId: 1, startDate: "2026-10-01", endDate: "2026-10-02", allDay: false, startTime: "09:00", endTime: "13:00", reason: "New plan" });
  });
  it("500s when the update fails, leaving the old values", async () => {
    h.db.failOn("venue_unavailability", "update");
    const res = await put("4", { reason: "New" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to save the block-out period" });
    expect(h.db.rows("venue_unavailability")[0].reason).toBe("Maintenance");
  });
  it("flags newly clashing Approved bookings and notifies, like create", async () => {
    h.db.tables.venue_bookings = [booking(1, 5)];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events: [info(5)] });
    const res = await put("4");
    expect(res.status).toBe(200);
    expect(h.db.rows("venue_bookings")[0].status).toBe("Cancelled");
    expect(published.map((m) => m.type)).toEqual(["booking.replacement_required"]);
    expect(res.body).toMatchObject({ coordinatorsNotified: 1, notificationsFailed: false });
    expect(res.body.affected).toHaveLength(1);
  });
  it("500s with the saved period when flagging fails", async () => {
    h.db.tables.venue_bookings = [booking(1, 5)];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events: [info(5)] });
    h.db.failOn("venue_bookings", "update");
    const res = await put("4");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("The period was saved, but the affected bookings couldn't be flagged. Please try again.");
    expect(res.body.period).toMatchObject({ id: 4 });
  });
});

describe("DELETE /:id", () => {
  const del = (id: string) => request(app).delete(`/u/${id}`).set("Authorization", STAFF);
  beforeEach(() => { h.db = createFakeDb({ venue_unavailability: [period({ id: 4 }), period({ id: 5 })] }); });

  it.each(["0", "x", "-2", "04"])("rejects id %j", async (id) => {
    expect((await del(id)).status).toBe(400);
    expect(h.db.rows("venue_unavailability")).toHaveLength(2);
  });
  it("removes exactly that period and answers 204 with no body", async () => {
    const res = await del("4");
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(h.db.rows("venue_unavailability").map((r) => r.id)).toEqual([5]);
  });
  it("404s for a period that does not exist", async () => {
    const res = await del("99");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Block-out period not found" });
    expect(h.db.rows("venue_unavailability")).toHaveLength(2);
  });
  it("500s when the delete fails", async () => {
    h.db.failOn("venue_unavailability", "delete");
    const res = await del("4");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to remove the block-out period" });
    expect(h.db.rows("venue_unavailability")).toHaveLength(2);
  });
});

describe("mutation-run follow-ups", () => {
  const post = (path: string, b?: unknown) => {
    const r = request(app).post(`/u${path}`).set("Authorization", STAFF);
    return b === undefined ? r : r.send(b as object);
  };

  it.each(["", "/preview"])("POST %j with no body at all is a 400 asking for a venue, not a crash", async (path) => {
    const res = await post(path);
    expect(res.status).toBe(400);
    expect(res.body.fields.venueId).toBe("Pick a venue.");
  });

  it("lists a venue's periods earliest first, with an all-day period before a timed one on the same day", async () => {
    h.db.tables.venue_unavailability = [
      period({ id: 1, start_date: "2026-09-15", all_day: false, start_time: "13:00", end_time: "14:00" }),
      period({ id: 2, start_date: "2026-09-14", all_day: true }),
      period({ id: 3, start_date: "2026-09-15", all_day: true }),
      period({ id: 4, start_date: "2026-09-15", all_day: false, start_time: "09:00", end_time: "10:00" }),
    ];
    const res = await request(app).get("/u?venueId=1&from=2026-09-01&to=2026-09-30").set("Authorization", STAFF);
    expect(res.body.periods.map((p: { id: number }) => p.id)).toEqual([2, 3, 4, 1]);
  });

  it("a database that answers with no row and no error is still a failed save", async () => {
    h.db.nullOn("venue_unavailability", "insert");
    const created = await post("", body());
    expect(created.status).toBe(500);
    expect(created.body).toEqual({ error: "Failed to save the block-out period" });

    h.db.clearFailures();
    h.db.tables.venue_unavailability = [period({ id: 4 })];
    h.db.nullOn("venue_unavailability", "update");
    const edited = await request(app).put("/u/4").set("Authorization", STAFF).send(body());
    expect(edited.status).toBe(500);
    expect(edited.body).toEqual({ error: "Failed to save the block-out period" });
  });

  describe("editing", () => {
    const put = (id: number | string, b: Record<string, unknown> = {}) => request(app).put(`/u/${id}`).set("Authorization", STAFF).send(body(b));
    beforeEach(() => {
      h.db.tables.venue_unavailability = [period({ id: 4 })];
    });

    it("500 with a message when the venue cannot be read", async () => {
      h.db.failOn("venues", "select");
      const res = await put(4);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Failed to load the venue" });
    });

    it("502 with a message when the venue's bookings cannot be checked", async () => {
      h.db.failOn("venue_bookings", "select");
      const res = await put(4);
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Failed to check this venue's bookings" });
    });

    it("500 with a message when the period itself cannot be read", async () => {
      h.db.failOn("venue_unavailability", "select");
      const res = await put(4);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Failed to load the block-out period" });
    });
  });

  it("only the Approved bookings are reported to events-service as having lost their venue", async () => {
    h.db.tables.venue_bookings = [booking(1, 1, "Approved"), booking(2, 2, "Requested"), booking(3, 3, "On Hold")];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events: [info(1), info(2), info(3)] });
    const res = await post("", body());
    expect(res.status).toBe(201);
    expect(ev.reportArrangementsChanged.mock.calls.map((c) => c[0])).toEqual([1]);
  });

  it("removing a period names a failure and a missing one", async () => {
    h.db.failOn("venue_unavailability", "delete");
    const failed = await request(app).delete("/u/4").set("Authorization", STAFF);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Failed to remove the block-out period" });
    h.db.clearFailures();
    const missing = await request(app).delete("/u/4").set("Authorization", STAFF);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: "Block-out period not found" });
  });
  it.each([[[1]], [{ id: 1 }], [true], [[]], [null]])("a venueId of %j is not an id", async (venueId) => {
    for (const path of ["", "/preview"]) {
      const res = await post(path, body({ venueId }));
      expect(res.status).toBe(400);
      expect(res.body.fields.venueId).toBe("Pick a venue.");
    }
  });

  it("deleting a period asks the database for the id only", async () => {
    h.db = createFakeDb({ venues: [venue()], venue_unavailability: [period({ id: 4 })] });
    const res = await request(app).delete("/u/4").set("Authorization", STAFF);
    expect(res.status).toBe(204);
    expect(h.db.calls.filter((c) => c.op === "delete").map((c) => c.columns)).toEqual(["id"]);
  });
});
