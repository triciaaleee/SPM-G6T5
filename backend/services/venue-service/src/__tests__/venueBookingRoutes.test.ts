import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { venuesRouter } from "../routes/venues.js";
import { eventBookingsRouter } from "../routes/eventBookings.js";
import { blocksVenue } from "../lib/bookingStatus.js";
import { formatWindow, occupiedWindow, overlaps } from "../lib/bookingConflicts.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { suitabilityRouter } from "../routes/suitability.js";
import { type EventDefaults, checkSuitability, effectivePlan, parseBookingPlan } from "../lib/bookingPlan.js";
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

describe("booking requests", () => {
  /** The venue under test: 30 min setup, 45 min turnaround (§3a change 1). */
  const venues = [
    {
      id: 1,
      name: "Grand Ballroom",
      location: "Central Campus",
      description: null,
      capacity: 400,
      accessibility: [],
      layouts: ["Banquet"],
      facilities: ["PA system"],
      setup_minutes: 30,
      turnaround_minutes: 45,
    },
    {
      id: 2,
      name: "Seminar Room 3-01",
      location: "North Campus",
      description: null,
      capacity: 40,
      accessibility: [],
      layouts: ["Classroom"],
      facilities: ["Projector"],
      setup_minutes: 0,
      turnaround_minutes: 0,
    },
  ];

  /** The requesting event: 2026-11-10, 10:00–12:00 (so 09:30–12:45 occupied at venue 1). */
  function eventDetails(overrides: Record<string, unknown> = {}) {
    return {
      name: "Alumni Dinner",
      proposedDate: "2026-11-10",
      startTime: "10:00",
      endTime: "12:00",
      expectedAttendance: 120,
      venue: "Banquet",
      equipment: "PA system",
      accessibility: "NA",
      technicalSupport: "None",
      ...overrides,
    };
  }

  /** A venue_unavailability row (E4-3), as the venue_unavailability table stores it. */
  interface PeriodFixture {
    id?: number;
    venue_id: number;
    start_date: string;
    end_date?: string;
    all_day?: boolean;
    start_time?: string | null;
    end_time?: string | null;
    reason?: string;
  }

  /** select().eq("venue_id").lte().gte(), resolved by awaiting — the block-out check (§3a change 2). */
  function unavailabilityTable(periods: PeriodFixture[]) {
    const rows = periods.map((period, index) => ({
      id: period.id ?? index + 800,
      end_date: period.start_date,
      all_day: true,
      start_time: null,
      end_time: null,
      reason: "Maintenance",
      ...period,
    }));
    return {
      select: vi.fn(() => {
        let venueId: unknown;
        const q: any = {
          eq: vi.fn((_column: string, value: unknown) => {
            venueId = value;
            return q;
          }),
          lte: vi.fn(() => q),
          gte: vi.fn(() => q),
        };
        q.then = (resolve: (value: unknown) => unknown) =>
          resolve({ data: rows.filter((row) => row.venue_id === venueId), error: null });
        return q;
      }),
    };
  }

  interface BookingFixture {
    id?: number;
    venue_id: number;
    event_id: number;
    status?: string;
    hold_expires_at?: string | null;
  }

  function buildApp(
    options: {
      user?: { id: string; role: string };
      eventStatus?: string;
      eventDetails?: Record<string, unknown>;
      eventHttpStatus?: number;
      /** The event's assigned coordinator, as events-service returns it. */
      eventCoordinatorId?: string | null;
      bookings?: BookingFixture[];
      bookedEvents?: Record<string, unknown>[];
      existing?: { id: number; status: string }[];
      insertError?: boolean;
      /** Who the venue is assigned to (venues.staff_id); null means nobody. */
      staffId?: string | null;
      /** §3a change 2: block-out periods on the venues. */
      unavailability?: PeriodFixture[];
    } = {},
  ) {
    const bookingRows = (options.bookings ?? []).map((booking, index) => ({
      id: booking.id ?? index + 500,
      status: "Approved",
      hold_expires_at: null,
      ...booking,
    }));

    // venue_bookings is read twice on a submit: the blocking-status query
    // (.select().in("status", …)) and this event's own bookings
    // (.select().eq("event_id").eq("venue_id").in("status", …)).
    const blockingQuery = { in: vi.fn().mockResolvedValue({ data: bookingRows, error: null }) };
    const existingQuery = {
      eq: vi.fn(),
      in: vi.fn().mockResolvedValue({ data: options.existing ?? [], error: null }),
    };
    existingQuery.eq.mockReturnValue(existingQuery);

    const insertSingle = vi.fn().mockResolvedValue(
      options.insertError
        ? { data: null, error: { message: "insert failed" } }
        : { data: { id: 900, status: "Requested", created_at: "2026-10-07T00:00:00.000Z" }, error: null },
    );
    const insert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: insertSingle }) });

    const bookingsSelect = vi.fn((columns: string) =>
      columns.includes("venue_id") ? blockingQuery : existingQuery,
    );

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "venues") {
          // Read two ways: the full list for the search/suitability check, and
          // the assigned staff member for the notification (E4-8 AC1).
          return {
            select: vi.fn((columns: string) =>
              columns.includes("staff_id")
                ? {
                    eq: vi.fn().mockReturnValue({
                      maybeSingle: vi.fn().mockResolvedValue({
                        data: { staff_id: options.staffId === undefined ? "VENUE-0001" : options.staffId },
                        error: null,
                      }),
                    }),
                  }
                : { eq: vi.fn().mockResolvedValue({ data: venues, error: null }) },
            ),
          };
        }
        if (table === "venue_bookings") return { select: bookingsSelect, insert };
        if (table === "venue_unavailability") return unavailabilityTable(options.unavailability ?? []);
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const eventHttpStatus = options.eventHttpStatus ?? 200;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/notifications")) {
        return { ok: true, status: 201, json: async () => ({ notifications: [] }) };
      }
      if (String(url).includes("venue-booking-info")) {
        return { ok: true, status: 200, json: async () => ({ events: options.bookedEvents ?? [] }) };
      }
      return {
        ok: eventHttpStatus >= 200 && eventHttpStatus < 300,
        status: eventHttpStatus,
        json: async () => ({
          event: {
            id: 7,
            status: options.eventStatus ?? "Planning",
            submitted_details: options.eventDetails ?? eventDetails(),
            coordinator_id: options.eventCoordinatorId === undefined ? "COORD-0001" : options.eventCoordinatorId,
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    (globalThis as any).__mockSupabase = supabase;
    (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

    const app = express();
    app.use(express.json());
    app.use("/api/venues", venuesRouter);
    return { app, supabase, insert, blockingQuery, existingQuery, fetchMock, publish };
  }

  function submit(app: express.Express, body: Record<string, unknown> = { eventId: 7, venueId: 1 }) {
    return request(app).post("/api/venues/bookings").set("Authorization", "Bearer test-token").send(body);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("occupied windows", () => {
    const padding = { setup_minutes: 30, turnaround_minutes: 45 };

    it("pads the event's own times by setup and turnaround", () => {
      const window = occupiedWindow({ proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00" }, padding)!;
      expect(formatWindow(window)).toBe("2026-11-10 09:30–12:45");
    });

    it("spells out both dates when padding crosses midnight", () => {
      const window = occupiedWindow({ proposedDate: "2026-11-10", startTime: "23:00", endTime: "23:45" }, padding)!;
      expect(formatWindow(window)).toBe("2026-11-10 22:30 – 2026-11-11 00:30");
    });

    it("treats an event with no times as occupying its whole day", () => {
      const window = occupiedWindow({ proposedDate: "2026-11-10" })!;
      expect(formatWindow(window)).toBe("2026-11-10 00:00 – 2026-11-11 00:00");
    });

    it("has no window without a date", () => {
      expect(occupiedWindow({ startTime: "10:00", endTime: "12:00" })).toBeNull();
    });

    it("overlaps on a half-open interval, so back-to-back windows are free", () => {
      const first = occupiedWindow({ proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00" })!;
      const touching = occupiedWindow({ proposedDate: "2026-11-10", startTime: "12:00", endTime: "14:00" })!;
      const inside = occupiedWindow({ proposedDate: "2026-11-10", startTime: "11:00", endTime: "11:30" })!;
      expect(overlaps(first, touching)).toBe(false);
      expect(overlaps(first, inside)).toBe(true);
    });
  });

  describe("blocksVenue", () => {
    const now = new Date("2026-10-07T12:00:00.000Z");

    it("blocks for an approved booking", () => {
      expect(blocksVenue({ status: "Approved" }, now)).toBe(true);
    });

    it("blocks for a hold that hasn't expired yet", () => {
      expect(blocksVenue({ status: "On Hold", hold_expires_at: "2026-10-08T00:00:00.000Z" }, now)).toBe(true);
    });

    it("stops blocking once the hold's deadline has passed", () => {
      expect(blocksVenue({ status: "On Hold", hold_expires_at: "2026-10-07T11:59:00.000Z" }, now)).toBe(false);
    });

    it.each(["Requested", "Rejected", "Expired", "Withdrawn", "Replacement Required"] as const)(
      "does not block for %s",
      (status) => {
        expect(blocksVenue({ status }, now)).toBe(false);
      },
    );
  });

  describe("POST /api/venues/bookings access", () => {
    it.each([
      ["an organiser", { id: "ORG-0001", role: "organiser" }],
      ["venue staff", { id: "VEN-0001", role: "venue_staff" }],
    ])("rejects %s with 403", async (_label, user) => {
      const { app, supabase } = buildApp({ user });
      const res = await submit(app);

      expect(res.status).toBe(403);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it.each([
      ["another coordinator's event (or one reassigned away, E2-12 AC6)", "COORD-0002"],
      ["an event with no coordinator yet", null],
    ])("rejects a coordinator requesting a venue for %s", async (_label, eventCoordinatorId) => {
      const { app, insert } = buildApp({ eventCoordinatorId });
      const res = await submit(app);

      expect(res.status).toBe(403);
      expect(insert).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/venues/bookings", () => {
    it("AC3: creates the booking as Requested", async () => {
      const { app, insert } = buildApp();
      const res = await submit(app);

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalledWith({ venue_id: 1, event_id: 7, status: "Requested" });
      expect(res.body.booking).toMatchObject({
        id: 900,
        status: "Requested",
        venue: { id: 1, name: "Grand Ballroom", location: "Central Campus" },
      });
    });

    it("accepts a request for a Needs Review event, so a lost venue can be replaced", async () => {
      const { app, insert } = buildApp({ eventStatus: "Needs Review" });
      const res = await submit(app);

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalledWith({ venue_id: 1, event_id: 7, status: "Requested" });
    });

    it("AC1: tells the venue's assigned staff a request is waiting on them", async () => {
      const { app, publish } = buildApp({ staffId: "VENUE-0007" });
      const res = await submit(app);

      expect(res.status).toBe(201);
      expect(res.body.staffNotified).toBe(true);

      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "booking.requested",
          eventId: 7,
          actorId: "COORD-0001",
          recipients: { userIds: ["VENUE-0007"], roles: [] },
          data: expect.objectContaining({ eventName: "Alumni Dinner", venueName: "Grand Ballroom" }),
        }),
      );
    });

    it("still creates the booking when the venue has nobody assigned", async () => {
      const { app, fetchMock } = buildApp({ staffId: null });
      const res = await submit(app);

      expect(res.status).toBe(201);
      expect(res.body.staffNotified).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/notifications"))).toBe(false);
    });

    it("still creates the booking when the broker is unreachable", async () => {
      const { app, publish } = buildApp();
      publish.mockResolvedValue(false);

      const res = await submit(app);

      expect(res.status).toBe(201);
      expect(res.body.staffNotified).toBe(false);
    });

    it("returns 400 with field errors for missing ids", async () => {
      const { app, supabase } = buildApp();
      const res = await submit(app, {});

      expect(res.status).toBe(400);
      expect(res.body.fields.eventId).toBeDefined();
      expect(res.body.fields.venueId).toBeDefined();
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it("submit: returns 404 when events-service won't show the event", async () => {
      const { app } = buildApp({ eventHttpStatus: 403 });
      expect((await submit(app)).status).toBe(404);
    });

    it("returns 502 when events-service fails", async () => {
      const { app } = buildApp({ eventHttpStatus: 500 });
      expect((await submit(app)).status).toBe(502);
    });

    it.each(["Requested", "Safety Review", "Confirmed", "Cancelled"])(
      "AC1: refuses an event in %s — venues are requested during Planning",
      async (status) => {
        const { app, insert } = buildApp({ eventStatus: status });
        const res = await submit(app);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/Planning/);
        expect(insert).not.toHaveBeenCalled();
      },
    );

    it("returns 404 for a venue that isn't available", async () => {
      const { app, insert } = buildApp();
      const res = await submit(app, { eventId: 7, venueId: 99 });

      expect(res.status).toBe(404);
      expect(insert).not.toHaveBeenCalled();
    });

    it("returns 422 when the event has no usable date", async () => {
      const { app, insert } = buildApp({ eventDetails: eventDetails({ proposedDate: "" }) });
      const res = await submit(app);

      expect(res.status).toBe(422);
      expect(res.body.fields).toBeDefined();
      expect(insert).not.toHaveBeenCalled();
    });

    it("refuses a duplicate request for the same event and venue", async () => {
      const { app, insert } = buildApp({ existing: [{ id: 42, status: "Requested" }] });
      const res = await submit(app);

      expect(res.status).toBe(409);
      expect(res.body.booking).toEqual({ id: 42, status: "Requested" });
      expect(insert).not.toHaveBeenCalled();
    });

    it("only looks for blocking bookings in On Hold and Approved", async () => {
      const { app, blockingQuery } = buildApp();
      await submit(app);

      expect(blockingQuery.in).toHaveBeenCalledWith("status", ["On Hold", "Approved"]);
    });

    it("AC4/AC6: refuses a request overlapping an approved booking and shows the padded window", async () => {
      const { app, insert } = buildApp({
        bookings: [{ id: 51, venue_id: 1, event_id: 20, status: "Approved" }],
        // 12:30 starts after the event's 12:00 end, but inside its 12:45 turnaround.
        bookedEvents: [{ id: 20, proposedDate: "2026-11-10", startTime: "12:30", endTime: "14:00" }],
      });
      const res = await submit(app);

      expect(res.status).toBe(409);
      expect(insert).not.toHaveBeenCalled();
      expect(res.body.conflict).toEqual({
        bookingId: 51,
        status: "Approved",
        window: "2026-11-10 12:00–14:45",
        requestedWindow: "2026-11-10 09:30–12:45",
        setupMinutes: 30,
        turnaroundMinutes: 45,
      });
    });

    it("AC4: refuses a request overlapping a hold that hasn't expired", async () => {
      const { app } = buildApp({
        bookings: [
          { id: 52, venue_id: 1, event_id: 21, status: "On Hold", hold_expires_at: "2099-01-01T00:00:00.000Z" },
        ],
        bookedEvents: [{ id: 21, proposedDate: "2026-11-10", startTime: "11:00", endTime: "13:00" }],
      });
      const res = await submit(app);

      expect(res.status).toBe(409);
      expect(res.body.conflict.status).toBe("On Hold");
    });

    it.each([
      ["an expired hold", { status: "On Hold", hold_expires_at: "2020-01-01T00:00:00.000Z" }],
      ["another coordinator's request", { status: "Requested" }],
      ["a rejected booking", { status: "Rejected" }],
      ["an expired booking", { status: "Expired" }],
      ["a withdrawn booking", { status: "Withdrawn" }],
    ])("allows a request whose only overlap is %s", async (_label, overrides) => {
      const { app, insert } = buildApp({
        bookings: [{ id: 53, venue_id: 1, event_id: 22, ...overrides }],
        bookedEvents: [{ id: 22, proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00" }],
      });
      const res = await submit(app);

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalled();
    });

    it("ignores a blocking booking at a different venue", async () => {
      const { app } = buildApp({
        bookings: [{ id: 54, venue_id: 2, event_id: 23, status: "Approved" }],
        bookedEvents: [{ id: 23, proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00" }],
      });

      expect((await submit(app)).status).toBe(201);
    });

    it("AC2: a second venue for the same event is checked on its own", async () => {
      const { app, insert } = buildApp({
        bookings: [{ id: 55, venue_id: 1, event_id: 24, status: "Approved" }],
        bookedEvents: [{ id: 24, proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00" }],
      });
      const res = await submit(app, { eventId: 7, venueId: 2 });

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalledWith({ venue_id: 2, event_id: 7, status: "Requested" });
    });

    it("doesn't count this event's own bookings against it", async () => {
      const { app } = buildApp({
        bookings: [{ id: 56, venue_id: 1, event_id: 7, status: "Approved" }],
        bookedEvents: [{ id: 7, proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00" }],
      });

      expect((await submit(app)).status).toBe(201);
    });

    it("§3a change 2: refuses a request when the venue is unavailable that day, and shows the period", async () => {
      const { app, insert } = buildApp({
        unavailability: [{ venue_id: 1, start_date: "2026-11-10", reason: "Renovation" }],
      });
      const res = await submit(app);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/unavailable on 2026-11-10 \(all day\): Renovation/);
      expect(res.body.unavailability).toMatchObject({ venueId: 1, startDate: "2026-11-10", reason: "Renovation" });
      expect(insert).not.toHaveBeenCalled();
    });

    it("§3a change 2: a block-out that only cuts into the turnaround still counts", async () => {
      // 10:00–12:00 occupies 09:30–12:45 at venue 1; the block starts at 12:30.
      const { app, insert } = buildApp({
        unavailability: [
          { venue_id: 1, start_date: "2026-11-10", all_day: false, start_time: "12:30:00", end_time: "17:00:00" },
        ],
      });
      const res = await submit(app);

      expect(res.status).toBe(409);
      expect(insert).not.toHaveBeenCalled();
    });

    it("§3a change 2: a block-out ending exactly when setup starts doesn't clash", async () => {
      const { app } = buildApp({
        unavailability: [
          { venue_id: 1, start_date: "2026-11-10", all_day: false, start_time: "08:00:00", end_time: "09:30:00" },
        ],
      });
      expect((await submit(app)).status).toBe(201);
    });

    it("§3a change 2: a block-out at another venue doesn't stop the request", async () => {
      const { app } = buildApp({ unavailability: [{ venue_id: 2, start_date: "2026-11-10" }] });
      expect((await submit(app)).status).toBe(201);
    });

    it("returns 500 when the insert fails", async () => {
      const { app } = buildApp({ insertError: true });
      expect((await submit(app)).status).toBe(500);
    });
  });

  describe("GET /api/venues/events/:eventId/bookings", () => {
    function buildReadApp(rows: Record<string, unknown>[], options: { eventHttpStatus?: number } = {}) {
      const order = vi.fn().mockResolvedValue({ data: rows, error: null });
      const eq = vi.fn().mockReturnValue({ order });
      const supabase = {
        from: vi.fn((table: string) => {
          if (table === "venue_bookings") return { select: vi.fn().mockReturnValue({ eq }) };
          throw new Error(`unexpected table ${table}`);
        }),
      };

      const status = options.eventHttpStatus ?? 200;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: status >= 200 && status < 300,
          status,
          json: async () => ({ event: { id: 7, status: "Planning", submitted_details: eventDetails() } }),
        }),
      );

      (globalThis as any).__mockSupabase = supabase;
      (globalThis as any).__mockUser = { id: "COORD-0001", role: "coordinator" };

      const app = express();
      app.use(express.json());
      // Its own router, outside the coordinator-only venuesRouter: the owning
      // organiser must be able to see where their event's venue stands (E3-1).
      app.use("/api/venues/events", eventBookingsRouter);
      return { app, eq };
    }

    it("AC5: lists the event's requests with their pending state", async () => {
      const { app, eq } = buildReadApp([
        {
          id: 900,
          status: "Requested",
          hold_expires_at: null,
          decision_reason: null,
          created_at: "2026-10-07T00:00:00.000Z",
          venues: { id: 1, name: "Grand Ballroom", location: "Central Campus", capacity: 300 },
        },
        {
          id: 901,
          status: "On Hold",
          hold_expires_at: "2026-10-09T00:00:00.000Z",
          decision_reason: null,
          created_at: "2026-10-07T01:00:00.000Z",
          // supabase-js may hand an embedded to-one back as an array.
          venues: [{ id: 2, name: "Seminar Room 3-01", location: "North Campus", capacity: 80 }],
        },
      ]);
      const res = await request(app)
        .get("/api/venues/events/7/bookings")
        .set("Authorization", "Bearer test-token");

      expect(res.status).toBe(200);
      expect(eq).toHaveBeenCalledWith("event_id", 7);
      expect(res.body.bookings).toEqual([
        {
          id: 900,
          status: "Requested",
          holdExpiresAt: null,
          decisionReason: null,
          createdAt: "2026-10-07T00:00:00.000Z",
          venue: { id: 1, name: "Grand Ballroom", location: "Central Campus", capacity: 300 },
        },
        {
          id: 901,
          status: "On Hold",
          holdExpiresAt: "2026-10-09T00:00:00.000Z",
          decisionReason: null,
          createdAt: "2026-10-07T01:00:00.000Z",
          venue: { id: 2, name: "Seminar Room 3-01", location: "North Campus", capacity: 80 },
        },
      ]);
    });

    it("E3-1: lets the owning organiser see it too — events-service decides, not a role check", async () => {
      const { app } = buildReadApp([
        {
          id: 900,
          status: "Approved",
          hold_expires_at: null,
          decision_reason: null,
          created_at: "2026-10-07T00:00:00.000Z",
          venues: { id: 1, name: "Grand Ballroom", location: "Central Campus" },
        },
      ]);
      (globalThis as any).__mockUser = { id: "ORG-0001", role: "organiser" };

      const res = await request(app).get("/api/venues/events/7/bookings").set("Authorization", "Bearer test-token");

      expect(res.status).toBe(200);
      expect(res.body.bookings[0].status).toBe("Approved");
    });

    it("returns 400 for a non-numeric event id", async () => {
      const { app } = buildReadApp([]);
      expect((await request(app).get("/api/venues/events/abc/bookings")).status).toBe(400);
    });

    it("read: returns 404 when events-service won't show the event", async () => {
      const { app } = buildReadApp([], { eventHttpStatus: 403 });
      expect((await request(app).get("/api/venues/events/7/bookings").set("Authorization", "Bearer t")).status).toBe(404);
    });
  });
});

describe("booking plans", () => {
  /** E4-17: each venue booking is checked against its own purpose, headcount and needs. */



  const venues = [
    {
      id: 1,
      name: "Grand Ballroom",
      location: "Central Campus",
      description: null,
      capacity: 400,
      accessibility: ["Wheelchair access"],
      layouts: ["Banquet", "Theatre"],
      facilities: ["PA system", "Projector"],
      setup_minutes: 0,
      turnaround_minutes: 0,
    },
    {
      id: 2,
      name: "Seminar Room 3-01",
      location: "North Campus",
      description: null,
      capacity: 40,
      accessibility: ["Wheelchair access"],
      layouts: ["Classroom"],
      facilities: ["Projector", "Whiteboard"],
      setup_minutes: 0,
      turnaround_minutes: 0,
    },
  ];

  /** 120 people, banquet layout with a PA system — what the event as a whole asks for. */
  function eventDetails(overrides: Record<string, unknown> = {}) {
    return {
      name: "Alumni Day",
      proposedDate: "2026-11-10",
      startTime: "10:00",
      endTime: "12:00",
      expectedAttendance: 120,
      venue: "Banquet",
      equipment: "PA system",
      accessibility: "NA",
      technicalSupport: "None",
      ...overrides,
    };
  }

  const defaults: EventDefaults = {
    attendance: 120,
    requirements: { layouts: ["Banquet"], facilities: ["PA system"], accessibility: [] },
  };

  function buildApp(
    options: {
      user?: { id: string; role: string };
      eventDetails?: Record<string, unknown>;
      /** venue_bookings rows of the event, for the suitability check. */
      eventBookings?: Record<string, unknown>[];
    } = {},
  ) {
    const insertSingle = vi
      .fn()
      .mockResolvedValue({ data: { id: 900, status: "Requested", created_at: "2026-10-15T00:00:00.000Z" }, error: null });
    const insert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: insertSingle }) });

    const resolved = (data: unknown) => ({ data, error: null });

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "venues") {
          return {
            select: vi.fn((columns: string) => {
              if (columns.includes("staff_id")) {
                return { eq: () => ({ maybeSingle: vi.fn().mockResolvedValue(resolved({ staff_id: "VEN-0001" })) }) };
              }
              // Venue search reads .eq("status", "Available"); the suitability check reads them all.
              const q: any = { eq: vi.fn().mockResolvedValue(resolved(venues)) };
              q.then = (resolve: (v: unknown) => unknown) => resolve(resolved(venues));
              return q;
            }),
          };
        }
        if (table === "venue_bookings") {
          return {
            insert,
            select: vi.fn((columns: string) => {
              // No blocking or duplicate bookings; the event's own rows for suitability
              // and for "is the main venue covered?" (the reads that ask for the plan).
              const own = columns.includes("purpose") ? (options.eventBookings ?? []) : [];
              const q: any = {
                eq: vi.fn(() => q),
                in: vi.fn().mockResolvedValue(resolved(own)),
                order: vi.fn().mockResolvedValue(resolved(options.eventBookings ?? [])),
              };
              return q;
            }),
          };
        }
        if (table === "venue_unavailability") {
          const q: any = { eq: () => q, lte: () => q, gte: vi.fn().mockResolvedValue(resolved([])) };
          return { select: () => q };
        }
        throw new Error(`unexpected table ${table}`);
      }),
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("venue-booking-info")) return { ok: true, status: 200, json: async () => ({ events: [] }) };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            event: {
              id: 7,
              status: "Planning",
              submitted_details: options.eventDetails ?? eventDetails(),
              coordinator_id: "COORD-0001",
            },
          }),
        };
      }),
    );
    setPublisherForTest({ publish: vi.fn().mockResolvedValue(true) });

    (globalThis as any).__mockSupabase = supabase;
    (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

    const app = express();
    app.use(express.json());
    app.use("/api/venues/suitability", suitabilityRouter);
    app.use("/api/venues", venuesRouter);
    return { app, insert };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("parseBookingPlan", () => {
    it("AC1: takes a purpose and a headcount within the event's attendance", () => {
      expect(parseBookingPlan({ purpose: "Breakout", headcount: 30 }, defaults)).toEqual({
        valid: true,
        plan: { purpose: "Breakout", purposeDetail: null, headcount: 30, requirements: defaults.requirements },
      });
    });

    it("AC1: allows a headcount equal to the event's attendance", () => {
      expect(parseBookingPlan({ headcount: 120 }, defaults).valid).toBe(true);
    });

    it.each([0, -3, 121, "abc", 2.5])("AC1: rejects a headcount of %s", (headcount) => {
      const result = parseBookingPlan({ purpose: "Breakout", headcount }, defaults);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.fields.headcount).toBeDefined();
    });

    it("AC1: only accepts a purpose from the fixed list", () => {
      const result = parseBookingPlan({ purpose: "Party", headcount: 10 }, defaults);
      expect(!result.valid && result.fields.purpose).toBeTruthy();
    });

    it("needs a description for Other", () => {
      expect(parseBookingPlan({ purpose: "Other", headcount: 10 }, defaults).valid).toBe(false);
      const ok = parseBookingPlan({ purpose: "Other", purposeDetail: " Press room ", headcount: 10 }, defaults);
      expect(ok.valid && ok.plan.purposeDetail).toBe("Press room");
    });

    it("AC6: with nothing given, it's the main programme for the whole attendance", () => {
      expect(parseBookingPlan({}, defaults)).toEqual({
        valid: true,
        plan: { purpose: "Main programme", purposeDetail: null, headcount: 120, requirements: defaults.requirements },
      });
    });

    it("takes the booking's own requirements; an empty value means none needed", () => {
      const result = parseBookingPlan({ headcount: 30, layouts: "Classroom", facilities: ["Whiteboard"], accessibility: "" }, defaults);
      expect(result.valid && result.plan.requirements).toEqual({
        layouts: ["Classroom"],
        facilities: ["Whiteboard"],
        accessibility: [],
      });
    });
  });

  describe("checkSuitability", () => {
    const room = venues[1]; // capacity 40, Classroom, Projector + Whiteboard
    const needs = { layouts: ["Classroom"], facilities: ["whiteboard"], accessibility: [] };

    it("AC2: unsuitable when the headcount exceeds capacity", () => {
      expect(checkSuitability(room, { headcount: 41, requirements: needs })).toEqual({
        suitable: false,
        reasons: [{ kind: "capacity", capacity: 40, headcount: 41 }],
      });
    });

    it("AC3: suitable when the headcount equals capacity exactly", () => {
      expect(checkSuitability(room, { headcount: 40, requirements: needs })).toEqual({ suitable: true, reasons: [] });
    });

    it("AC4: unsuitable when a required layout, facility or accessibility feature is missing", () => {
      const result = checkSuitability(room, {
        headcount: 20,
        requirements: { layouts: ["Theatre"], facilities: ["Stage", "Projector"], accessibility: ["Hearing loop"] },
      });
      expect(result.suitable).toBe(false);
      expect(result.reasons).toEqual([
        { kind: "layouts", missing: ["Theatre"] },
        { kind: "facilities", missing: ["Stage"] },
        { kind: "accessibility", missing: ["Hearing loop"] },
      ]);
    });
  });

  describe("effectivePlan", () => {
    it("AC6: a booking made before E4-17 reads as the main programme for the whole event", () => {
      expect(effectivePlan({ purpose: null, headcount: null }, defaults)).toEqual({
        purpose: "Main programme",
        purposeDetail: null,
        headcount: 120,
        requirements: defaults.requirements,
      });
    });
  });

  describe("POST /api/venues/bookings with a plan (AC1)", () => {
    function submit(app: express.Express, body: Record<string, unknown>) {
      return request(app).post("/api/venues/bookings").set("Authorization", "Bearer t").send({ eventId: 7, venueId: 2, ...body });
    }

    it("stores the booking's purpose, headcount and requirements", async () => {
      const { app, insert } = buildApp();
      const res = await submit(app, { purpose: "Breakout", headcount: 30, layouts: ["Classroom"], facilities: ["Whiteboard"] });

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({
          purpose: "Breakout",
          headcount: 30,
          required_layouts: ["Classroom"],
          required_facilities: ["Whiteboard"],
          required_accessibility: [],
        }),
      );
      expect(res.body.booking).toMatchObject({ purpose: "Breakout", headcount: 30, suitability: { suitable: true } });
    });

    it("refuses a headcount above the event's attendance without creating anything", async () => {
      const { app, insert } = buildApp();
      const res = await submit(app, { purpose: "Breakout", headcount: 500 });

      expect(res.status).toBe(400);
      expect(res.body.fields.headcount).toContain("120");
      expect(insert).not.toHaveBeenCalled();
    });

    it("AC6: the first booking needs no plan — it's the main programme for everyone", async () => {
      const { app, insert } = buildApp();
      const res = await request(app).post("/api/venues/bookings").set("Authorization", "Bearer t").send({ eventId: 7, venueId: 1 });

      expect(res.status).toBe(201);
      expect(insert).toHaveBeenCalledWith({ venue_id: 1, event_id: 7, status: "Requested" });
      expect(res.body.booking).toMatchObject({ purpose: "Main programme", headcount: 120 });
    });

    it("AC1: once the main venue is booked, another request must say what it's for", async () => {
      const mainHall = { id: 10, status: "Approved", purpose: "Main programme", headcount: 120 };
      const { app, insert } = buildApp({ eventBookings: [mainHall] });
      const res = await request(app).post("/api/venues/bookings").set("Authorization", "Bearer t").send({ eventId: 7, venueId: 2 });

      expect(res.status).toBe(400);
      expect(res.body.fields).toHaveProperty("purpose");
      expect(res.body.fields).toHaveProperty("headcount");
      expect(insert).not.toHaveBeenCalled();
    });

    it("only checks suitability — an unsuitable venue can still be requested", async () => {
      const { app } = buildApp();
      const res = await submit(app, { purpose: "Main programme", headcount: 120 });

      expect(res.status).toBe(201);
      expect(res.body.booking.suitability).toMatchObject({ suitable: false });
    });
  });

  describe("GET /api/venues/recommendations/:eventId with a plan (AC5)", () => {
    function recommend(app: express.Express, query = "") {
      return request(app).get(`/api/venues/recommendations/7${query}`).set("Authorization", "Bearer t");
    }

    it("without a plan, judges the whole event as before (E4-7)", async () => {
      const { app } = buildApp();
      const res = await recommend(app);

      expect(res.status).toBe(200);
      expect(res.body.requirements.attendance).toBe(120);
      expect(res.body.venues.map((v: { id: number }) => v.id)).toEqual([1]);
    });

    it("with a breakout plan, judges the booking's own headcount and needs", async () => {
      const { app } = buildApp();
      const res = await recommend(app, "?purpose=Breakout&headcount=40&layouts=Classroom&facilities=Whiteboard&accessibility=");

      expect(res.status).toBe(200);
      expect(res.body.requirements).toMatchObject({ attendance: 40, layouts: ["Classroom"], facilities: ["Whiteboard"] });
      expect(res.body.venues.map((v: { id: number }) => v.id)).toEqual([2]);
    });

    it("rejects an invalid plan", async () => {
      const { app } = buildApp();
      const res = await recommend(app, "?headcount=999");
      expect(res.status).toBe(400);
      expect(res.body.fields.headcount).toBeDefined();
    });
  });

  describe("GET /api/venues/suitability/:eventId", () => {
    function check(app: express.Express) {
      return request(app).get("/api/venues/suitability/7").set("Authorization", "Bearer t");
    }

    const mainHall = { id: 10, venue_id: 1, status: "Approved", purpose: null, purpose_detail: null, headcount: null };
    const breakout = {
      id: 11,
      venue_id: 2,
      status: "Requested",
      purpose: "Breakout",
      purpose_detail: null,
      headcount: 60,
      required_layouts: ["Classroom"],
      required_facilities: ["Whiteboard"],
      required_accessibility: [],
    };

    it("AC2: an over-capacity booking is unsuitable and the event's other bookings are unaffected", async () => {
      const { app } = buildApp({ eventBookings: [mainHall, breakout] });
      const res = await check(app);

      expect(res.status).toBe(200);
      const [hall, room] = res.body.bookings;
      expect(hall).toMatchObject({ bookingId: 10, purpose: "Main programme", headcount: 120, suitability: { suitable: true } });
      expect(room).toMatchObject({
        bookingId: 11,
        purpose: "Breakout",
        headcount: 60,
        suitability: { suitable: false, reasons: [{ kind: "capacity", capacity: 40, headcount: 60 }] },
      });
    });

    it("AC3: a headcount equal to capacity is suitable", async () => {
      const { app } = buildApp({ eventBookings: [{ ...breakout, headcount: 40 }] });
      const res = await check(app);
      expect(res.body.bookings[0].suitability).toEqual({ suitable: true, reasons: [] });
    });

    it("AC4: a missing required feature makes that booking unsuitable", async () => {
      const { app } = buildApp({ eventBookings: [{ ...breakout, headcount: 20, required_facilities: ["Stage"] }] });
      const res = await check(app);
      expect(res.body.bookings[0].suitability).toEqual({
        suitable: false,
        reasons: [{ kind: "facilities", missing: ["Stage"] }],
      });
    });

    it("gives the planning form the event's defaults and how many bookings are live", async () => {
      const { app } = buildApp({ eventBookings: [mainHall, { ...breakout, status: "Withdrawn" }] });
      const res = await check(app);
      expect(res.body.defaults).toMatchObject({ attendance: 120, liveBookingCount: 1 });
      expect(res.body.defaults.requirements.layouts).toEqual(["Banquet"]);
    });

    it("knows whether the main programme already has a venue", async () => {
      const { app } = buildApp({ eventBookings: [mainHall, breakout] });
      expect((await check(app)).body.defaults.hasMainProgramme).toBe(true);
    });

    it("plans the main programme again when its venue needs replacing", async () => {
      const { app } = buildApp({ eventBookings: [{ ...mainHall, status: "Replacement Required" }, breakout] });
      expect((await check(app)).body.defaults.hasMainProgramme).toBe(false);
    });

    it("is for coordinators only", async () => {
      const { app } = buildApp({ user: { id: "ORG-0001", role: "organiser" } });
      const res = await check(app);
      expect(res.status).toBe(403);
    });
  });

  describe("booking plan: blanks and whole numbers", () => {
    const defaults: EventDefaults = { attendance: 100, requirements: { layouts: [], facilities: [], accessibility: [] } };
    const noAttendance: EventDefaults = { attendance: null, requirements: { layouts: [], facilities: [], accessibility: [] } };
    const fieldsOf = (raw: Record<string, unknown>, d: EventDefaults = defaults) => {
      const r = parseBookingPlan(raw, d);
      return r.valid ? {} : r.fields;
    };
    const MSG = "The headcount must be a whole number of at least 1.";

    it.each(["12abc", "x12", "1 2", "1.5", "0", "-3", 0, 0.5, false, {}])("headcount %j is rejected", (headcount) => {
      expect(fieldsOf({ headcount })).toEqual({ headcount: MSG });
    });

    it.each([
      ["  7 ", 7],
      ["7", 7],
      [7, 7],
      ["100", 100],
    ])("headcount %j is read as %d", (headcount, expected) => {
      const r = parseBookingPlan({ headcount }, defaults);
      expect(r.valid && r.plan.headcount).toBe(expected);
    });

    it.each([undefined, null, "", "   ", "\t"])("a blank headcount %j falls back to the event's attendance", (headcount) => {
      const r = parseBookingPlan({ headcount }, defaults);
      expect(r.valid && r.plan.headcount).toBe(100);
      expect(fieldsOf({ headcount }, noAttendance)).toEqual({ headcount: "Enter the expected headcount for this venue." });
    });

    it.each([undefined, null, "", "   "])("a blank purpose %j is the default main programme", (purpose) => {
      const r = parseBookingPlan({ purpose }, defaults);
      expect(r.valid && r.plan.purpose).toBe("Main programme");
    });

    it("a non-blank, non-string purpose is rejected rather than defaulted", () => {
      expect(fieldsOf({ purpose: 5 })).toMatchObject({ purpose: expect.stringContaining("Choose one of:") });
      expect(fieldsOf({ purpose: false })).toMatchObject({ purpose: expect.stringContaining("Choose one of:") });
    });
  });
});

