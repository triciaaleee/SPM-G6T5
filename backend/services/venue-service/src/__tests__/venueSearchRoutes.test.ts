import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { venuesRouter } from "../routes/venues.js";
import {
  bookingWindow,
  datesBetween,
  findFreeSlots,
  freeSlotsForDay,
  subtractIntervals,
  toOperatingHours,
} from "../lib/availability.js";
import { isBlockingBooking } from "../lib/bookingStatus.js";
import { extractFeatures, extractRequirements, isNoPreference } from "../lib/venueRecommendation.js";
import {
  OPTION_CATALOGUE,
  type VenueRow,
  buildFilterOptions,
  parseVenueSearch,
  searchVenues,
} from "../lib/venueSearch.js";
import { type AuthedRequest } from "../middleware/auth.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "COORD-0001", role: "coordinator" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

describe("venue availability", () => {
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

  /**
   * Mutation-run follow-ups for the free-slot arithmetic: blocks handed over
   * out of order, blocks that sit outside the window, a block that ends exactly
   * where the window does, and a gap with room for setup + turnaround and
   * nothing else.
   */

  const iv = (start: string, end: string) => ({ start, end });
  const WINDOW = iv("08:00", "12:00");

  describe("subtractIntervals", () => {
    it("sorts blocks given out of order", () => {
      expect(subtractIntervals(iv("08:00", "20:00"), [iv("14:00", "15:00"), iv("10:00", "11:00")])).toEqual([
        iv("08:00", "10:00"),
        iv("11:00", "14:00"),
        iv("15:00", "20:00"),
      ]);
    });

    it("ignores a block that sits wholly after the window", () => {
      expect(subtractIntervals(WINDOW, [iv("14:00", "15:00")])).toEqual([WINDOW]);
    });

    it("ignores a block that sits wholly before the window", () => {
      expect(subtractIntervals(WINDOW, [iv("06:00", "07:00")])).toEqual([WINDOW]);
    });

    it("ignores blocks that only touch the window's edges", () => {
      expect(subtractIntervals(WINDOW, [iv("07:00", "08:00"), iv("12:00", "13:00")])).toEqual([WINDOW]);
    });

    it("a block ending exactly where the window ends leaves no zero-length slot behind", () => {
      expect(subtractIntervals(WINDOW, [iv("10:00", "12:00")])).toEqual([iv("08:00", "10:00")]);
    });

    it("a block starting exactly where the window starts leaves only the rest", () => {
      expect(subtractIntervals(WINDOW, [iv("08:00", "09:00")])).toEqual([iv("09:00", "12:00")]);
    });

    it("clips blocks that overhang either edge", () => {
      expect(subtractIntervals(WINDOW, [iv("07:00", "09:00")])).toEqual([iv("09:00", "12:00")]);
      expect(subtractIntervals(WINDOW, [iv("11:00", "13:00")])).toEqual([iv("08:00", "11:00")]);
    });

    it("a block covering the whole window leaves nothing", () => {
      expect(subtractIntervals(WINDOW, [iv("07:00", "13:00")])).toEqual([]);
      expect(subtractIntervals(WINDOW, [iv("08:00", "12:00")])).toEqual([]);
    });

    it("merges overlapping and nested blocks, and keeps a one-minute gap between adjacent ones", () => {
      expect(subtractIntervals(WINDOW, [iv("09:00", "11:00"), iv("10:00", "10:30"), iv("10:30", "11:30")])).toEqual([
        iv("08:00", "09:00"),
        iv("11:30", "12:00"),
      ]);
      expect(subtractIntervals(WINDOW, [iv("09:00", "10:00"), iv("10:01", "11:00")])).toEqual([
        iv("08:00", "09:00"),
        iv("10:00", "10:01"),
        iv("11:00", "12:00"),
      ]);
    });

    it("with no blocks the window is entirely free, and an empty window is empty", () => {
      expect(subtractIntervals(WINDOW, [])).toEqual([WINDOW]);
      expect(subtractIntervals(iv("08:00", "08:00"), [])).toEqual([]);
    });
  });

  describe("freeSlotsForDay", () => {
    const hours = { openingTime: "08:00", closingTime: "20:00" };
    const day = (bookings: { date: string; startTime: string | null; endTime: string | null }[] = []) => ({
      date: "2026-11-10",
      bookings,
      periods: [],
    });
    const target = { startTime: null, endTime: null };

    it("a gap with room for only setup and turnaround is not a slot (event would be zero minutes long)", () => {
      // A 09:30-19:00 booking, padded by 30/30, occupies 09:00-19:30. That leaves
      // 08:00-09:00 (exactly setup + turnaround) and 19:30-20:00 (less than that).
      const slots = freeSlotsForDay(day([{ date: "2026-11-10", startTime: "09:30", endTime: "19:00" }]), hours, { setupMinutes: 30, turnaroundMinutes: 30 }, target);
      expect(slots).toEqual([]);
    });

    it("one minute more than setup + turnaround gives a one-minute event", () => {
      const slots = freeSlotsForDay(day([{ date: "2026-11-10", startTime: "09:31", endTime: "19:00" }]), hours, { setupMinutes: 30, turnaroundMinutes: 30 }, target);
      expect(slots).toEqual([{ date: "2026-11-10", start: "08:00", end: "09:01", eventStart: "08:30", eventEnd: "08:31" }]);
    });

    it("an event with no recorded times blocks the whole day", () => {
      expect(freeSlotsForDay(day([{ date: "2026-11-10", startTime: null, endTime: null }]), hours, { setupMinutes: 0, turnaroundMinutes: 0 }, target)).toEqual([]);
    });

    it("ignores bookings on other days", () => {
      const slots = freeSlotsForDay(day([{ date: "2026-11-11", startTime: "09:00", endTime: "19:00" }]), hours, { setupMinutes: 0, turnaroundMinutes: 0 }, target);
      expect(slots).toEqual([{ date: "2026-11-10", start: "08:00", end: "20:00", eventStart: "08:00", eventEnd: "20:00" }]);
    });
  });

  describe("subtractIntervals: blocks that meet", () => {
    const window = iv("08:00", "12:00");

    it("two blocks that touch leave no empty gap between them", () => {
      expect(subtractIntervals(window, [iv("09:00", "10:00"), iv("10:00", "11:00")])).toEqual([iv("08:00", "09:00"), iv("11:00", "12:00")]);
    });

    it("a block that starts where the previous one ended does not widen the free time before it", () => {
      expect(subtractIntervals(window, [iv("08:00", "09:00"), iv("09:00", "10:00")])).toEqual([iv("10:00", "12:00")]);
    });

    it("a gap never runs past the end of the window, whatever blocks follow it", () => {
      expect(subtractIntervals(window, [iv("13:00", "14:00"), iv("15:00", "16:00")])).toEqual([window]);
      expect(subtractIntervals(window, [iv("11:00", "11:30"), iv("14:00", "15:00")])).toEqual([iv("08:00", "11:00"), iv("11:30", "12:00")]);
    });

    it("a block that starts exactly where the window ends changes nothing", () => {
      expect(subtractIntervals(window, [iv("12:00", "13:00")])).toEqual([window]);
    });
  });

  describe("freeSlotsForDay: the target window", () => {
    const hours = { openingTime: "08:00", closingTime: "20:00" };
    const day = { date: "2026-11-10", bookings: [], periods: [] };
    const none = { setupMinutes: 0, turnaroundMinutes: 0 };

    it.each([
      ["wholly before opening", "05:00", "07:00"],
      ["ending exactly at opening", "06:00", "08:00"],
      ["wholly after closing", "21:00", "22:00"],
      ["starting exactly at closing", "20:00", "22:00"],
      ["empty", "10:00", "10:00"],
      ["back to front", "12:00", "10:00"],
    ])("a target window %s has no slots", (_name, startTime, endTime) => {
      expect(freeSlotsForDay(day, hours, none, { startTime, endTime })).toEqual([]);
    });

    it("a one-minute target window is one slot", () => {
      expect(freeSlotsForDay(day, hours, none, { startTime: "10:00", endTime: "10:01" })).toEqual([
        { date: "2026-11-10", start: "10:00", end: "10:01", eventStart: "10:00", eventEnd: "10:01" },
      ]);
    });

    it("a gap that the target window only touches is skipped, not shown empty", () => {
      const booked = { ...day, bookings: [{ date: "2026-11-10", startTime: "08:00", endTime: "12:00" }] };
      // Free from 12:00; the target ends at 12:00 exactly.
      expect(freeSlotsForDay(booked, hours, none, { startTime: "09:00", endTime: "12:00" })).toEqual([]);
      expect(freeSlotsForDay(booked, hours, none, { startTime: "09:00", endTime: "12:01" })).toEqual([
        { date: "2026-11-10", start: "12:00", end: "12:01", eventStart: "12:00", eventEnd: "12:01" },
      ]);
    });
  });

  describe("findFreeSlots: the loaded range against the target days", () => {
    const hours = { openingTime: "08:00", closingTime: "09:00" };
    const none = { setupMinutes: 0, turnaroundMinutes: 0 };
    const target = (fromDate: string, toDate: string) => ({ fromDate, toDate, startTime: null, endTime: null });
    const dates = (range: { from: string; to: string }, t: ReturnType<typeof target>) =>
      findFreeSlots(range, t, [], [], hours, none).map((slot) => slot.date);
    const RANGE = { from: "2026-11-10", to: "2026-11-12" };

    it("keeps the later start and the earlier end", () => {
      expect(dates(RANGE, target("2026-11-01", "2026-11-30"))).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
      expect(dates(RANGE, target("2026-11-11", "2026-11-30"))).toEqual(["2026-11-11", "2026-11-12"]);
      expect(dates(RANGE, target("2026-11-01", "2026-11-11"))).toEqual(["2026-11-10", "2026-11-11"]);
      expect(dates(RANGE, target("2026-11-11", "2026-11-11"))).toEqual(["2026-11-11"]);
    });

    it("returns nothing when the target days and the range do not meet", () => {
      expect(dates(RANGE, target("2026-11-01", "2026-11-09"))).toEqual([]);
      expect(dates(RANGE, target("2026-11-13", "2026-11-20"))).toEqual([]);
    });

    it("touching at a single day is that day", () => {
      expect(dates(RANGE, target("2026-11-01", "2026-11-10"))).toEqual(["2026-11-10"]);
      expect(dates(RANGE, target("2026-11-12", "2026-11-20"))).toEqual(["2026-11-12"]);
    });
  });
});

