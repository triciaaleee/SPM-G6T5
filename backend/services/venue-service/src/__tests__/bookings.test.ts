import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { venuesRouter } from "../routes/venues.js";
import { eventBookingsRouter } from "../routes/eventBookings.js";
import { blocksVenue } from "../lib/bookingStatus.js";
import { formatWindow, occupiedWindow, overlaps } from "../lib/bookingConflicts.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "COORD-0001", role: "coordinator" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

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

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

  const app = express();
  app.use(express.json());
  app.use("/api/venues", venuesRouter);
  return { app, supabase, insert, blockingQuery, existingQuery, fetchMock };
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

  it("AC1: tells the venue's assigned staff a request is waiting on them", async () => {
    const { app, fetchMock } = buildApp({ staffId: "VENUE-0007" });
    const res = await submit(app);

    expect(res.status).toBe(201);
    expect(res.body.staffNotified).toBe(true);

    const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/notifications"));
    expect(call).toBeDefined();
    const [, init] = call as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(init.body).notifications).toEqual([
      {
        recipientId: "VENUE-0007",
        type: "venue_booking_requested",
        title: "New booking request for Grand Ballroom",
        body: "Alumni Dinner has requested Grand Ballroom for 2026-11-10, 10:00–12:00. Hold, approve or reject it from your booking requests.",
        link: "/venue-requests",
      },
    ]);
  });

  it("still creates the booking when the venue has nobody assigned", async () => {
    const { app, fetchMock } = buildApp({ staffId: null });
    const res = await submit(app);

    expect(res.status).toBe(201);
    expect(res.body.staffNotified).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/notifications"))).toBe(false);
  });

  it("still creates the booking when notification-service is down", async () => {
    const { app, fetchMock } = buildApp();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/api/notifications")) throw new Error("ECONNREFUSED");
      if (String(url).includes("venue-booking-info")) {
        return { ok: true, status: 200, json: async () => ({ events: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          event: { id: 7, status: "Planning", submitted_details: eventDetails(), coordinator_id: "COORD-0001" },
        }),
      };
    });

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

  it("returns 404 when events-service won't show the event", async () => {
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
        venues: { id: 1, name: "Grand Ballroom", location: "Central Campus" },
      },
      {
        id: 901,
        status: "On Hold",
        hold_expires_at: "2026-10-09T00:00:00.000Z",
        decision_reason: null,
        created_at: "2026-10-07T01:00:00.000Z",
        // supabase-js may hand an embedded to-one back as an array.
        venues: [{ id: 2, name: "Seminar Room 3-01", location: "North Campus" }],
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
        venue: { id: 1, name: "Grand Ballroom", location: "Central Campus" },
      },
      {
        id: 901,
        status: "On Hold",
        holdExpiresAt: "2026-10-09T00:00:00.000Z",
        decisionReason: null,
        createdAt: "2026-10-07T01:00:00.000Z",
        venue: { id: 2, name: "Seminar Room 3-01", location: "North Campus" },
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

  it("returns 404 when events-service won't show the event", async () => {
    const { app } = buildReadApp([], { eventHttpStatus: 403 });
    expect((await request(app).get("/api/venues/events/7/bookings").set("Authorization", "Bearer t")).status).toBe(404);
  });
});