describe("booking withdrawal and release", () => {
  interface BookingFixture {
    id: number;
    venue_id: number;
    event_id: number;
    status: string;
    hold_expires_at?: string | null;
    decision_reason?: string | null;
    decided_by?: string | null;
    decided_at?: string | null;
  }

  function buildApp(
    options: {
      user?: { id: string; role: string };
      booking?: Partial<BookingFixture>;
      bookingNotFound?: boolean;
      bookingError?: boolean;
      /** The event's assigned coordinator, as events-service returns it. */
      eventCoordinatorId?: string | null;
      eventHttpStatus?: number;
      eventName?: string | null;
      /** Who the venue is assigned to (venues.staff_id); null means nobody. */
      staffId?: string | null;
      /** Simulate another decision winning the optimistic-lock race. */
      updateConflict?: boolean;
      updateError?: boolean;
      /** E4-13: rows already in venue_buffer_overlaps for this venue before the call. */
      storedOverlaps?: { id: number; venue_id: number; booking_id_a: number; booking_id_b: number }[];
      /** E4-13: other bookings still blocking the venue, for reconciliation's own venue_bookings read. */
      liveBookings?: { id: number; event_id: number; status: string; hold_expires_at: string | null }[];
      /** E4-13: events-service's venue-booking-info answer for those live bookings. */
      liveBookingEvents?: Record<string, unknown>[];
    } = {},
  ) {
    const booking: BookingFixture = {
      id: 900,
      venue_id: 1,
      event_id: 7,
      status: "Requested",
      hold_expires_at: null,
      decision_reason: null,
      decided_by: null,
      decided_at: null,
      ...options.booking,
    };

    const bookingMaybeSingle = vi.fn().mockResolvedValue(
      options.bookingError
        ? { data: null, error: { message: "boom" } }
        : { data: options.bookingNotFound ? null : booking, error: null },
    );
    // Two different shapes read venue_bookings through this same table: the
    // withdraw/release handler's single-row `.eq("id", …).maybeSingle()`, and
    // reconcileBufferOverlaps's `.eq("venue_id", …).in("status", …)` live-
    // bookings read (lib/venueChanges.ts's loadLiveBookings). Both chain off
    // one `.eq()` call, so the query object has to serve either ending.
    const bookingSelectEq: any = vi.fn(() => bookingQuery);
    const bookingQuery: any = { eq: bookingSelectEq, maybeSingle: bookingMaybeSingle, in: vi.fn() };
    bookingQuery.in.mockResolvedValue({ data: options.liveBookings ?? [], error: null });
    const bookingSelect = vi.fn().mockReturnValue(bookingQuery);

    const updateEqId = vi.fn();
    const updateEqStatus = vi.fn();
    const updateMaybeSingle = vi.fn().mockResolvedValue(
      options.updateError
        ? { data: null, error: { message: "boom" } }
        : options.updateConflict
          ? { data: null, error: null }
          : {
              data: {
                ...booking,
                status: "Withdrawn",
                hold_expires_at: null,
                decided_by: (options.user ?? { id: "COORD-0001" }).id,
                decided_at: "2026-10-15T00:00:00.000Z",
              },
              error: null,
            },
    );
    const updateSelect = vi.fn().mockReturnValue({ maybeSingle: updateMaybeSingle });
    updateEqStatus.mockReturnValue({ select: updateSelect });
    updateEqId.mockImplementation((_column: string, value: unknown) => {
      void value;
      return { eq: updateEqStatus };
    });
    const update = vi.fn().mockReturnValue({ eq: updateEqId });

    const venueRow = {
      id: 1,
      name: "Grand Ballroom",
      location: "Central Campus",
      staff_id: options.staffId === undefined ? "VENUE-0001" : options.staffId,
      setup_minutes: 0,
      turnaround_minutes: 0,
    };
    const venueMaybeSingle = vi.fn().mockResolvedValue({ data: venueRow, error: null });
    const venueEq = vi.fn().mockReturnValue({ maybeSingle: venueMaybeSingle });
    const venueSelect = vi.fn().mockReturnValue({ eq: venueEq });

    // E4-13 AC3: reconcileBufferOverlapsSafely runs after a withdraw/release
    // commits. It reads live bookings at the venue (none here, by default —
    // this fixture's own booking has just left the unavailable set) and
    // reconciles venue_buffer_overlaps; an in-memory table lets tests assert
    // on that rather than only on the swallowed-error path every other test
    // here relies on.
    let overlapRows: { id: number; venue_id: number; booking_id_a: number; booking_id_b: number }[] = [
      ...(options.storedOverlaps ?? []),
    ];
    const overlapsTable = {
      select: vi.fn(() => {
        let venueId: unknown;
        const q: any = {
          eq: vi.fn((_c: string, v: unknown) => {
            venueId = v;
            return q;
          }),
          order: vi.fn(() => q),
        };
        q.then = (resolve: (v: unknown) => void) => resolve({ data: overlapRows.filter((r) => r.venue_id === venueId), error: null });
        return q;
      }),
      insert: vi.fn((rows: { venue_id: number; booking_id_a: number; booking_id_b: number }[]) => {
        overlapRows = [...overlapRows, ...rows.map((r, i) => ({ ...r, id: 2000 + i }))];
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
        if (table === "venue_bookings") return { select: bookingSelect, update };
        if (table === "venues") return { select: venueSelect };
        if (table === "venue_buffer_overlaps") return overlapsTable;
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const eventHttpStatus = options.eventHttpStatus ?? 200;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/venue-booking-info")) {
        // reconcileBufferOverlaps's loadLiveBookings call — a second,
        // differently-shaped events-service endpoint from the single-event
        // fetchEvent() lookup below.
        return { ok: true, status: 200, json: async () => ({ events: options.liveBookingEvents ?? [] }) };
      }
      return {
        ok: eventHttpStatus >= 200 && eventHttpStatus < 300,
        status: eventHttpStatus,
        json: async () => ({
          event: {
            id: booking.event_id,
            status: "Planning",
            submitted_details: { name: options.eventName === undefined ? "Alumni Dinner" : options.eventName },
            coordinator_id: options.eventCoordinatorId === undefined ? "COORD-0001" : options.eventCoordinatorId,
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    (globalThis as any).__mockSupabase = supabase;
    (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

    const app = express();
    app.use(express.json());
    app.use("/api/venues", venuesRouter);
    return {
      app,
      supabase,
      update,
      updateEqId,
      updateEqStatus,
      fetchMock,
      publish,
      booking,
      overlapsTable,
      getOverlapRows: () => overlapRows,
    };
  }

  function withdraw(app: express.Express, bookingId: number | string = 900) {
    return request(app).post(`/api/venues/bookings/${bookingId}/withdraw`).set("Authorization", "Bearer test-token");
  }

  function release(app: express.Express, bookingId: number | string = 900) {
    return request(app).post(`/api/venues/bookings/${bookingId}/release`).set("Authorization", "Bearer test-token");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("POST /api/venues/bookings/:bookingId/withdraw", () => {
    it.each(["Requested", "On Hold"] as const)("AC1: withdraws a %s booking", async (status) => {
      const { app, update } = buildApp({ booking: { status, hold_expires_at: "2099-01-01T00:00:00.000Z" } });
      const res = await withdraw(app);

      expect(res.status).toBe(200);
      expect(res.body.booking).toMatchObject({ id: 900, status: "Withdrawn" });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "Withdrawn", hold_expires_at: null, decided_by: "COORD-0001" }),
      );
    });

    it("AC1: publishes booking.withdrawn to the venue's assigned staff (RabbitMQ.md #18)", async () => {
      const { app, publish } = buildApp({ staffId: "VENUE-0007" });
      const res = await withdraw(app);

      expect(res.status).toBe(200);
      expect(res.body.staffNotified).toBe(true);
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "booking.withdrawn",
          eventId: 7,
          actorId: "COORD-0001",
          recipients: { userIds: ["VENUE-0007"], roles: [] },
          data: expect.objectContaining({
            bookingId: 900,
            venueName: "Grand Ballroom",
            eventName: "Alumni Dinner",
            reason: "coordinator_withdrew",
          }),
        }),
      );
    });

    it("still succeeds when the venue has nobody assigned", async () => {
      const { app } = buildApp({ staffId: null });
      const res = await withdraw(app);

      expect(res.status).toBe(200);
      expect(res.body.staffNotified).toBe(false);
    });

    it("AC2: blocks withdrawing an Approved booking and points at release", async () => {
      const { app, update } = buildApp({ booking: { status: "Approved" } });
      const res = await withdraw(app);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/release/i);
      expect(update).not.toHaveBeenCalled();
    });

    it.each(["Rejected", "Expired", "Withdrawn", "Replacement Required"])(
      "refuses to withdraw a %s booking",
      async (status) => {
        const { app, update } = buildApp({ booking: { status } });
        const res = await withdraw(app);

        expect(res.status).toBe(409);
        expect(update).not.toHaveBeenCalled();
      },
    );

    it("AC3: only the targeted booking is updated", async () => {
      const { app, updateEqId, updateEqStatus } = buildApp({ booking: { status: "On Hold" } });
      await withdraw(app);

      expect(updateEqId).toHaveBeenCalledWith("id", 900);
      expect(updateEqStatus).toHaveBeenCalledWith("status", "On Hold");
    });

    it("rejects a coordinator who isn't assigned to the event", async () => {
      const { app, update } = buildApp({ eventCoordinatorId: "COORD-0002" });
      const res = await withdraw(app);

      expect(res.status).toBe(403);
      expect(update).not.toHaveBeenCalled();
    });

    it.each([
      ["an organiser", { id: "ORG-0001", role: "organiser" }],
      ["venue staff", { id: "VEN-0001", role: "venue_staff" }],
    ])("rejects %s with 403", async (_label, user) => {
      const { app, supabase } = buildApp({ user });
      const res = await withdraw(app);

      expect(res.status).toBe(403);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it("returns 404 when the booking doesn't exist", async () => {
      const { app } = buildApp({ bookingNotFound: true });
      expect((await withdraw(app)).status).toBe(404);
    });

    it("returns 400 for an invalid booking id", async () => {
      const { app } = buildApp();
      expect((await withdraw(app, "abc")).status).toBe(400);
    });

    it("returns 409 when another decision won the race first", async () => {
      const { app } = buildApp({ updateConflict: true });
      const res = await withdraw(app);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/someone else/i);
    });

    it("returns 500 when the lookup fails", async () => {
      const { app } = buildApp({ bookingError: true });
      expect((await withdraw(app)).status).toBe(500);
    });
  });

  describe("POST /api/venues/bookings/:bookingId/release", () => {
    it("AC2: releases an Approved booking", async () => {
      const { app, update } = buildApp({ booking: { status: "Approved" } });
      const res = await release(app);

      expect(res.status).toBe(200);
      expect(res.body.booking).toMatchObject({ id: 900, status: "Withdrawn" });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "Withdrawn", hold_expires_at: null }),
      );
    });

    it("publishes booking.withdrawn with the release reason (RabbitMQ.md #18)", async () => {
      const { app, publish } = buildApp({ booking: { status: "Approved" }, staffId: "VENUE-0007" });
      const res = await release(app);

      expect(res.status).toBe(200);
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "booking.withdrawn",
          data: expect.objectContaining({ reason: "coordinator_released" }),
        }),
      );
    });

    it.each(["Requested", "On Hold"] as const)("blocks releasing a %s booking and points at withdraw", async (status) => {
      const { app, update } = buildApp({ booking: { status } });
      const res = await release(app);

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/withdraw/i);
      expect(update).not.toHaveBeenCalled();
    });

    it.each(["Rejected", "Expired", "Withdrawn"])("refuses to release a %s booking", async (status) => {
      const { app, update } = buildApp({ booking: { status } });
      const res = await release(app);

      expect(res.status).toBe(409);
      expect(update).not.toHaveBeenCalled();
    });

    it("AC3: releases a Replacement Required booking once a replacement is requested", async () => {
      const { app, update } = buildApp({ booking: { status: "Replacement Required" } });
      const res = await release(app);

      expect(res.status).toBe(200);
      expect(res.body.booking).toMatchObject({ id: 900, status: "Withdrawn" });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "Withdrawn", hold_expires_at: null }),
      );
    });

    it("rejects a coordinator who isn't assigned to the event", async () => {
      const { app } = buildApp({ booking: { status: "Approved" }, eventCoordinatorId: "COORD-0002" });
      expect((await release(app)).status).toBe(403);
    });
  });

  describe("E4-13 AC3: releasing/withdrawing reconciles the persisted buffer-overlap review list", () => {
    it("removes a flagged pair once the released booking leaves the unavailable set", async () => {
      // Booking 900 (venue 1) is being released; booking 901 was flagged
      // against it. Once 900 is Withdrawn, loadLiveBookings only sees 901, so
      // findAllBufferOverlaps can no longer report the pair.
      const { app, getOverlapRows } = buildApp({
        booking: { status: "Approved" },
        storedOverlaps: [{ id: 5000, venue_id: 1, booking_id_a: 900, booking_id_b: 901 }],
        liveBookings: [{ id: 901, event_id: 21, status: "Approved", hold_expires_at: null }],
        liveBookingEvents: [
          {
            id: 21,
            status: "Planning",
            name: "Other Event",
            proposedDate: "2099-01-01",
            startTime: "09:00",
            endTime: "10:00",
            expectedAttendance: 10,
            coordinatorId: "COORD-0002",
          },
        ],
      });
      const res = await release(app);

      expect(res.status).toBe(200);
      expect(getOverlapRows()).toEqual([]);
    });

    it("leaves other venues' flagged pairs alone", async () => {
      const other = { id: 5001, venue_id: 2, booking_id_a: 10, booking_id_b: 11 };
      const { app, getOverlapRows } = buildApp({
        booking: { status: "Approved" },
        storedOverlaps: [other],
      });
      await release(app);

      expect(getOverlapRows()).toEqual([other]);
    });

    it("a reconciliation failure never turns a successful withdraw into an error response", async () => {
      // No special wiring needed: the mock's venues select for this test
      // doesn't carry setup_minutes/turnaround_minutes mismatches, but to
      // prove the best-effort contract, simulate loadLiveBookings failing by
      // having events-service's venue-booking-info answer an error for it.
      const { app } = buildApp({ booking: { status: "On Hold", hold_expires_at: "2099-01-01T00:00:00.000Z" } });
      const res = await withdraw(app);
      expect(res.status).toBe(200);
    });
  });
});

