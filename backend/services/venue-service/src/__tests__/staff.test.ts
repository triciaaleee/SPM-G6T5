import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { staffRouter } from "../routes/staff.js";

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

const venue = {
  id: 6,
  name: "Great Lawn",
  location: "Central Campus",
  description: null,
  capacity: 800,
  accessibility: ["Wheelchair access"],
  layouts: ["Reception (standing)", "Open floor"],
  facilities: ["PA system", "Power outlets", "Outdoor space"],
};

type Booking = {
  id: number;
  event_id: number | null;
  booking_date: string;
  start_time: string;
  end_time: string;
  reason: string | null;
};

const eventBooking: Booking = {
  id: 1,
  event_id: 7,
  booking_date: "2026-09-24",
  start_time: "09:00:00",
  end_time: "20:00:00",
  reason: "Nut Festival",
};

const holdBooking: Booking = {
  id: 2,
  event_id: null,
  booking_date: "2026-09-28",
  start_time: "09:00:00",
  end_time: "14:00:00",
  reason: "Floor maintenance",
};

/** What events-service's GET /venue-booking-info returns for event 7. */
const eventInfo = {
  id: 7,
  name: "Nut Festival",
  proposedDate: "2026-09-24",
  startTime: "09:00",
  endTime: "20:00",
  expectedAttendance: 100,
  venue: "Outdoor space, standing reception",
  accessibility: "NA",
  equipment: "PA system and power outlets",
  technicalSupport: "None",
};

function buildApp(
  options: {
    user?: { id: string; role: string };
    venue?: typeof venue | null;
    bookings?: Booking[];
    events?: Record<string, unknown>[];
    eventsStatus?: number;
    venueList?: { id: number; name: string }[];
  } = {},
) {
  const bookingsQuery = {
    eq: vi.fn(),
    gte: vi.fn(),
    lte: vi.fn(),
    order: vi.fn(),
    then: (resolve: (value: unknown) => void) => resolve({ data: options.bookings ?? [], error: null }),
  };
  for (const method of ["eq", "gte", "lte", "order"] as const) bookingsQuery[method].mockReturnValue(bookingsQuery);

  // venues is read two ways: the picker list (.eq("active").order("name"))
  // and the single-venue lookup (.eq("id").eq("active").maybeSingle()).
  const venuesQuery = {
    eq: vi.fn(),
    order: vi.fn().mockResolvedValue({ data: options.venueList ?? [], error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.venue === undefined ? venue : options.venue, error: null }),
  };
  venuesQuery.eq.mockReturnValue(venuesQuery);
  const venuesSelect = vi.fn().mockReturnValue(venuesQuery);

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venues") return { select: venuesSelect };
      if (table === "venue_bookings") return { select: vi.fn().mockReturnValue(bookingsQuery) };
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
  (globalThis as any).__mockUser = options.user ?? venueStaff;

  const app = express();
  app.use("/api/venues/staff", staffRouter);
  return { app, supabase, bookingsQuery, fetchMock };
}