describe("availability check", () => {
  /** E3-10 AC2: read-only check of a proposed new date/time for an existing booking. */



  const venueRow = {
    id: 3,
    name: "Grand Ballroom",
    location: "Central Campus",
    description: null,
    capacity: 300,
    accessibility: [],
    layouts: [],
    facilities: [],
    setup_minutes: 30,
    turnaround_minutes: 45,
  };

  function buildApp(
    options: {
      user?: { id: string; role: string };
      booking?: { id: number; venue_id: number } | null;
      bookingError?: boolean;
      venue?: Record<string, unknown> | null;
      periods?: Record<string, unknown>[];
      periodsError?: boolean;
      otherBookings?: Record<string, unknown>[];
      otherBookingsError?: boolean;
      events?: Record<string, unknown>[];
      eventsStatus?: number;
    } = {},
  ) {
    const resolved = (data: unknown, error: unknown = null) => vi.fn().mockResolvedValue({ data, error });

    // venue_bookings backs two different lookups: the booking-by-id lookup
    // (.eq("id",...).maybeSingle()) and blockingWindows' rival-bookings scan
    // (.eq("venue_id",...).in("status",...)).
    const bookingByIdChain: any = {};
    bookingByIdChain.eq = () => bookingByIdChain;
    bookingByIdChain.maybeSingle = resolved(
      options.bookingError ? null : options.booking === undefined ? { id: 55, venue_id: 3 } : options.booking,
      options.bookingError ? { message: "boom" } : null,
    );
    bookingByIdChain.in = resolved(
      options.otherBookingsError ? null : options.otherBookings ?? [],
      options.otherBookingsError ? { message: "boom" } : null,
    );

    const venueChain: any = {};
    venueChain.eq = () => venueChain;
    venueChain.maybeSingle = resolved(options.venue === undefined ? venueRow : options.venue, null);

    const periodsChain: any = {};
    periodsChain.eq = () => periodsChain;
    periodsChain.lte = () => periodsChain;
    periodsChain.gte = resolved(
      options.periodsError ? null : options.periods ?? [],
      options.periodsError ? { message: "boom" } : null,
    );

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "venue_bookings") return { select: () => bookingByIdChain };
        if (table === "venues") return { select: () => venueChain };
        if (table === "venue_unavailability") return { select: () => periodsChain };
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const status = options.eventsStatus ?? 200;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ events: options.events ?? [] }),
      }),
    );

    (globalThis as any).__mockSupabase = supabase;
    (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

    const app = express();
    app.use("/api/venues", venuesRouter);
    return { app };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function checkAvailability(app: express.Express, query: Record<string, string> = {}, bookingId = "55") {
    return request(app)
      .get(`/api/venues/bookings/${bookingId}/availability-check`)
      .query({ proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00", ...query })
      .set("Authorization", "Bearer test-token");
  }

  describe("GET /api/venues/bookings/:bookingId/availability-check", () => {
    it("is coordinator-only", async () => {
      const { app } = buildApp({ user: { id: "ORG-0001", role: "organiser" } });
      const res = await checkAvailability(app);
      expect(res.status).toBe(403);
    });

    it("400s an invalid booking id", async () => {
      const { app } = buildApp();
      const res = await checkAvailability(app, {}, "abc");
      expect(res.status).toBe(400);
    });

    it("400s a missing proposedDate", async () => {
      const { app } = buildApp();
      const res = await checkAvailability(app, { proposedDate: "" });
      expect(res.status).toBe(400);
      expect(res.body.fields.proposedDate).toBeDefined();
    });

    it("400s an invalid time", async () => {
      const { app } = buildApp();
      const res = await checkAvailability(app, { startTime: "25:99" });
      expect(res.status).toBe(400);
    });

    it("404s an unknown booking", async () => {
      const { app } = buildApp({ booking: null });
      const res = await checkAvailability(app);
      expect(res.status).toBe(404);
    });

    it("500s when the booking lookup fails", async () => {
      const { app } = buildApp({ bookingError: true });
      const res = await checkAvailability(app);
      expect(res.status).toBe(500);
    });

    it("is available when there's no clashing period or rival booking", async () => {
      const { app } = buildApp({});
      const res = await checkAvailability(app);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true, unavailabilityConflict: null, bookingConflict: null });
    });

    it("flags an unavailability period that overlaps the proposed window", async () => {
      const { app } = buildApp({
        periods: [
          {
            id: 1,
            venue_id: 3,
            start_date: "2026-11-10",
            end_date: "2026-11-10",
            all_day: true,
            start_time: null,
            end_time: null,
            reason: "maintenance",
          },
        ],
      });
      const res = await checkAvailability(app);
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(res.body.unavailabilityConflict).toEqual({
        reason: "maintenance",
        description: "on 2026-11-10 (all day)",
      });
      expect(res.body.bookingConflict).toBeNull();
    });

    it("flags a rival booking whose event overlaps the proposed window, excluding this booking's own", async () => {
      const { app } = buildApp({
        otherBookings: [{ id: 900, venue_id: 3, event_id: 7, status: "Approved", hold_expires_at: null }],
        events: [{ id: 7, proposedDate: "2026-11-10", startTime: "11:00", endTime: "13:00" }],
      });
      const res = await checkAvailability(app);
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(false);
      expect(res.body.bookingConflict).toEqual({
        bookingId: 900,
        status: "Approved",
        window: expect.stringContaining("2026-11-10"),
      });
    });

    it("excludes this booking's own id from the rival scan", async () => {
      // Even if the booking itself were somehow returned by the rival query,
      // blockingWindows filters it out by id — same booking can't conflict
      // with itself.
      const { app } = buildApp({
        otherBookings: [{ id: 55, venue_id: 3, event_id: 7, status: "Approved", hold_expires_at: null }],
        events: [{ id: 7, proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00" }],
      });
      const res = await checkAvailability(app);
      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
    });

    it("500s when the unavailability lookup fails", async () => {
      const { app } = buildApp({ periodsError: true });
      const res = await checkAvailability(app);
      expect(res.status).toBe(500);
    });

    it("502s when the rival bookings' events can't be loaded", async () => {
      const { app } = buildApp({
        otherBookings: [{ id: 900, venue_id: 3, event_id: 7, status: "Approved", hold_expires_at: null }],
        eventsStatus: 500,
      });
      const res = await checkAvailability(app);
      expect(res.status).toBe(502);
    });
  });
});

describe("recommendations", () => {
  const venues: VenueRow[] = [
    {
      id: 1,
      name: "Grand Ballroom",
      location: "Central Campus",
      description: null,
      capacity: 400,
      accessibility: ["Wheelchair access", "Lift access"],
      layouts: ["Banquet", "Theatre"],
      facilities: ["PA system", "Stage", "Projector"],
    },
    {
      id: 2,
      name: "Seminar Room 3-01",
      location: "North Campus",
      description: null,
      capacity: 40,
      accessibility: ["Wheelchair access"],
      layouts: ["Classroom", "Theatre"],
      facilities: ["Projector", "Whiteboard"],
    },
    {
      id: 3,
      name: "Innovation Hub",
      location: "North Campus",
      description: null,
      capacity: 180,
      accessibility: ["Wheelchair access", "Hearing loop"],
      layouts: ["Cabaret", "Theatre"],
      facilities: ["Projector", "PA system", "Wi-Fi"],
    },
    {
      id: 4,
      name: "Rooftop Terrace",
      location: "Downtown Annex",
      description: null,
      capacity: 150,
      accessibility: [],
      layouts: ["Banquet"],
      facilities: ["Outdoor space", "Karaoke machine"],
    },
    {
      id: 5,
      name: "Lecture Theatre 1",
      location: "Central Campus",
      description: null,
      capacity: 180,
      accessibility: ["Wheelchair access"],
      layouts: ["Theatre"],
      facilities: ["Projector", "PA system", "Microphones"],
    },
  ];

  const NA_DETAILS = { venue: "NA", accessibility: "N/A", equipment: "None", technicalSupport: "nil" };

  function details(overrides: Record<string, unknown> = {}) {
    return {
      name: "Guest Lecture",
      proposedDate: "2026-11-10",
      startTime: "14:00",
      endTime: "16:00",
      expectedAttendance: 100,
      ...NA_DETAILS,
      ...overrides,
    };
  }

  /** venue_bookings only links a venue to an event; the schedule is the event's own. */
  type Booking = { venue_id: number; event_id: number; status?: string; hold_expires_at?: string | null };

  function buildApp(
    options: {
      user?: { id: string; role: string };
      event?: Record<string, unknown>;
      eventStatus?: number;
      bookings?: Booking[];
      bookingEvents?: Record<string, unknown>[];
    } = {},
  ) {
    // Only "On Hold" (unexpired) and "Approved" bookings block a venue, so a
    // fixture that means to block defaults to "Approved".
    const bookingRows = (options.bookings ?? []).map((booking) => ({
      id: booking.venue_id * 100 + booking.event_id,
      status: "Approved",
      hold_expires_at: null,
      ...booking,
    }));
    const bookingsQuery = {
      in: vi.fn().mockResolvedValue({ data: bookingRows, error: null }),
    };

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "venues") {
          return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: venues, error: null }) }) };
        }
        if (table === "venue_bookings") return { select: vi.fn().mockReturnValue(bookingsQuery) };
        // E4-3: no block-out periods in these tests.
        if (table === "venue_unavailability") {
          return { select: () => ({ lte: () => ({ gte: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const status = options.eventStatus ?? 200;
    // fetchEvent (GET /api/events/:id) and fetchVenueBookingInfo (GET
    // /api/events/venue-booking-info) both go through global fetch — tell
    // them apart by URL, same as findUnavailableVenueIds/staff.ts do in
    // production, just via different real endpoints.
    const fetchMock = vi.fn((url: string) => {
      if (url.includes("venue-booking-info")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ events: options.bookingEvents ?? [] }) });
      }
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ event: { id: 7, status: "Planning", submitted_details: options.event ?? details() } }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    (globalThis as any).__mockSupabase = supabase;
    (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

    const app = express();
    app.use("/api/venues", venuesRouter);
    return { app, supabase, bookingsQuery, fetchMock };
  }

  function recommend(app: express.Express, eventId = "7") {
    return request(app).get(`/api/venues/recommendations/${eventId}`).set("Authorization", "Bearer test-token");
  }

  const ids = (body: { venues: VenueRow[] }) => body.venues.map((v) => v.id);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("extractFeatures", () => {
    it("maps the organiser's wording onto venue feature values", () => {
      expect(extractFeatures("Wheelchair-accessible pathways and a sign-language interpreter")).toEqual({
        accessibility: ["Wheelchair access"],
        layouts: [],
        facilities: [],
      });
      expect(extractFeatures("20 gazebo tents, PA system, wireless mics, theatre-style seating").facilities).toEqual([
        "PA system",
        "Microphones",
      ]);
      expect(extractFeatures("theatre-style seating").layouts).toEqual(["Theatre"]);
    });

    it("prefers the longest phrase, so 'accessible parking' isn't also 'Parking'", () => {
      const found = extractFeatures("Accessible parking near the entrance");
      expect(found.accessibility).toEqual(["Accessible parking"]);
      expect(found.facilities).toEqual([]);
    });

    it("ignores features the organiser says they don't need", () => {
      expect(extractFeatures("Projector needed, no stage").facilities).toEqual(["Projector"]);
      expect(extractFeatures("We don't need a projector or screen").facilities).toEqual([]);
    });

    it("does not match inside other words", () => {
      expect(extractFeatures("Film screening, outstanding speakers").facilities).toEqual([]);
      expect(extractFeatures("Film screening, outstanding speakers").layouts).toEqual([]);
    });

    it("recognises venue-specific values that aren't in the standard catalogue", () => {
      expect(extractFeatures("Karaoke machine for the after-party", venues).facilities).toEqual(["Karaoke machine"]);
    });

    it("treats NA-style answers as no preference", () => {
      for (const value of ["NA", "n/a", "N/A.", "None", "nil", "-", "No preference", "", "  "]) {
        expect(isNoPreference(value)).toBe(true);
      }
      expect(isNoPreference("Projector")).toBe(false);
    });
  });

  describe("extractRequirements", () => {
    it("combines features from every requirement field with the schedule and attendance", () => {
      const requirements = extractRequirements(
        details({ venue: "Theatre layout", accessibility: "Hearing loop", equipment: "Projector", technicalSupport: "AV tech" }),
      );
      expect(requirements).toEqual({
        attendance: 100,
        date: "2026-11-10",
        startTime: "14:00",
        endTime: "16:00",
        accessibility: ["Hearing loop"],
        layouts: ["Theatre"],
        facilities: ["Projector"],
      });
    });

    it("rounds a fractional attendance up to whole seats", () => {
      expect(extractRequirements(details({ expectedAttendance: 180.5 })).attendance).toBe(181);
    });
  });

  describe("GET /api/venues/recommendations/:eventId", () => {
    it("AC1: a venue meeting all of the event's requirements is recommended", async () => {
      const { app } = buildApp({
        event: details({ accessibility: "Hearing loop", equipment: "Projector and Wi-Fi", venue: "Theatre-style" }),
      });
      const res = await recommend(app);

      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual([3]);
      // Wi-Fi is a minor feature, so it isn't part of the check.
      expect(res.body.requirements.facilities).toEqual(["Projector"]);
    });

    it("AC2: a venue whose capacity is below the expected attendance is not recommended", async () => {
      const { app } = buildApp({ event: details({ expectedAttendance: 181, equipment: "Projector" }) });
      const res = await recommend(app);

      expect(res.status).toBe(200);
      // 40- and 180-seat venues are out; only the 400-seat ballroom fits.
      expect(ids(res.body)).toEqual([1]);
    });

    it("AC3: a venue whose capacity equals the expected attendance exactly is suitable", async () => {
      const { app } = buildApp({ event: details({ expectedAttendance: 180, equipment: "Projector" }) });
      const res = await recommend(app);

      expect(res.status).toBe(200);
      expect(ids(res.body)).toEqual(expect.arrayContaining([3, 5]));
    });

    it("AC4: a venue missing a required facility is not recommended", async () => {
      const { app } = buildApp({ event: details({ equipment: "Microphones" }) });
      const res = await recommend(app);

      expect(ids(res.body)).toEqual([5]);
    });

    it("checks only main features, not minor ones like power outlets or a registration desk", async () => {
      const { app } = buildApp({
        event: details({
          equipment: "Microphones, power outlets, registration desk",
          accessibility: "Wheelchair access, accessible seating",
        }),
      });
      const res = await recommend(app);

      // Lecture Theatre 1 has neither power outlets, a registration desk nor accessible seating.
      expect(ids(res.body)).toEqual([5]);
      expect(res.body.requirements).toMatchObject({ accessibility: ["Wheelchair access"], facilities: ["Microphones"] });
    });

    it("AC4: a venue missing a required layout is not recommended", async () => {
      const { app } = buildApp({ event: details({ venue: "Cabaret layout please" }) });
      const res = await recommend(app);

      expect(ids(res.body)).toEqual([3]);
    });

    it("AC4: a venue missing a required accessibility feature is not recommended", async () => {
      const { app } = buildApp({ event: details({ accessibility: "Lift access for two attendees" }) });
      const res = await recommend(app);

      expect(ids(res.body)).toEqual([1]);
    });

    it("AC5: returns no venues when nothing meets every requirement", async () => {
      const { app } = buildApp({ event: details({ expectedAttendance: 500 }) });
      const res = await recommend(app);

      expect(res.status).toBe(200);
      expect(res.body.venues).toEqual([]);
    });

    it("treats NA requirement fields as no preference", async () => {
      const { app } = buildApp({ event: details() });
      const res = await recommend(app);

      expect(res.body.requirements).toMatchObject({ accessibility: [], layouts: [], facilities: [] });
      expect(res.body.venues).toHaveLength(4);
    });

    it("returns every suitable venue, tightest fit first", async () => {
      const { app } = buildApp({ event: details({ expectedAttendance: 30 }) });
      const res = await recommend(app);

      expect(ids(res.body)).toEqual([2, 4, 3, 5, 1]);
    });

    it("excludes venues booked at the event's time, but not a booking held for this event", async () => {
      const { app, bookingsQuery, fetchMock } = buildApp({
        event: details({ equipment: "Projector" }),
        bookings: [
          { venue_id: 1, event_id: 20, status: "Approved", hold_expires_at: null },
          { venue_id: 3, event_id: 7, status: "Approved", hold_expires_at: null },
          { venue_id: 5, event_id: 21, status: "Approved", hold_expires_at: null },
        ],
        bookingEvents: [
          { id: 20, proposedDate: "2026-11-10", startTime: "15:00", endTime: "18:00" }, // overlaps 14:00-16:00
          { id: 21, proposedDate: "2026-11-10", startTime: "09:00", endTime: "12:00" }, // same day, no overlap
        ],
      });
      const res = await recommend(app);

      expect(bookingsQuery.in).toHaveBeenCalledWith("status", ["On Hold", "Approved"]);
      // The event's own booking (event 7) isn't looked up: it never counts against it.
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/events\/venue-booking-info\?ids=20,21$/),
        { headers: { Authorization: "Bearer test-token" } },
      );
      expect(ids(res.body)).toEqual([3, 5]);
    });

    it("loads the event from events-service with the caller's token", async () => {
      const { app, fetchMock } = buildApp();
      await recommend(app);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/events\/7$/),
        expect.objectContaining({ headers: { Authorization: "Bearer test-token" } }),
      );
    });

    it("returns 404 when events-service denies or can't find the event", async () => {
      const { app } = buildApp({ eventStatus: 403 });
      const res = await recommend(app);
      expect(res.status).toBe(404);
    });

    it("returns 502 when events-service fails", async () => {
      const { app } = buildApp({ eventStatus: 500 });
      const res = await recommend(app);
      expect(res.status).toBe(502);
    });

    it("returns 400 for a malformed event id", async () => {
      const { app, fetchMock } = buildApp();
      const res = await recommend(app, "abc");
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is coordinator-only", async () => {
      const { app } = buildApp({ user: { id: "ORG-0001", role: "organiser" } });
      const res = await recommend(app);
      expect(res.status).toBe(403);
    });
  });
});