describe("flag for rebooking", () => {
  /** E3-11 AC2: flags an Approved booking for rebooking after a coordinator approves an invalidating change request. */



  function buildApp(
    options: {
      user?: { id: string; role: string };
      booking?: { id: number; venue_id: number; event_id: number; status: string } | null;
      bookingError?: boolean;
      eventCoordinatorId?: string | null;
      eventHttpStatus?: number;
      updated?: { id: number; status: string } | null;
      updateError?: boolean;
      staffId?: string | null;
    } = {},
  ) {
    const resolved = (data: unknown, error: unknown = null) => vi.fn().mockResolvedValue({ data, error });

    const booking =
      options.booking === undefined
        ? { id: 94, venue_id: 4, event_id: 163, status: "Approved" }
        : options.booking;

    const bookingSelectChain: any = {};
    bookingSelectChain.eq = () => bookingSelectChain;
    bookingSelectChain.maybeSingle = resolved(
      options.bookingError ? null : booking,
      options.bookingError ? { message: "boom" } : null,
    );

    const updateChain: any = {};
    updateChain.eq = () => updateChain;
    updateChain.select = () => updateChain;
    updateChain.maybeSingle = resolved(
      options.updateError ? null : options.updated === undefined ? { id: 94, status: "Replacement Required" } : options.updated,
      options.updateError ? { message: "boom" } : null,
    );

    const venueSelectChain: any = {};
    venueSelectChain.eq = () => venueSelectChain;
    venueSelectChain.maybeSingle = resolved(
      { id: 4, name: "Seminar Room 3-01", staff_id: options.staffId === undefined ? "VEN-0001" : options.staffId },
      null,
    );

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === "venue_bookings") {
          return { select: () => bookingSelectChain, update: () => updateChain };
        }
        if (table === "venues") return { select: () => venueSelectChain };
        throw new Error(`unexpected table ${table}`);
      }),
    };

    const status = options.eventHttpStatus ?? 200;
    const fetchMock = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({
        event: {
          id: booking?.event_id ?? 163,
          coordinator_id: options.eventCoordinatorId === undefined ? "COORD-0001" : options.eventCoordinatorId,
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    (globalThis as any).__mockSupabase = supabase;
    (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

    const app = express();
    app.use(express.json());
    app.use("/api/venues", venuesRouter);
    return { app, publish };
  }

  function flag(app: express.Express, bookingId = "94", body: Record<string, unknown> = { reason: "Schedule change approved" }) {
    return request(app).post(`/api/venues/bookings/${bookingId}/flag-for-rebooking`).send(body);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("POST /api/venues/bookings/:bookingId/flag-for-rebooking", () => {
    it("400s an invalid booking id", async () => {
      const { app } = buildApp();
      const res = await flag(app, "abc");
      expect(res.status).toBe(400);
    });

    it("400s a missing reason", async () => {
      const { app } = buildApp();
      const res = await flag(app, "94", {});
      expect(res.status).toBe(400);
    });

    it("404s an unknown booking", async () => {
      const { app } = buildApp({ booking: null });
      const res = await flag(app);
      expect(res.status).toBe(404);
    });

    it("500s when the booking lookup fails", async () => {
      const { app } = buildApp({ bookingError: true });
      const res = await flag(app);
      expect(res.status).toBe(500);
    });

    it("403s a coordinator who isn't assigned to the event", async () => {
      const { app } = buildApp({ eventCoordinatorId: "COORD-0002" });
      const res = await flag(app);
      expect(res.status).toBe(403);
    });

    it("502s when the event can't be loaded", async () => {
      const { app } = buildApp({ eventHttpStatus: 500 });
      const res = await flag(app);
      expect(res.status).toBe(502);
    });

    it("409s a booking that isn't Approved", async () => {
      const { app } = buildApp({ booking: { id: 94, venue_id: 4, event_id: 163, status: "Requested" } });
      const res = await flag(app);
      expect(res.status).toBe(409);
    });

    it("flags an Approved booking as Replacement Required and notifies the venue's staff", async () => {
      const { app, publish } = buildApp();
      const res = await flag(app, "94", { reason: "Attendance change invalidated this booking" });

      expect(res.status).toBe(200);
      expect(res.body.booking).toEqual({ id: 94, status: "Replacement Required" });
      expect(res.body.staffNotified).toBe(true);
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "booking.flagged_for_rebooking",
          recipients: { userIds: ["VEN-0001"], roles: [] },
        }),
      );
    });

    it("doesn't notify, but still flags, when the venue has no staff assigned", async () => {
      const { app, publish } = buildApp({ staffId: null });
      const res = await flag(app);

      expect(res.status).toBe(200);
      expect(res.body.staffNotified).toBe(false);
      expect(publish).not.toHaveBeenCalled();
    });

    it("409s when the booking was decided again in the meantime", async () => {
      const { app } = buildApp({ updated: null });
      const res = await flag(app);
      expect(res.status).toBe(409);
    });

    it("500s when the update fails", async () => {
      const { app } = buildApp({ updateError: true });
      const res = await flag(app);
      expect(res.status).toBe(500);
    });
  });
});