function getBookings(app: express.Express, query = "?from=2026-09-01&to=2026-09-30", venueId = "6") {
  return request(app).get(`/api/venues/staff/${venueId}/bookings${query}`).set("Authorization", "Bearer test-token");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("venue staff access", () => {
  it.each([
    ["a coordinator", { id: "COORD-0001", role: "coordinator" }],
    ["an organiser", { id: "ORG-0001", role: "organiser" }],
  ])("rejects %s with 403", async (_label, user) => {
    const { app, supabase } = buildApp({ user });

    const list = await request(app).get("/api/venues/staff/venues");
    const bookings = await getBookings(app);

    expect(list.status).toBe(403);
    expect(bookings.status).toBe(403);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("GET /api/venues/staff/venues", () => {
  it("lists active venues for the picker", async () => {
    const venueList = [
      { id: 6, name: "Great Lawn" },
      { id: 2, name: "Lecture Theatre 1" },
    ];
    const { app } = buildApp({ venueList });

    const res = await request(app).get("/api/venues/staff/venues");

    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual(venueList);
  });
});

describe("GET /api/venues/staff/:venueId/bookings", () => {
  it("returns an event booking with only its booking-relevant details", async () => {
    const { app, fetchMock } = buildApp({ bookings: [eventBooking], events: [eventInfo] });

    const res = await getBookings(app);

    expect(res.status).toBe(200);
    expect(res.body.venue).toEqual({ id: 6, name: "Great Lawn" });
    expect(res.body.bookings).toEqual([
      {
        id: 1,
        date: "2026-09-24",
        startTime: "09:00",
        endTime: "20:00",
        kind: "event",
        event: {
          id: 7,
          name: "Nut Festival",
          expectedAttendance: 100,
          layouts: ["Reception (standing)"],
          facilities: ["Outdoor space", "PA system", "Power outlets"],
        },
      },
    ]);
    // Event data is fetched through events-service with the caller's token.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/events\/venue-booking-info\?ids=7$/),
      { headers: { Authorization: "Bearer test-token" } },
    );
  });

  it("never passes the organiser's free text or other event fields to the browser", async () => {
    const leaky = { ...eventInfo, purpose: "Internal planning notes", description: "Roster attached" };
    const { app } = buildApp({ bookings: [eventBooking], events: [leaky] });

    const res = await getBookings(app);
    const event = res.body.bookings[0].event;

    expect(Object.keys(event).sort()).toEqual(["expectedAttendance", "facilities", "id", "layouts", "name"]);
    expect(JSON.stringify(res.body)).not.toContain("Internal planning notes");
    expect(JSON.stringify(res.body)).not.toContain("PA system and power outlets");
  });

  it("returns a booking with no event as a hold with its reason, without calling events-service", async () => {
    const { app, fetchMock } = buildApp({ bookings: [holdBooking] });

    const res = await getBookings(app);

    expect(res.status).toBe(200);
    expect(res.body.bookings).toEqual([
      { id: 2, date: "2026-09-28", startTime: "09:00", endTime: "14:00", kind: "hold", reason: "Floor maintenance" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a booked event events-service didn't return (e.g. deleted) as a hold", async () => {
    const { app } = buildApp({ bookings: [eventBooking], events: [] });

    const res = await getBookings(app);

    expect(res.body.bookings[0]).toMatchObject({ kind: "hold", reason: "Nut Festival" });
    expect(res.body.bookings[0]).not.toHaveProperty("event");
  });

  it("queries only this venue's bookings within the range, earliest first", async () => {
    const { app, bookingsQuery } = buildApp();

    await getBookings(app);

    expect(bookingsQuery.eq).toHaveBeenCalledWith("venue_id", 6);
    expect(bookingsQuery.gte).toHaveBeenCalledWith("booking_date", "2026-09-01");
    expect(bookingsQuery.lte).toHaveBeenCalledWith("booking_date", "2026-09-30");
    expect(bookingsQuery.order).toHaveBeenNthCalledWith(1, "booking_date");
    expect(bookingsQuery.order).toHaveBeenNthCalledWith(2, "start_time");
  });

  it("returns 404 for an unknown or retired venue", async () => {
    const { app } = buildApp({ venue: null });

    const res = await getBookings(app);

    expect(res.status).toBe(404);
  });

  it("returns 502 when events-service can't be reached", async () => {
    const { app } = buildApp({ bookings: [eventBooking], eventsStatus: 500 });

    const res = await getBookings(app);

    expect(res.status).toBe(502);
  });

  it.each([
    ["a non-numeric venue id", "?from=2026-09-01&to=2026-09-30", "abc"],
    ["a missing from date", "?to=2026-09-30", "6"],
    ["an impossible date", "?from=2026-02-30&to=2026-03-01", "6"],
    ["an end before the start", "?from=2026-09-30&to=2026-09-01", "6"],
    ["a range over six weeks", "?from=2026-09-01&to=2026-10-31", "6"],
  ])("returns 400 for %s", async (_label, query, venueId) => {
    const { app, supabase } = buildApp();

    const res = await getBookings(app, query, venueId);

    expect(res.status).toBe(400);
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