describe("venue listing and search", () => {
  const venues: VenueRow[] = [
    {
      id: 1,
      name: "Grand Ballroom",
      location: "Central Campus",
      description: "Chandeliered hall",
      capacity: 400,
      accessibility: ["Wheelchair access", "Lift access"],
      layouts: ["Banquet", "Theatre"],
      facilities: ["PA system", "Stage", "Catering kitchen"],
    },
    {
      id: 2,
      name: "Seminar Room 3-01",
      location: "North Campus",
      description: null,
      capacity: 40,
      accessibility: ["Wheelchair access"],
      layouts: ["Classroom", "Boardroom"],
      facilities: ["Projector", "Whiteboard"],
    },
    {
      id: 3,
      name: "Innovation Hub",
      location: "North Campus",
      description: "Open-plan co-working space",
      capacity: 180,
      accessibility: ["Wheelchair access", "Hearing loop"],
      layouts: ["Cabaret", "Classroom"],
      facilities: ["Projector", "PA system", "Wi-Fi"],
    },
    {
      id: 4,
      name: "Rooftop Terrace",
      location: "Downtown Annex",
      description: null,
      capacity: 150,
      accessibility: [],
      layouts: ["Banquet"],
      facilities: ["Outdoor space", "Catering kitchen"],
    },
  ];

  const none = new Set<number>();

  function criteriaOf(query: Record<string, unknown>) {
    const parsed = parseVenueSearch(query);
    if (!parsed.valid) throw new Error(`unexpected invalid query: ${JSON.stringify(parsed.fields)}`);
    return parsed.criteria;
  }

  describe("parseVenueSearch", () => {
    it("accepts an empty query as no criteria", () => {
      expect(parseVenueSearch({})).toEqual({ valid: true, criteria: {} });
    });

    it("reads list params from repeated keys and comma-separated values", () => {
      const criteria = criteriaOf({ facilities: ["Projector", "Wi-Fi,PA system"], layouts: "Classroom" });
      expect(criteria.facilities).toEqual(["Projector", "Wi-Fi", "PA system"]);
      expect(criteria.layouts).toEqual(["Classroom"]);
    });

    it("rejects a time window without a date", () => {
      const parsed = parseVenueSearch({ startTime: "09:00", endTime: "11:00" });
      expect(parsed.valid).toBe(false);
      expect(!parsed.valid && parsed.fields.date).toBeDefined();
    });

    it("rejects an end time that isn't after the start time", () => {
      const parsed = parseVenueSearch({ date: "2026-09-25", startTime: "18:00", endTime: "17:00" });
      expect(!parsed.valid && parsed.fields.endTime).toBe("End time must be after start time");
    });

    it("rejects impossible dates and non-numeric attendance", () => {
      const parsed = parseVenueSearch({ date: "2026-02-30", attendance: "lots" });
      expect(!parsed.valid && Object.keys(parsed.fields).sort()).toEqual(["attendance", "date"]);
    });

    it("rejects a capacity band whose minimum exceeds its maximum", () => {
      const parsed = parseVenueSearch({ capacityMin: "300", capacityMax: "100" });
      expect(!parsed.valid && parsed.fields.capacityMax).toBeDefined();
    });
  });

  describe("searchVenues", () => {
    it("AC1: every venue returned satisfies all selected criteria", () => {
      const criteria = criteriaOf({ attendance: "100", facilities: "PA system", accessibility: "Wheelchair access" });
      const { venues: result } = searchVenues(venues, criteria, none);

      expect(result.map((v) => v.name)).toEqual(["Innovation Hub", "Grand Ballroom"]);
      for (const venue of result) {
        expect(venue.capacity).toBeGreaterThanOrEqual(100);
        expect(venue.facilities).toContain("PA system");
        expect(venue.accessibility).toContain("Wheelchair access");
      }
    });

    it("requires ALL selected facilities, not any", () => {
      const criteria = criteriaOf({ facilities: ["Projector", "Wi-Fi"] });
      expect(searchVenues(venues, criteria, none).venues.map((v) => v.id)).toEqual([3]);
    });

    it("treats multiple locations as any-of", () => {
      const criteria = criteriaOf({ locations: ["North Campus", "Downtown Annex"] });
      expect(searchVenues(venues, criteria, none).venues.map((v) => v.id).sort()).toEqual([2, 3, 4]);
    });

    it("applies the capacity band inclusively", () => {
      const criteria = criteriaOf({ capacityMin: "150", capacityMax: "180" });
      expect(searchVenues(venues, criteria, none).venues.map((v) => v.id)).toEqual([4, 3]);
    });

    it("AC2: excludes venues unavailable in the requested window", () => {
      const criteria = criteriaOf({ date: "2026-09-25", startTime: "18:00", endTime: "21:00" });
      const result = searchVenues(venues, criteria, new Set([1]));
      expect(result.venues.map((v) => v.id)).not.toContain(1);
      expect(result.venues).toHaveLength(3);
    });

    it("ignores bookings when no date is being searched", () => {
      expect(searchVenues(venues, {}, new Set([1])).venues).toHaveLength(4);
    });

    it("matches free text against name, location and description", () => {
      expect(searchVenues(venues, criteriaOf({ q: "co-working" }), none).venues.map((v) => v.id)).toEqual([3]);
      expect(searchVenues(venues, criteriaOf({ q: "annex" }), none).venues.map((v) => v.id)).toEqual([4]);
    });

    it("AC3: when nothing matches, suggests which filter to relax", () => {
      const criteria = criteriaOf({ layouts: "Boardroom", facilities: "Catering kitchen" });
      const result = searchVenues(venues, criteria, none);

      expect(result.venues).toEqual([]);
      expect(result.relax).toEqual([
        { key: "layouts", label: "Layout", count: 2 },
        { key: "facilities", label: "Facilities", count: 1 },
      ]);
    });

    it("omits relax options that still wouldn't return anything", () => {
      const criteria = criteriaOf({ attendance: "1000", layouts: "Boardroom" });
      const result = searchVenues(venues, criteria, none);
      expect(result.relax.map((r) => r.key)).toEqual(["attendance"]);
    });
  });

  describe("buildFilterOptions", () => {
    it("derives sorted, de-duplicated locations and the capacity range", () => {
      const options = buildFilterOptions(venues);
      expect(options.locations).toEqual(["Central Campus", "Downtown Annex", "North Campus"]);
      expect(options.capacity).toEqual({ min: 40, max: 400 });
    });

    it("offers the standard catalogue even when no venue uses an option yet", () => {
      const options = buildFilterOptions([]);
      expect(options.facilities).toEqual([...OPTION_CATALOGUE.facilities]);
      expect(options.layouts).toContain("Hollow square");
      expect(options.capacity).toBeNull();
    });

    it("appends venue-specific values after the catalogue without duplicating it", () => {
      const options = buildFilterOptions([
        { ...venues[0], layouts: ["theatre", "Fishbowl"], facilities: ["Projector", "Karaoke machine"] },
      ]);
      expect(options.layouts).toEqual([...OPTION_CATALOGUE.layouts, "Fishbowl"]);
      expect(options.facilities.at(-1)).toBe("Karaoke machine");
      expect(options.facilities.filter((f) => f === "Projector")).toHaveLength(1);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A booked event's schedule, as events-service's /venue-booking-info returns it. */
  function bookedEvent(id: number, proposedDate: string, startTime: string, endTime: string) {
    return { id, name: `Event ${id}`, proposedDate, startTime, endTime, expectedAttendance: 50 };
  }

  function buildApp(
    options: {
      user?: { id: string; role: string };
      bookings?: { venue_id: number; event_id: number; status?: string; hold_expires_at?: string | null }[];
      bookedEvents?: ReturnType<typeof bookedEvent>[];
      /** E4-3 block-out periods, read by findBlockedVenueIds. */
      unavailability?: Record<string, unknown>[];
      /** Setup/turnaround minutes by venue id, merged onto the venue rows. */
      buffers?: Record<number, { setup_minutes?: number; turnaround_minutes?: number }>;
    } = {},
  ) {
    // E4-3: block-out periods, read as select → lte(start_date) → gte(end_date).
    const unavailabilityGte = vi.fn().mockResolvedValue({ data: options.unavailability ?? [], error: null });
    const unavailabilityLte = vi.fn().mockReturnValue({ gte: unavailabilityGte });

    // venue_bookings only links a venue to an event; its schedule comes from
    // events-service. Only "On Hold" (unexpired) and "Approved" bookings block a
    // venue, so a fixture that means to block defaults to "Approved".
    const bookingRows = (options.bookings ?? []).map((booking) => ({
      id: booking.venue_id * 100 + booking.event_id,
      status: "Approved",
      hold_expires_at: null,
      ...booking,
    }));
    // Read two ways: the blocking-status query (.in("status", …)) and the
    // block-out check, which awaits the builder with no filter at all.
    const bookingsIn = vi.fn().mockResolvedValue({ data: bookingRows, error: null });
    const bookingsQuery = {
      in: bookingsIn,
      then: (resolve: (value: unknown) => unknown) => resolve({ data: bookingRows, error: null }),
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events: options.bookedEvents ?? [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const venueRows = venues.map((venue) => ({ ...venue, ...options.buffers?.[venue.id] }));
    const venuesEq = vi.fn().mockResolvedValue({ data: venueRows, error: null });

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "venues") return { select: vi.fn().mockReturnValue({ eq: venuesEq }) };
        if (table === "venue_bookings") return { select: vi.fn().mockReturnValue(bookingsQuery) };
        if (table === "venue_unavailability") return { select: () => ({ lte: unavailabilityLte }) };
        throw new Error(`unexpected table ${table}`);
      }),
    };

    (globalThis as any).__mockSupabase = supabase;
    (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

    const app = express();
    app.use(express.json());
    app.use("/api/venues", venuesRouter);
    return { app, supabase, bookingsQuery, fetchMock, unavailabilityLte, unavailabilityGte };
  }

  describe("GET /api/venues", () => {
    it("is coordinator-only", async () => {
      const { app } = buildApp({ user: { id: "ORG-0001", role: "organiser" } });
      const res = await request(app).get("/api/venues");
      expect(res.status).toBe(403);
    });

    it("returns 400 with field errors for an invalid search", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/api/venues").query({ startTime: "09:00", endTime: "10:00" });
      expect(res.status).toBe(400);
      expect(res.body.fields.date).toBeDefined();
    });

    it("AC2: excludes venues whose booked event overlaps the window, using the event's own schedule", async () => {
      const { app, bookingsQuery, fetchMock } = buildApp({
        bookings: [
          { venue_id: 1, event_id: 11, status: "Approved", hold_expires_at: null },
          { venue_id: 2, event_id: 12, status: "Approved", hold_expires_at: null },
        ],
        bookedEvents: [
          bookedEvent(11, "2026-09-25", "17:00", "22:00"), // overlaps 18:00-21:00
          bookedEvent(12, "2026-09-25", "09:00", "12:00"), // same day, no overlap
        ],
      });
      const res = await request(app)
        .get("/api/venues")
        .query({ date: "2026-09-25", startTime: "18:00", endTime: "21:00" })
        .set("Authorization", "Bearer test-token");

      expect(res.status).toBe(200);
      // Only a hold or an approved booking holds the venue; a request does not.
      expect(bookingsQuery.in).toHaveBeenCalledWith("status", ["On Hold", "Approved"]);
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/events\/venue-booking-info\?ids=11,12$/),
        { headers: { Authorization: "Bearer test-token" } },
      );
      const ids = res.body.venues.map((v: VenueRow) => v.id);
      expect(ids).not.toContain(1);
      expect(ids).toContain(2);
    });

    it("AC2: without a time window, any booked event that day makes the venue unavailable", async () => {
      const { app } = buildApp({
        bookings: [
          { venue_id: 1, event_id: 11, status: "Approved", hold_expires_at: null },
          { venue_id: 2, event_id: 12, status: "Approved", hold_expires_at: null },
        ],
        bookedEvents: [bookedEvent(11, "2026-09-25", "09:00", "10:00"), bookedEvent(12, "2026-09-26", "09:00", "10:00")],
      });
      const res = await request(app).get("/api/venues").query({ date: "2026-09-25" }).set("Authorization", "Bearer t");

      const ids = res.body.venues.map((v: VenueRow) => v.id);
      expect(ids).not.toContain(1);
      expect(ids).toContain(2);
    });

    it("returns 500 when booked events can't be loaded from events-service", async () => {
      const { app, fetchMock } = buildApp({ bookings: [{ venue_id: 1, event_id: 11, status: "Approved", hold_expires_at: null }] });
      fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
      const res = await request(app).get("/api/venues").query({ date: "2026-09-25" }).set("Authorization", "Bearer t");

      expect(res.status).toBe(500);
    });

    it("E4-3 AC3: keeps a venue whose approved booking is on a different date", async () => {
      const { app } = buildApp({
        bookings: [{ venue_id: 1, event_id: 42, status: "Approved", hold_expires_at: null }],
        bookedEvents: [bookedEvent(42, "2026-09-01", "18:00", "21:00")],
      });
      const res = await request(app)
        .get("/api/venues")
        .query({ date: "2026-09-25", startTime: "18:00", endTime: "21:00" });

      expect(res.status).toBe(200);
      expect(res.body.venues.map((v: VenueRow) => v.id)).toContain(1);
    });

    it("E4-3 AC3: excludes a venue blocked out for the requested window", async () => {
      const { app } = buildApp({
        unavailability: [
          { id: 1, venue_id: 1, start_date: "2026-09-24", end_date: "2026-09-26", all_day: false,
            start_time: "17:00:00", end_time: "19:00:00", reason: "Maintenance" },
          { id: 2, venue_id: 2, start_date: "2026-09-25", end_date: "2026-09-25", all_day: true,
            start_time: null, end_time: null, reason: "Private hire" },
        ],
      });
      const res = await request(app)
        .get("/api/venues")
        .query({ date: "2026-09-25", startTime: "18:00", endTime: "21:00" });

      expect(res.status).toBe(200);
      const ids = res.body.venues.map((v: VenueRow) => v.id);
      expect(ids).not.toContain(1);
      expect(ids).not.toContain(2);
    });

    it("E4-3 AC3: keeps a venue whose block-out hours don't overlap the window", async () => {
      const { app } = buildApp({
        unavailability: [
          { id: 1, venue_id: 1, start_date: "2026-09-25", end_date: "2026-09-25", all_day: false,
            start_time: "09:00:00", end_time: "13:00:00", reason: "Maintenance" },
        ],
      });
      const res = await request(app)
        .get("/api/venues")
        .query({ date: "2026-09-25", startTime: "18:00", endTime: "21:00" });

      expect(res.status).toBe(200);
      expect(res.body.venues.map((v: VenueRow) => v.id)).toContain(1);
    });

    it("E4-3 AC3: counts the venue's setup time against a block-out ending at the slot's start", async () => {
      const { app } = buildApp({
        unavailability: [
          { id: 1, venue_id: 1, start_date: "2026-09-25", end_date: "2026-09-25", all_day: false,
            start_time: "16:00:00", end_time: "18:00:00", reason: "Maintenance" },
        ],
        buffers: { 1: { setup_minutes: 30, turnaround_minutes: 0 } },
      });
      const res = await request(app)
        .get("/api/venues")
        .query({ date: "2026-09-25", startTime: "18:00", endTime: "21:00" });

      expect(res.status).toBe(200);
      expect(res.body.venues.map((v: VenueRow) => v.id)).not.toContain(1);
    });

    describe("E4-16: setup and turnaround in search", () => {
      const search = (app: express.Express, startTime: string, endTime: string, date = "2026-09-25") =>
        request(app).get("/api/venues").query({ date, startTime, endTime }).set("Authorization", "Bearer t");
      const idsOf = (res: { body: { venues: VenueRow[] } }) => res.body.venues.map((v) => v.id);
      const searchDay = (app: express.Express, date = "2026-09-25") =>
        request(app).get("/api/venues").query({ date }).set("Authorization", "Bearer t");

      it("date-only search: any block-out on that day excludes the venue, one on another day doesn't", async () => {
        const { app } = buildApp({
          unavailability: [
            { id: 1, venue_id: 2, start_date: "2026-09-25", end_date: "2026-09-25", all_day: false,
              start_time: "14:00:00", end_time: "16:00:00", reason: "Maintenance" },
            { id: 2, venue_id: 3, start_date: "2026-09-26", end_date: "2026-09-26", all_day: true,
              start_time: null, end_time: null, reason: "Private hire" },
          ],
        });
        const res = await searchDay(app);

        expect(res.status).toBe(200);
        expect(idsOf(res)).not.toContain(2);
        expect(idsOf(res)).toContain(3);
      });

      it("date-only search: the whole day is padded by setup, so a block-out late the night before can exclude it", async () => {
        // Venue 1 needs 60 min setup, so its day starts at 23:00 the night before,
        // inside a 23:30–23:59 block-out. Venue 3 has no setup and isn't affected.
        const { app } = buildApp({
          buffers: { 1: { setup_minutes: 60, turnaround_minutes: 0 } },
          unavailability: [
            { id: 1, venue_id: 1, start_date: "2026-09-24", end_date: "2026-09-24", all_day: false,
              start_time: "23:30:00", end_time: "23:59:00", reason: "Late maintenance" },
            { id: 2, venue_id: 3, start_date: "2026-09-24", end_date: "2026-09-24", all_day: false,
              start_time: "23:30:00", end_time: "23:59:00", reason: "Late maintenance" },
          ],
        });
        const res = await searchDay(app);

        expect(res.status).toBe(200);
        expect(idsOf(res)).not.toContain(1);
        expect(idsOf(res)).toContain(3);
      });

      it("AC1: excludes a venue when the padded windows overlap, though the bare times don't", async () => {
        // Venue 1 (30 setup, 45 turnaround): booking 09:00–11:00 occupies 08:30–11:45;
        // a 12:00–14:00 request needs 11:30–14:45. Venue 2 has no buffers.
        const { app } = buildApp({
          buffers: { 1: { setup_minutes: 30, turnaround_minutes: 45 } },
          bookings: [
            { venue_id: 1, event_id: 11 },
            { venue_id: 2, event_id: 12 },
          ],
          bookedEvents: [bookedEvent(11, "2026-09-25", "09:00", "11:00"), bookedEvent(12, "2026-09-25", "09:00", "11:00")],
        });
        const res = await search(app, "12:00", "14:00");

        expect(res.status).toBe(200);
        expect(idsOf(res)).not.toContain(1);
        // AC2: with no setup/turnaround configured, only the bookings' own times count.
        expect(idsOf(res)).toContain(2);
      });

      it("AC1: an On Hold booking's padded window excludes the venue too", async () => {
        // Booking 14:00–16:00 with 30 setup starts at 13:30; the 11:00–13:00 request ends at 13:45 with turnaround.
        const { app } = buildApp({
          buffers: { 1: { setup_minutes: 30, turnaround_minutes: 45 } },
          bookings: [{ venue_id: 1, event_id: 11, status: "On Hold", hold_expires_at: "2999-01-01T00:00:00Z" }],
          bookedEvents: [bookedEvent(11, "2026-09-25", "14:00", "16:00")],
        });
        expect(idsOf(await search(app, "11:00", "13:00"))).not.toContain(1);
      });

      it("AC2: with no setup or turnaround, back-to-back bookings don't conflict", async () => {
        const { app } = buildApp({
          bookings: [{ venue_id: 2, event_id: 12 }],
          bookedEvents: [bookedEvent(12, "2026-09-25", "09:00", "11:00")],
        });
        expect(idsOf(await search(app, "11:00", "13:00"))).toContain(2);
        expect(idsOf(await search(app, "10:59", "13:00"))).not.toContain(2);
      });

      it("AC3: includes the venue when start minus setup equals the booking's padded end; one minute earlier excludes it", async () => {
        // Booking 09:00–11:00 + 45 turnaround ends at 11:45. 12:15 − 30 setup = 11:45.
        const { app } = buildApp({
          buffers: { 1: { setup_minutes: 30, turnaround_minutes: 45 } },
          bookings: [{ venue_id: 1, event_id: 11 }],
          bookedEvents: [bookedEvent(11, "2026-09-25", "09:00", "11:00")],
        });
        expect(idsOf(await search(app, "12:15", "14:00"))).toContain(1);
        expect(idsOf(await search(app, "12:14", "14:00"))).not.toContain(1);
      });

      it("AC3 (mirror): includes the venue when end plus turnaround equals the booking's padded start", async () => {
        // Booking 14:00–16:00 − 30 setup starts at 13:30. 12:45 + 45 turnaround = 13:30.
        const { app } = buildApp({
          buffers: { 1: { setup_minutes: 30, turnaround_minutes: 45 } },
          bookings: [{ venue_id: 1, event_id: 11 }],
          bookedEvents: [bookedEvent(11, "2026-09-25", "14:00", "16:00")],
        });
        expect(idsOf(await search(app, "11:00", "12:45"))).toContain(1);
        expect(idsOf(await search(app, "11:00", "12:46"))).not.toContain(1);
      });

      it("looks up booked events in batches of 100, so a busy venue list doesn't fail the search", async () => {
        // 150 booked events at venue 3; only the last one, in the second batch, clashes.
        const eventIds = Array.from({ length: 150 }, (_, i) => 1001 + i);
        const clash = bookedEvent(1150, "2026-09-25", "18:00", "20:00");
        const { app, fetchMock } = buildApp({ bookings: eventIds.map((id) => ({ venue_id: 3, event_id: id })) });
        fetchMock.mockImplementation(async (url: string) => {
          const ids = new URL(url).searchParams.get("ids")!.split(",").map(Number);
          return { ok: true, status: 200, json: async () => ({ events: ids.includes(1150) ? [clash] : [] }) };
        });
        const res = await search(app, "19:00", "21:00");

        expect(res.status).toBe(200);
        const batchSizes = fetchMock.mock.calls.map(([url]) => new URL(url as string).searchParams.get("ids")!.split(",").length);
        expect(batchSizes).toEqual([100, 50]);
        expect(idsOf(res)).not.toContain(3);
      });

      it("fails the search if any batch of booked events can't be loaded", async () => {
        const eventIds = Array.from({ length: 150 }, (_, i) => 1001 + i);
        const { app, fetchMock } = buildApp({ bookings: eventIds.map((id) => ({ venue_id: 3, event_id: id })) });
        fetchMock
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ events: [] }) })
          .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

        expect((await search(app, "19:00", "21:00")).status).toBe(500);
      });

      it("AC1: pads the requested window against a block-out, including across midnight", async () => {
        // 00:15 − 30 setup = 23:45 the day before, inside a 23:00–23:59 block-out.
        const { app, unavailabilityLte, unavailabilityGte } = buildApp({
          buffers: { 1: { setup_minutes: 30, turnaround_minutes: 0 } },
          unavailability: [
            { id: 1, venue_id: 1, start_date: "2026-09-24", end_date: "2026-09-24", all_day: false,
              start_time: "23:00:00", end_time: "23:59:00", reason: "Late maintenance" },
          ],
        });
        const res = await search(app, "00:15", "02:00");

        expect(res.status).toBe(200);
        expect(unavailabilityLte).toHaveBeenCalledWith("start_date", "2026-09-25");
        expect(unavailabilityGte).toHaveBeenCalledWith("end_date", "2026-09-24");
        expect(idsOf(res)).not.toContain(1);
      });
    });

    it("skips the bookings lookup when no date is given", async () => {
      const { app, supabase } = buildApp();
      const res = await request(app).get("/api/venues").query({ attendance: "100" });

      expect(res.status).toBe(200);
      expect(supabase.from).not.toHaveBeenCalledWith("venue_bookings");
      expect(res.body.venues).toHaveLength(3);
    });

    it("AC3: returns relax options when nothing matches", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/api/venues").query({ layouts: "Boardroom", facilities: "Catering kitchen" });

      expect(res.status).toBe(200);
      expect(res.body.venues).toEqual([]);
      expect(res.body.relax[0]).toEqual({ key: "layouts", label: "Layout", count: 2 });
    });
  });

  describe("GET /api/venues/filters", () => {
    it("returns option lists for coordinators", async () => {
      const { app } = buildApp();
      const res = await request(app).get("/api/venues/filters");
      expect(res.status).toBe(200);
      expect(res.body.facilities).toContain("Projector");
    });
  });
});
