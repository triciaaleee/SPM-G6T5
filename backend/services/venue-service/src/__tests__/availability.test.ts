import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { venuesRouter } from "../routes/venues.js";
import {
  bookingWindow,
  datesBetween,
  freeSlotsForDay,
  subtractIntervals,
  toOperatingHours,
} from "../lib/availability.js";
import { isBlockingBooking } from "../lib/bookingStatus.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "COORD-0001", role: "coordinator" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const OPEN_08_22 = { openingTime: "08:00", closingTime: "22:00" };
const NO_BUFFERS = { setupMinutes: 0, turnaroundMinutes: 0 };
const BUFFERS_30_45 = { setupMinutes: 30, turnaroundMinutes: 45 };

describe("isBlockingBooking", () => {
  const now = new Date("2026-10-08T10:00:00Z");

  it("blocks for Approved and an unexpired On Hold", () => {
    expect(isBlockingBooking({ status: "Approved" }, now)).toBe(true);
    expect(isBlockingBooking({ status: "On Hold", hold_expires_at: "2026-10-09T10:00:00Z" }, now)).toBe(true);
  });

  it("treats a lapsed On Hold as Expired", () => {
    expect(isBlockingBooking({ status: "On Hold", hold_expires_at: "2026-10-08T09:59:00Z" }, now)).toBe(false);
  });

  it.each(["Requested", "Rejected", "Expired", "Withdrawn", "Replacement Required"])("never blocks for %s", (status) => {
    expect(isBlockingBooking({ status }, now)).toBe(false);
  });
});

