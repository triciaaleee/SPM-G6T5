import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { venuesRouter } from "../routes/venues.js";
import { OPTION_CATALOGUE, buildFilterOptions, parseVenueSearch, searchVenues, type VenueRow } from "../lib/venueSearch.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "COORD-0001", role: "coordinator" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

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

function buildApp(
  options: {
    user?: { id: string; role: string };
    bookings?: { venue_id: number; event_id: number }[];
    events?: Record<string, unknown>[];
    unavailability?: Record<string, unknown>[];
    buffers?: { id: number; setup_minutes: number; turnaround_minutes: number }[];
  } = {},
) {
  // E4-3: block-out periods and the blocked venues' setup/turnaround, read by findBlockedVenueIds.
  const unavailabilityGte = vi.fn().mockResolvedValue({ data: options.unavailability ?? [], error: null });
  const venuesIn = vi.fn().mockResolvedValue({ data: options.buffers ?? [], error: null });
  const bookingsThen = vi.fn((resolve: (value: unknown) => void) =>
    resolve({ data: options.bookings ?? [], error: null }),
  );
  const bookingsQuery = { then: bookingsThen };

  const venuesEq = vi.fn().mockResolvedValue({ data: venues, error: null });

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venues") return { select: vi.fn().mockReturnValue({ eq: venuesEq, in: venuesIn }) };
      if (table === "venue_bookings") return { select: vi.fn().mockReturnValue(bookingsQuery) };
      if (table === "venue_unavailability") return { select: () => ({ lte: () => ({ gte: unavailabilityGte }) }) };
      throw new Error(`unexpected table ${table}`);
    }),
  };

  // findUnavailableVenueIds fetches each booking's event via events-service
  // (fetchVenueBookingInfo), same pattern as staff.test.ts.
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ events: options.events ?? [] }),
  });
  vi.stubGlobal("fetch", fetchMock);

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

  const app = express();
  app.use(express.json());
  app.use("/api/venues", venuesRouter);
  return { app, supabase, bookingsQuery, fetchMock };
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

  it("AC2: excludes venues with a booking overlapping the window", async () => {
    const { app } = buildApp({
      bookings: [{ venue_id: 1, event_id: 42 }],
      events: [{ id: 42, proposedDate: "2026-09-25", startTime: "18:00", endTime: "21:00" }],
    });
    const res = await request(app)
      .get("/api/venues")
      .query({ date: "2026-09-25", startTime: "18:00", endTime: "21:00" });

    expect(res.status).toBe(200);
    expect(res.body.venues.map((v: VenueRow) => v.id)).not.toContain(1);
  });

  it("doesn't exclude a venue whose booking is on a different date", async () => {
    const { app } = buildApp({
      bookings: [{ venue_id: 1, event_id: 42 }],
      events: [{ id: 42, proposedDate: "2026-09-01", startTime: "18:00", endTime: "21:00" }],
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
      buffers: [{ id: 1, setup_minutes: 30, turnaround_minutes: 0 }],
    });
    const res = await request(app)
      .get("/api/venues")
      .query({ date: "2026-09-25", startTime: "18:00", endTime: "21:00" });

    expect(res.status).toBe(200);
    expect(res.body.venues.map((v: VenueRow) => v.id)).not.toContain(1);
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
