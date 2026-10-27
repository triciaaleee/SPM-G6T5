import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { occupiedWindow, parsePeriodInput, periodBlocksSlot, periodOverlapsWindow } from "../lib/unavailability.js";
import { occupiedWindow as bookingWindow } from "../lib/bookingConflicts.js";
import { unavailabilityRouter } from "../routes/unavailability.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "VEN-0001", role: "venue_staff" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const venueStaff = { id: "VEN-0001", role: "venue_staff" };
const venue = { id: 6, name: "Great Lawn", setup_minutes: 0, turnaround_minutes: 0 };

/** A supabase-js style query: every filter returns the query, and awaiting it yields `result`. */
function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "lte", "gte", "order", "in"]) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  q.single = vi.fn().mockResolvedValue(result);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

/** Event info for event `id` at the given slot, as events-service returns it. */
function eventInfo(id: number, proposedDate: string, startTime: string | null, endTime: string | null) {
  return {
    id,
    coordinatorId: `COORD-000${id}`,
    name: `Event ${id}`,
    proposedDate,
    startTime,
    endTime,
    expectedAttendance: 50,
    venue: null,
    accessibility: null,
    equipment: null,
    technicalSupport: null,
  };
}

function buildApp(
  options: {
    user?: { id: string; role: string };
    venue?: (typeof venue & Record<string, unknown>) | null;
    existing?: { id: number; venue_id: number } | null;
    periods?: Record<string, unknown>[];
    bookings?: { id: number; event_id: number; status?: string }[];
    events?: Record<string, unknown>[];
    eventsStatus?: number;
    notificationsStatus?: number;
    deleted?: { id: number }[];
    /** E4-13: rows already in venue_buffer_overlaps before the call. */
    storedOverlaps?: { id: number; venue_id: number; booking_id_a: number; booking_id_b: number }[];
  } = {},
) {
  const venueQuery = query({ data: options.venue === undefined ? venue : options.venue, error: null });
  const periodsQuery = query({ data: options.periods ?? [], error: null });
  periodsQuery.maybeSingle = vi.fn().mockResolvedValue({ data: options.existing ?? null, error: null });
  const bookingsQuery = query({ data: options.bookings ?? [], error: null });
  const updateQuery = query({ data: null, error: null });
  const deleteQuery = query({ data: options.deleted ?? [{ id: 1 }], error: null });

  const insert = vi.fn((row: Record<string, unknown>) =>
    query({ data: { id: 99, ...row, start_time: row.start_time && `${row.start_time}:00`, end_time: row.end_time && `${row.end_time}:00` }, error: null }),
  );
  const update = vi.fn(() => updateQuery);
  const periodUpdate = vi.fn((row: Record<string, unknown>) =>
    query({ data: { id: options.existing?.id ?? 1, venue_id: options.existing?.venue_id ?? 6, ...row }, error: null }),
  );

  // E4-13 AC2/AC3: an in-memory venue_buffer_overlaps, read/written by
  // reconcileBufferOverlapsSafely after a block-out save flags an Approved
  // booking Replacement Required.
  let overlapRows = [...(options.storedOverlaps ?? [])];
  const overlapsTable = {
    select: vi.fn(() => {
      let venueId: unknown;
      const q: any = { eq: vi.fn((_c: string, v: unknown) => { venueId = v; return q; }), order: vi.fn(() => q) };
      q.then = (resolve: (v: unknown) => void) => resolve({ data: overlapRows.filter((r) => r.venue_id === venueId), error: null });
      return q;
    }),
    insert: vi.fn((rows: any[]) => {
      overlapRows = [...overlapRows, ...rows.map((r, i) => ({ ...r, id: 8000 + i }))];
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
    }),
    delete: vi.fn(() => ({
      in: vi.fn((_c: string, ids: number[]) => {
        overlapRows = overlapRows.filter((r) => !ids.includes(r.id));
        return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
      }),
    })),
  };

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venues") return { select: venueQuery.select };
      if (table === "venue_unavailability") {
        return { select: periodsQuery.select, insert, update: periodUpdate, delete: vi.fn(() => deleteQuery) };
      }
      if (table === "venue_bookings") return { select: bookingsQuery.select, update };
      if (table === "venue_buffer_overlaps") return overlapsTable;
      throw new Error(`unexpected table ${table}`);
    }),
  };

  const fetchMock = vi.fn(async (url: string, _init?: { body?: string }) => {
    if (url.includes("venue-booking-info")) {
      const status = options.eventsStatus ?? 200;
      return { ok: status < 300, status, json: async () => ({ events: options.events ?? [] }) };
    }
    const status = options.notificationsStatus ?? 201;
    return { ok: status < 300, status, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);

  const publish = vi.fn().mockResolvedValue((options.notificationsStatus ?? 201) < 300);
  setPublisherForTest({ publish });

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? venueStaff;

  const app = express();
  app.use(express.json());
  app.use("/api/venues/unavailability", unavailabilityRouter);
  return {
    app,
    supabase,
    periodsQuery,
    bookingsQuery,
    updateQuery,
    insert,
    update,
    periodUpdate,
    fetchMock,
    publish,
    overlapsTable,
    getOverlapRows: () => overlapRows,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parsePeriodInput", () => {
  it("accepts a full-day block over several days", () => {
    const parsed = parsePeriodInput({ startDate: "2026-10-12", endDate: "2026-10-14", allDay: true, reason: " Floor works " });
    expect(parsed).toEqual({
      valid: true,
      period: { startDate: "2026-10-12", endDate: "2026-10-14", allDay: true, startTime: null, endTime: null, reason: "Floor works" },
    });
  });

  it("defaults the end date to the start date (a one-day block)", () => {
    const parsed = parsePeriodInput({ startDate: "2026-10-12", allDay: false, startTime: "09:00", endTime: "13:00", reason: "Cleaning" });
    expect(parsed.valid && parsed.period).toMatchObject({ endDate: "2026-10-12", startTime: "09:00", endTime: "13:00" });
  });

  it("names every missing or invalid field", () => {
    const parsed = parsePeriodInput({ startDate: "2026-02-30", allDay: false, startTime: "13:00", endTime: "09:00" });
    expect(!parsed.valid && Object.keys(parsed.fields).sort()).toEqual(["endDate", "endTime", "reason", "startDate"]);
  });

  it("rejects an end time not after the start time and an end date before the start date", () => {
    const parsed = parsePeriodInput({
      startDate: "2026-10-14", endDate: "2026-10-12", allDay: false, startTime: "13:00", endTime: "13:00", reason: "x",
    });
    expect(!parsed.valid && parsed.fields).toMatchObject({
      endDate: "The end date must not be before the start date.",
      endTime: "The end time must be after the start time.",
    });
  });
});

describe("periodBlocksSlot", () => {
  const mornings = { startDate: "2026-10-12", endDate: "2026-10-14", allDay: false, startTime: "09:00", endTime: "13:00" };

  it("blocks the same hours on every day of the range", () => {
    expect(periodBlocksSlot(mornings, "2026-10-13", "12:00", "15:00")).toBe(true);
    expect(periodBlocksSlot(mornings, "2026-10-13", "13:00", "15:00")).toBe(false);
    expect(periodBlocksSlot(mornings, "2026-10-15", "09:00", "10:00")).toBe(false);
  });

  it("treats a slot with no times as clashing with any block that day", () => {
    expect(periodBlocksSlot(mornings, "2026-10-12", null, null)).toBe(true);
  });

  it("blocks every slot on a full-day block", () => {
    expect(periodBlocksSlot({ ...mornings, allDay: true, startTime: null, endTime: null }, "2026-10-14", "20:00", "22:00")).toBe(true);
  });
});

describe("venue staff access", () => {
  it.each([
    ["a coordinator", { id: "COORD-0001", role: "coordinator" }],
    ["an organiser", { id: "ORG-0001", role: "organiser" }],
  ])("rejects %s with 403", async (_label, user) => {
    const { app, supabase } = buildApp({ user });

    const list = await request(app).get("/api/venues/unavailability?venueId=6&from=2026-10-01&to=2026-10-31");
    const create = await request(app).post("/api/venues/unavailability").send({});

    expect(list.status).toBe(403);
    expect(create.status).toBe(403);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("GET /api/venues/unavailability (AC1)", () => {
  it("returns the venue's periods overlapping the range", async () => {
    const { app, periodsQuery } = buildApp({
      periods: [
        { id: 1, venue_id: 6, start_date: "2026-09-29", end_date: "2026-10-02", all_day: true, start_time: null, end_time: null, reason: "Resurfacing" },
        { id: 2, venue_id: 6, start_date: "2026-10-12", end_date: "2026-10-14", all_day: false, start_time: "09:00:00", end_time: "13:00:00", reason: "Cleaning" },
      ],
    });

    const res = await request(app).get("/api/venues/unavailability?venueId=6&from=2026-10-01&to=2026-10-31");

    expect(res.status).toBe(200);
    expect(res.body.periods).toEqual([
      { id: 1, venueId: 6, startDate: "2026-09-29", endDate: "2026-10-02", allDay: true, startTime: null, endTime: null, reason: "Resurfacing" },
      { id: 2, venueId: 6, startDate: "2026-10-12", endDate: "2026-10-14", allDay: false, startTime: "09:00", endTime: "13:00", reason: "Cleaning" },
    ]);
    expect(periodsQuery.eq).toHaveBeenCalledWith("venue_id", 6);
    expect(periodsQuery.lte).toHaveBeenCalledWith("start_date", "2026-10-31");
    expect(periodsQuery.gte).toHaveBeenCalledWith("end_date", "2026-10-01");
  });

  it("returns every period at the venue when no range is given", async () => {
    const { app, periodsQuery } = buildApp({
      periods: [
        { id: 1, venue_id: 6, start_date: "2025-01-02", end_date: "2025-01-03", all_day: true, start_time: null, end_time: null, reason: "Old" },
      ],
    });

    const res = await request(app).get("/api/venues/unavailability?venueId=6");

    expect(res.status).toBe(200);
    expect(res.body.periods).toHaveLength(1);
    expect(periodsQuery.lte).not.toHaveBeenCalled();
    expect(periodsQuery.gte).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing venue or a range over six weeks", async () => {
    const { app } = buildApp();

    const noVenue = await request(app).get("/api/venues/unavailability?from=2026-10-01&to=2026-10-31");
    const tooLong = await request(app).get("/api/venues/unavailability?venueId=6&from=2026-09-01&to=2026-12-31");

    expect(noVenue.status).toBe(400);
    expect(tooLong.status).toBe(400);
  });
});

describe("POST /api/venues/unavailability/preview (AC2)", () => {
  it("lists the live bookings the period would affect, without coordinator ids", async () => {
    const { app, bookingsQuery, insert } = buildApp({
      bookings: [
        { id: 1, event_id: 1, status: "Approved" },
        { id: 2, event_id: 2, status: "Approved" },
        { id: 3, event_id: 3, status: "Requested" },
      ],
      events: [
        eventInfo(1, "2026-10-13", "10:00", "12:00"),
        eventInfo(2, "2026-10-13", "14:00", "18:00"),
        eventInfo(3, "2026-10-20", "10:00", "12:00"),
      ],
    });

    const res = await request(app).post("/api/venues/unavailability/preview").send({
      venueId: 6, startDate: "2026-10-12", endDate: "2026-10-14", allDay: false, startTime: "09:00", endTime: "13:00", reason: "Cleaning",
    });

    expect(res.status).toBe(200);
    expect(res.body.affected).toEqual([
      {
        bookingId: 1, status: "Approved", eventId: 1, eventName: "Event 1", date: "2026-10-13",
        startTime: "10:00", endTime: "12:00", occupiedStart: "10:00", occupiedEnd: "12:00", hasCoordinator: true, replacementRequired: true,
      },
    ]);
    expect(bookingsQuery.in).toHaveBeenCalledWith("status", ["Requested", "On Hold", "Approved"]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("flags a pending (Requested) booking whose event overlaps the blocked hours", async () => {
    // Regression: 17:00–20:00 blocked on 21 Oct, event 18:00–21:00 with a Requested booking.
    const { app } = buildApp({
      bookings: [{ id: 7, event_id: 11, status: "Requested" }],
      events: [eventInfo(11, "2026-10-21", "18:00", "21:00")],
    });

    const res = await request(app).post("/api/venues/unavailability/preview").send({
      venueId: 6, startDate: "2026-10-21", endDate: "2026-10-21", allDay: false, startTime: "17:00", endTime: "20:00", reason: "Maintenance",
    });

    expect(res.body.affected).toEqual([expect.objectContaining({ bookingId: 7, status: "Requested", replacementRequired: false })]);
  });

  it("widens each event by the venue's setup and turnaround time", async () => {
    // Block 09:00–13:00. With 30 min setup, a 13:15 start needs the venue from 12:45 — a clash.
    // With 20 min turnaround, an event ending 08:45 holds it until 09:05 — also a clash.
    // An event 13:30–15:00 needs it from 13:00 — clear.
    const { app } = buildApp({
      venue: { ...venue, setup_minutes: 30, turnaround_minutes: 20 },
      bookings: [{ id: 1, event_id: 1 }, { id: 2, event_id: 2 }, { id: 3, event_id: 3 }],
      events: [
        eventInfo(1, "2026-10-13", "13:15", "15:00"),
        eventInfo(2, "2026-10-13", "07:00", "08:45"),
        eventInfo(3, "2026-10-13", "13:30", "15:00"),
      ],
    });

    const res = await request(app).post("/api/venues/unavailability/preview").send({
      venueId: 6, startDate: "2026-10-13", allDay: false, startTime: "09:00", endTime: "13:00", reason: "Cleaning",
    });

    expect(res.body).toMatchObject({ setupMinutes: 30, turnaroundMinutes: 20 });
    expect(res.body.affected.map((b: { bookingId: number }) => b.bookingId)).toEqual([2, 1]);
    expect(res.body.affected[1]).toMatchObject({ occupiedStart: "12:45", occupiedEnd: "15:20" });
  });
});

describe("occupiedWindow", () => {
  it("subtracts setup and adds turnaround, staying within the day", () => {
    expect(occupiedWindow("10:00", "12:00", { setupMinutes: 30, turnaroundMinutes: 45 })).toEqual({ start: "09:30", end: "12:45" });
    expect(occupiedWindow("00:10", "23:50", { setupMinutes: 30, turnaroundMinutes: 30 })).toEqual({ start: "00:00", end: "24:00" });
    expect(occupiedWindow(null, null, { setupMinutes: 30, turnaroundMinutes: 30 })).toEqual({ start: null, end: null });
  });
});

describe("PUT /api/venues/unavailability/:id (edit)", () => {
  it("saves the new dates/hours and flags bookings the edit now covers", async () => {
    const { app, periodUpdate, update, publish } = buildApp({
      existing: { id: 4, venue_id: 6 },
      bookings: [{ id: 1, event_id: 1, status: "Approved" }],
      events: [eventInfo(1, "2026-10-15", "10:00", "12:00")],
    });

    const res = await request(app).put("/api/venues/unavailability/4").send({
      startDate: "2026-10-14", endDate: "2026-10-16", allDay: true, reason: "Extended works",
    });

    expect(res.status).toBe(200);
    expect(periodUpdate).toHaveBeenCalledWith({
      start_date: "2026-10-14", end_date: "2026-10-16", all_day: true, start_time: null, end_time: null, reason: "Extended works",
    });
    expect(update).toHaveBeenCalledWith({
      status: "Cancelled",
      decision_reason: expect.stringMatching(/became unavailable: /),
      decided_at: expect.any(String),
    });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "booking.replacement_required" }));
    expect(res.body).toMatchObject({ period: { id: 4, reason: "Extended works" }, coordinatorsNotified: 1 });
  });

  it("returns 404 for an unknown period and 400 for invalid input", async () => {
    const missing = buildApp({ existing: null });
    const notFound = await request(missing.app).put("/api/venues/unavailability/4").send({ startDate: "2026-10-14", reason: "x" });
    expect(notFound.status).toBe(404);

    const { app, periodUpdate } = buildApp({ existing: { id: 4, venue_id: 6 } });
    const bad = await request(app).put("/api/venues/unavailability/4").send({ startDate: "2026-10-14" });
    expect(bad.status).toBe(400);
    expect(periodUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /api/venues/unavailability (AC1 + AC2)", () => {
  const fullDays = { venueId: 6, startDate: "2026-10-12", endDate: "2026-10-14", allDay: true, reason: "Floor resurfacing" };

  it("saves a full-day block over several days", async () => {
    const { app, insert, update } = buildApp();

    const res = await request(app).post("/api/venues/unavailability").send(fullDays);

    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledWith({
      venue_id: 6, start_date: "2026-10-12", end_date: "2026-10-14", all_day: true,
      start_time: null, end_time: null, reason: "Floor resurfacing", created_by: "VEN-0001",
    });
    expect(res.body.period).toMatchObject({ id: 99, allDay: true, startTime: null });
    expect(res.body.affected).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it("tells events-service about each flagged booking's event, so a Confirmed event moves to Needs Review", async () => {
    process.env.INTERNAL_SERVICE_SECRET = "test-internal-secret";
    const { app, fetchMock } = buildApp({
      bookings: [{ id: 1, event_id: 1, status: "Approved" }, { id: 2, event_id: 2, status: "Approved" }],
      events: [eventInfo(1, "2026-10-13", "10:00", "12:00"), eventInfo(2, "2026-11-01", "10:00", "12:00")],
    });

    const res = await request(app).post("/api/venues/unavailability").send(fullDays);

    expect(res.status).toBe(201);
    const reported = fetchMock.mock.calls.filter(([url]) => String(url).includes("/arrangements-changed"));
    expect(reported).toHaveLength(1);
    expect(String(reported[0][0])).toContain("/api/events/1/arrangements-changed");
    expect((reported[0][1] as { method?: string }).method).toBe("POST");
  });

  it("cancels affected Approved bookings and notifies their coordinators", async () => {
    const { app, update, updateQuery, publish } = buildApp({
      bookings: [{ id: 1, event_id: 1, status: "Approved" }, { id: 2, event_id: 2, status: "Approved" }],
      events: [eventInfo(1, "2026-10-13", "10:00", "12:00"), eventInfo(2, "2026-11-01", "10:00", "12:00")],
    });

    const res = await request(app).post("/api/venues/unavailability").send(fullDays);

    expect(res.status).toBe(201);
    expect(update).toHaveBeenCalledWith({
      status: "Cancelled",
      decision_reason: expect.stringMatching(/became unavailable: /),
      decided_at: expect.any(String),
    });
    expect(updateQuery.in).toHaveBeenCalledWith("id", [1]);
    expect(updateQuery.eq).toHaveBeenCalledWith("status", "Approved");

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "booking.replacement_required",
        eventId: 1,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: expect.objectContaining({ venueName: "Great Lawn", reason: "Floor resurfacing" }),
      }),
    );
    expect(res.body).toMatchObject({ coordinatorsNotified: 1, notificationsFailed: false });
  });

  it("leaves pending bookings' status alone (AGENTS.md §3a) but still notifies their coordinators", async () => {
    const { app, update, publish } = buildApp({
      bookings: [{ id: 7, event_id: 1, status: "Requested" }, { id: 8, event_id: 2, status: "On Hold" }],
      events: [eventInfo(1, "2026-10-13", "10:00", "12:00"), eventInfo(2, "2026-10-14", "10:00", "12:00")],
    });

    const res = await request(app).post("/api/venues/unavailability").send(fullDays);

    expect(res.status).toBe(201);
    expect(update).not.toHaveBeenCalled();
    expect(res.body.affected.map((b: { replacementRequired: boolean }) => b.replacementRequired)).toEqual([false, false]);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "booking.unavailability_clash", eventId: 1 }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "booking.unavailability_clash", eventId: 2 }));
  });

  describe("E4-13 AC3: flagging Replacement Required reconciles the persisted buffer-overlap review list", () => {
    it("removes a stale pair at the venue once the flagging update commits", async () => {
      // A pair stored earlier for this venue that no longer matches
      // anything findAllBufferOverlaps would compute now (the booking ids
      // referenced aren't even in this call's live-bookings fixture).
      const stale = { id: 7000, venue_id: 6, booking_id_a: 100, booking_id_b: 101 };
      const { app, getOverlapRows } = buildApp({
        storedOverlaps: [stale],
        bookings: [{ id: 1, event_id: 1, status: "Approved" }],
        events: [eventInfo(1, "2026-10-13", "10:00", "12:00")],
      });

      const res = await request(app).post("/api/venues/unavailability").send(fullDays);

      expect(res.status).toBe(201);
      expect(getOverlapRows()).toEqual([]);
    });

    it("never reconciles (no venue_buffer_overlaps write) when nothing was flagged", async () => {
      const { app, overlapsTable } = buildApp({
        bookings: [{ id: 7, event_id: 1, status: "Requested" }],
        events: [eventInfo(1, "2026-10-13", "10:00", "12:00")],
      });

      const res = await request(app).post("/api/venues/unavailability").send(fullDays);

      expect(res.status).toBe(201);
      expect(overlapsTable.select).not.toHaveBeenCalled();
    });
  });

  it("still saves, but reports it, when notification-service can't be reached", async () => {
    const { app } = buildApp({
      bookings: [{ id: 1, event_id: 1, status: "Approved" }],
      events: [eventInfo(1, "2026-10-13", "10:00", "12:00")],
      notificationsStatus: 500,
    });

    const res = await request(app).post("/api/venues/unavailability").send(fullDays);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ coordinatorsNotified: 0, notificationsFailed: true });
  });

  it("saves nothing when the bookings can't be checked", async () => {
    const { app, insert } = buildApp({ bookings: [{ id: 1, event_id: 1 }], eventsStatus: 500 });

    const res = await request(app).post("/api/venues/unavailability").send(fullDays);

    expect(res.status).toBe(502);
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 400 naming the invalid fields", async () => {
    const { app, insert } = buildApp();

    const res = await request(app)
      .post("/api/venues/unavailability")
      .send({ venueId: 6, startDate: "2026-10-12", allDay: false, startTime: "09:00" });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(["endTime", "reason"]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown or retired venue", async () => {
    const { app } = buildApp({ venue: null });

    const res = await request(app).post("/api/venues/unavailability").send(fullDays);

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/venues/unavailability/:id", () => {
  it("removes a period", async () => {
    const { app } = buildApp();
    const res = await request(app).delete("/api/venues/unavailability/1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when the period doesn't exist", async () => {
    const { app } = buildApp({ deleted: [] });
    const res = await request(app).delete("/api/venues/unavailability/1");
    expect(res.status).toBe(404);
  });
});

describe("periodOverlapsWindow", () => {
  const padding = { setup_minutes: 30, turnaround_minutes: 45 };
  /** 2026-11-10 10:00–12:00 at a 30/45 venue → 09:30–12:45. */
  const window = bookingWindow({ proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00" }, padding)!;
  const timed = (startTime: string, endTime: string, startDate = "2026-11-10", endDate = startDate) => ({
    startDate,
    endDate,
    allDay: false,
    startTime,
    endTime,
  });

  it("clashes with an all-day block on the event's date", () => {
    expect(
      periodOverlapsWindow({ startDate: "2026-11-10", endDate: "2026-11-10", allDay: true, startTime: null, endTime: null }, window),
    ).toBe(true);
  });

  it("counts a partial overlap with the setup or turnaround", () => {
    expect(periodOverlapsWindow(timed("12:30", "17:00"), window)).toBe(true);
    expect(periodOverlapsWindow(timed("08:00", "09:45"), window)).toBe(true);
  });

  it("is half-open, so a block ending as setup starts is free", () => {
    expect(periodOverlapsWindow(timed("08:00", "09:30"), window)).toBe(false);
    expect(periodOverlapsWindow(timed("12:45", "18:00"), window)).toBe(false);
  });

  it("applies a timed block to every day of a multi-day period", () => {
    expect(periodOverlapsWindow(timed("11:00", "11:30", "2026-11-08", "2026-11-12"), window)).toBe(true);
    expect(periodOverlapsWindow(timed("11:00", "11:30", "2026-11-11", "2026-11-12"), window)).toBe(false);
  });

  it("catches a block on the next day when turnaround runs past midnight", () => {
    const late = bookingWindow({ proposedDate: "2026-11-10", startTime: "22:00", endTime: "23:45" }, padding)!;
    expect(
      periodOverlapsWindow({ startDate: "2026-11-11", endDate: "2026-11-11", allDay: false, startTime: "00:00", endTime: "06:00" }, late),
    ).toBe(true);
  });
});

describe("period input: dates and times", () => {
  const period = (o: Record<string, unknown> = {}) => ({
    startDate: "2026-11-10",
    endDate: "2026-11-12",
    allDay: true,
    reason: "Maintenance",
    ...o,
  });
  const timed = (o: Record<string, unknown> = {}) => period({ allDay: false, startTime: "09:00", endTime: "13:00", ...o });
  const fieldsOf = (body: unknown) => {
    const r = parsePeriodInput(body);
    return r.valid ? {} : r.fields;
  };

  it.each(["09:00x", "x09:00", "9:00", "09:0", "24:00", "09:60", "", "0900"])("start time %j is rejected", (startTime) => {
    expect(fieldsOf(timed({ startTime }))).toEqual({ startTime: "Enter a start time." });
  });

  it.each(["13:00x", "x13:00", "1:00", "13:0", "24:00", "13:60", "", "1300"])("end time %j is rejected", (endTime) => {
    expect(fieldsOf(timed({ endTime }))).toEqual({ endTime: "Enter an end time." });
  });

  it.each(["2026-11-10x", "x2026-11-10", "2026-11-1", "2026/11/10", "20261110", "2026-13-10", "2026-02-30"])(
    "start date %j is rejected",
    (startDate) => {
      expect(fieldsOf(period({ startDate, endDate: undefined }))).toEqual({
        startDate: "Enter a valid start date.",
        endDate: "Enter a valid end date.",
      });
    },
  );

  it("a bad time never produces the 'must be after' message for the other, valid, time", () => {
    // 99:99 is invalid; 09:00 is valid and sorts before it.
    expect(fieldsOf(timed({ startTime: "99:99", endTime: "09:00" }))).toEqual({ startTime: "Enter a start time." });
    expect(fieldsOf(timed({ startTime: "09:00", endTime: "99:99" }))).toEqual({ endTime: "Enter an end time." });
    // Both bad: each keeps its own message, neither is overwritten.
    expect(fieldsOf(timed({ startTime: "99:99", endTime: "88:88" }))).toEqual({
      startTime: "Enter a start time.",
      endTime: "Enter an end time.",
    });
  });

  it("the 'must be after' message needs both times valid and end <= start", () => {
    expect(fieldsOf(timed({ startTime: "13:00", endTime: "13:00" }))).toEqual({ endTime: "The end time must be after the start time." });
    expect(fieldsOf(timed({ startTime: "13:00", endTime: "09:00" }))).toEqual({ endTime: "The end time must be after the start time." });
    expect(fieldsOf(timed({ startTime: "09:00", endTime: "09:01" }))).toEqual({});
  });
});

describe("block-out helpers accept times with seconds", () => {
  const buffers = { setupMinutes: 30, turnaroundMinutes: 45 };

  it("occupiedWindow reads HH:MM:SS the same as HH:MM", () => {
    expect(occupiedWindow("10:00:00", "12:00:00", buffers)).toEqual({ start: "09:30", end: "12:45" });
    expect(occupiedWindow("10:00", "12:00", buffers)).toEqual({ start: "09:30", end: "12:45" });
  });

  it("occupiedWindow clamps to the day and passes missing times through", () => {
    expect(occupiedWindow("00:10", "23:50", buffers)).toEqual({ start: "00:00", end: "24:00" });
    expect(occupiedWindow(null, "12:00", buffers)).toEqual({ start: null, end: null });
    expect(occupiedWindow("10:00", undefined, buffers)).toEqual({ start: null, end: null });
  });

  const timed = { startDate: "2026-11-10", endDate: "2026-11-10", allDay: false, startTime: "09:00", endTime: "13:00" };

  it("periodBlocksSlot: a slot that only touches the block does not clash, with or without seconds", () => {
    // Block 09:00-13:00; slot starts as it ends / ends as it starts.
    expect(periodBlocksSlot(timed, "2026-11-10", "13:00", "14:00")).toBe(false);
    expect(periodBlocksSlot(timed, "2026-11-10", "13:00:00", "14:00:00")).toBe(false);
    expect(periodBlocksSlot(timed, "2026-11-10", "08:00", "09:00")).toBe(false);
    expect(periodBlocksSlot(timed, "2026-11-10", "08:00:00", "09:00:00")).toBe(false);
    // One minute of overlap on either side clashes.
    expect(periodBlocksSlot(timed, "2026-11-10", "12:59:00", "14:00:00")).toBe(true);
    expect(periodBlocksSlot(timed, "2026-11-10", "08:00:00", "09:01:00")).toBe(true);
  });
});