describe("availability helpers", () => {
  it("AC6: pads a booking by setup and turnaround (10:00–12:00 → 09:30–12:45)", () => {
    expect(bookingWindow({ date: "2026-10-10", startTime: "10:00", endTime: "12:00" }, BUFFERS_30_45)).toEqual({
      start: "09:30",
      end: "12:45",
    });
  });

  it("treats a booking with no times as the whole day", () => {
    expect(bookingWindow({ date: "2026-10-10", startTime: null, endTime: null }, BUFFERS_30_45)).toEqual({
      start: "00:00",
      end: "24:00",
    });
  });

  it("reads operating hours from Postgres time, falling back to all day", () => {
    expect(toOperatingHours({ opening_time: "08:00:00", closing_time: "22:30:00" })).toEqual({
      openingTime: "08:00",
      closingTime: "22:30",
    });
    expect(toOperatingHours({})).toEqual({ openingTime: "00:00", closingTime: "24:00" });
  });

  it("subtracts overlapping and touching blocks", () => {
    expect(
      subtractIntervals({ start: "08:00", end: "22:00" }, [
        { start: "10:00", end: "12:00" },
        { start: "11:00", end: "13:00" },
        { start: "13:00", end: "14:00" },
        { start: "21:00", end: "23:00" },
      ]),
    ).toEqual([
      { start: "08:00", end: "10:00" },
      { start: "14:00", end: "21:00" },
    ]);
  });

  it("lists every date in a range, across a month end", () => {
    expect(datesBetween("2026-09-29", "2026-10-02")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
  });
});

describe("freeSlotsForDay (AC5)", () => {
  const date = "2026-10-10";

  it("is the whole target window on an empty day, inside operating hours", () => {
    expect(freeSlotsForDay({ date, bookings: [], periods: [] }, OPEN_08_22, NO_BUFFERS, { startTime: "06:00", endTime: "12:00" })).toEqual([
      { date, start: "08:00", end: "12:00", eventStart: "08:00", eventEnd: "12:00" },
    ]);
  });

  it("splits around a padded booking and a timed block-out", () => {
    const slots = freeSlotsForDay(
      {
        date,
        bookings: [{ date, startTime: "10:00", endTime: "12:00" }],
        periods: [{ startDate: date, endDate: date, allDay: false, startTime: "16:00", endTime: "18:00" }],
      },
      OPEN_08_22,
      BUFFERS_30_45,
      { startTime: null, endTime: null },
    );
    // Free stretches 08:00–09:30, 12:45–16:00, 18:00–22:00. An event inside
    // each needs 30 min setup before and 45 min turnaround after.
    expect(slots).toEqual([
      { date, start: "08:00", end: "09:30", eventStart: "08:30", eventEnd: "08:45" },
      { date, start: "12:45", end: "16:00", eventStart: "13:15", eventEnd: "15:15" },
      { date, start: "18:00", end: "22:00", eventStart: "18:30", eventEnd: "21:15" },
    ]);
  });

  it("drops a gap too short to fit setup and turnaround", () => {
    const slots = freeSlotsForDay(
      {
        date,
        bookings: [
          { date, startTime: "09:00", endTime: "12:00" },
          { date, startTime: "13:30", endTime: "21:00" },
        ],
        periods: [],
      },
      OPEN_08_22,
      BUFFERS_30_45,
      { startTime: "12:00", endTime: "14:00" },
    );
    // 12:45–13:00 is free, but nothing fits after 30 min setup and 45 min turnaround.
    expect(slots).toEqual([]);
  });

  it("has nothing on an all-day block-out", () => {
    expect(
      freeSlotsForDay(
        { date, bookings: [], periods: [{ startDate: "2026-10-09", endDate: "2026-10-11", allDay: true, startTime: null, endTime: null }] },
        OPEN_08_22,
        NO_BUFFERS,
        { startTime: null, endTime: null },
      ),
    ).toEqual([]);
  });

  it("has nothing when the target is entirely outside operating hours", () => {
    expect(
      freeSlotsForDay({ date, bookings: [], periods: [] }, OPEN_08_22, NO_BUFFERS, { startTime: "22:00", endTime: "23:30" }),
    ).toEqual([]);
  });
});

// ---- GET /api/venues/:venueId/availability -------------------------------

const venueRow = {
  id: 3,
  name: "Innovation Hub",
  location: "North Campus",
  description: null,
  capacity: 180,
  accessibility: [],
  layouts: [],
  facilities: [],
  active: true,
  setup_minutes: 30,
  turnaround_minutes: 45,
  opening_time: "08:00:00",
  closing_time: "22:00:00",
};

type BookingRow = { id: number; event_id: number; status: string; hold_expires_at: string | null };

function event(id: number, proposedDate: string, startTime: string | null, endTime: string | null) {
  return {
    id,
    name: `Event ${id}`,
    proposedDate,
    startTime,
    endTime,
    expectedAttendance: 50,
    venue: null,
    accessibility: null,
    equipment: null,
    technicalSupport: null,
    coordinatorId: "COORD-0002",
  };
}

function buildApp(
  options: {
    user?: { id: string; role: string };
    venue?: Record<string, unknown> | null;
    bookings?: BookingRow[];
    events?: ReturnType<typeof event>[];
    eventsStatus?: number;
    periods?: Record<string, unknown>[];
  } = {},
) {
  const venueQuery = {
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.venue === undefined ? venueRow : options.venue, error: null }),
  };
  venueQuery.eq.mockReturnValue(venueQuery);

  const bookingsQuery = { eq: vi.fn(), in: vi.fn().mockResolvedValue({ data: options.bookings ?? [], error: null }) };
  bookingsQuery.eq.mockReturnValue(bookingsQuery);

  const periodsQuery = {
    eq: vi.fn(),
    lte: vi.fn(),
    gte: vi.fn(),
    order: vi.fn().mockResolvedValue({ data: options.periods ?? [], error: null }),
  };
  periodsQuery.eq.mockReturnValue(periodsQuery);
  periodsQuery.lte.mockReturnValue(periodsQuery);
  periodsQuery.gte.mockReturnValue(periodsQuery);

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venues") return { select: vi.fn().mockReturnValue(venueQuery) };
      if (table === "venue_bookings") return { select: vi.fn().mockReturnValue(bookingsQuery) };
      if (table === "venue_unavailability") return { select: vi.fn().mockReturnValue(periodsQuery) };
      throw new Error(`unexpected table ${table}`);
    }),
  };

  const status = options.eventsStatus ?? 200;
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ events: options.events ?? [] }),
  });
  vi.stubGlobal("fetch", fetchMock);

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

  const app = express();
  app.use("/api/venues", venuesRouter);
  return { app, supabase, bookingsQuery, periodsQuery, fetchMock };
}

function getAvailability(app: express.Express, query: Record<string, string> = {}, venueId = "3") {
  return request(app)
    .get(`/api/venues/${venueId}/availability`)
    .query({ from: "2026-10-01", to: "2026-10-31", ...query })
    .set("Authorization", "Bearer test-token");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GET /api/venues/:venueId/availability", () => {
  it.each([
    ["an organiser", { id: "ORG-0001", role: "organiser" }],
    ["venue staff", { id: "VEN-0001", role: "venue_staff" }],
  ])("is coordinator-only (rejects %s)", async (_label, user) => {
    const { app, supabase } = buildApp({ user });
    const res = await getAvailability(app);
    expect(res.status).toBe(403);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("validates the venue id and date range", async () => {
    const { app } = buildApp();
    expect((await getAvailability(app, {}, "abc")).status).toBe(400);

    const backwards = await getAvailability(app, { from: "2026-10-31", to: "2026-10-01" });
    expect(backwards.status).toBe(400);
    expect(backwards.body.fields.to).toBeDefined();

    const tooLong = await getAvailability(app, { from: "2026-10-01", to: "2026-12-31" });
    expect(tooLong.status).toBe(400);
  });

  it("validates the target", async () => {
    const { app } = buildApp();
    const noDate = await getAvailability(app, { targetStart: "09:00", targetEnd: "12:00" });
    expect(noDate.body.fields.targetFrom).toBeDefined();

    const backwards = await getAvailability(app, { targetFrom: "2026-10-10", targetStart: "12:00", targetEnd: "09:00" });
    expect(backwards.status).toBe(400);
    expect(backwards.body.fields.targetEnd).toBeDefined();
  });

  it("returns 404 for an unknown or inactive venue", async () => {
    const { app } = buildApp({ venue: null });
    expect((await getAvailability(app)).status).toBe(404);
  });

  it("AC1/AC2/AC6: returns Approved and On Hold bookings with status and padded windows", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T00:00:00Z"), toFake: ["Date"] });
    const { app, bookingsQuery, fetchMock } = buildApp({
      bookings: [
        { id: 1, event_id: 11, status: "Approved", hold_expires_at: null },
        { id: 2, event_id: 12, status: "On Hold", hold_expires_at: "2026-10-09T12:00:00Z" },
      ],
      events: [event(11, "2026-10-10", "10:00", "12:00"), event(12, "2026-10-10", "14:00", "16:00")],
    });

    const res = await getAvailability(app);

    expect(res.status).toBe(200);
    expect(bookingsQuery.eq).toHaveBeenCalledWith("venue_id", 3);
    expect(bookingsQuery.in).toHaveBeenCalledWith("status", ["On Hold", "Approved"]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/venue-booking-info\?ids=11,12$/), {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.body.venue).toEqual({
      id: 3,
      name: "Innovation Hub",
      location: "North Campus",
      capacity: 180,
      setupMinutes: 30,
      turnaroundMinutes: 45,
      openingTime: "08:00",
      closingTime: "22:00",
    });
    expect(res.body.bookings).toEqual([
      {
        id: 1,
        status: "Approved",
        date: "2026-10-10",
        startTime: "10:00",
        endTime: "12:00",
        occupiedStart: "09:30",
        occupiedEnd: "12:45",
        holdExpiresAt: null,
        event: { id: 11, name: "Event 11" },
      },
      {
        id: 2,
        status: "On Hold",
        date: "2026-10-10",
        startTime: "14:00",
        endTime: "16:00",
        occupiedStart: "13:30",
        occupiedEnd: "16:45",
        holdExpiresAt: "2026-10-09T12:00:00Z",
        event: { id: 12, name: "Event 12" },
      },
    ]);
    // Only what the calendar needs leaves the service — never the coordinator id.
    expect(res.body.bookings[0].event).not.toHaveProperty("coordinatorId");
  });

  it("AC3: leaves out an On Hold whose hold has lapsed (treated as Expired)", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-08T00:00:00Z"), toFake: ["Date"] });
    const { app, fetchMock } = buildApp({
      bookings: [{ id: 2, event_id: 12, status: "On Hold", hold_expires_at: "2026-10-07T12:00:00Z" }],
      events: [event(12, "2026-10-10", "14:00", "16:00")],
    });

    const res = await getAvailability(app);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves out bookings whose event falls outside the range or isn't returned", async () => {
    const { app } = buildApp({
      bookings: [
        { id: 1, event_id: 11, status: "Approved", hold_expires_at: null },
        { id: 2, event_id: 99, status: "Approved", hold_expires_at: null },
      ],
      events: [event(11, "2026-11-02", "10:00", "12:00")],
    });

    const res = await getAvailability(app);
    expect(res.body.bookings).toEqual([]);
  });

  it("AC4: returns block-out periods and operating hours", async () => {
    const { app, periodsQuery } = buildApp({
      periods: [
        { id: 5, venue_id: 3, start_date: "2026-10-12", end_date: "2026-10-14", all_day: false,
          start_time: "09:00:00", end_time: "13:00:00", reason: "Maintenance" },
      ],
    });

    const res = await getAvailability(app);

    expect(periodsQuery.eq).toHaveBeenCalledWith("venue_id", 3);
    expect(periodsQuery.lte).toHaveBeenCalledWith("start_date", "2026-10-31");
    expect(periodsQuery.gte).toHaveBeenCalledWith("end_date", "2026-10-01");
    expect(res.body.unavailability).toEqual([
      { id: 5, venueId: 3, startDate: "2026-10-12", endDate: "2026-10-14", allDay: false,
        startTime: "09:00", endTime: "13:00", reason: "Maintenance" },
    ]);
    expect(res.body.venue.openingTime).toBe("08:00");
    expect(res.body.venue.closingTime).toBe("22:00");
  });

  it("treats a venue with no operating hours recorded as open all day", async () => {
    const { opening_time: _o, closing_time: _c, ...withoutHours } = venueRow;
    const { app } = buildApp({ venue: withoutHours });
    const res = await getAvailability(app);
    expect(res.body.venue.openingTime).toBe("00:00");
    expect(res.body.venue.closingTime).toBe("24:00");
  });

  it("returns no free slots without a target", async () => {
    const { app } = buildApp();
    const res = await getAvailability(app);
    expect(res.body.target).toBeNull();
    expect(res.body.freeSlots).toEqual([]);
  });

  it("AC5: returns free slots in the target, around bookings and block-outs", async () => {
    const { app } = buildApp({
      bookings: [{ id: 1, event_id: 11, status: "Approved", hold_expires_at: null }],
      events: [event(11, "2026-10-10", "10:00", "12:00")],
      periods: [
        { id: 5, venue_id: 3, start_date: "2026-10-11", end_date: "2026-10-11", all_day: true,
          start_time: null, end_time: null, reason: "Private hire" },
      ],
    });

    const res = await getAvailability(app, {
      targetFrom: "2026-10-10",
      targetTo: "2026-10-12",
      targetStart: "09:00",
      targetEnd: "14:00",
    });

    expect(res.status).toBe(200);
    expect(res.body.target).toEqual({ fromDate: "2026-10-10", toDate: "2026-10-12", startTime: "09:00", endTime: "14:00" });
    expect(res.body.freeSlots).toEqual([
      // 10th: booked 09:30–12:45 once padded; 09:00–09:30 is too short for 30 + 45 min.
      { date: "2026-10-10", start: "12:45", end: "14:00", eventStart: "13:15", eventEnd: "14:00" },
      // 11th: blocked out all day. 12th: free throughout.
      { date: "2026-10-12", start: "09:00", end: "14:00", eventStart: "09:00", eventEnd: "14:00" },
    ]);
  });

  it("returns 502 when events-service is unavailable", async () => {
    const { app } = buildApp({
      bookings: [{ id: 1, event_id: 11, status: "Approved", hold_expires_at: null }],
      eventsStatus: 500,
    });
    expect((await getAvailability(app)).status).toBe(502);
  });
});
