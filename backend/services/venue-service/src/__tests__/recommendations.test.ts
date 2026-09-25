import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { venuesRouter } from "../routes/venues.js";
import { extractFeatures, extractRequirements, isNoPreference } from "../lib/venueRecommendation.js";
import type { VenueRow } from "../lib/venueSearch.js";

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

type Booking = { venue_id: number; event_id: number | null };

function buildApp(
  options: {
    user?: { id: string; role: string };
    event?: Record<string, unknown>;
    eventStatus?: number;
    bookings?: Booking[];
  } = {},
) {
  const bookingsQuery = {
    eq: vi.fn(),
    lt: vi.fn(),
    gt: vi.fn(),
    then: (resolve: (value: unknown) => void) => resolve({ data: options.bookings ?? [], error: null }),
  };
  bookingsQuery.eq.mockReturnValue(bookingsQuery);
  bookingsQuery.lt.mockReturnValue(bookingsQuery);
  bookingsQuery.gt.mockReturnValue(bookingsQuery);

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venues") {
        return { select: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: venues, error: null }) }) };
      }
      if (table === "venue_bookings") return { select: vi.fn().mockReturnValue(bookingsQuery) };
      throw new Error(`unexpected table ${table}`);
    }),
  };

  const status = options.eventStatus ?? 200;
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ event: { id: 7, status: "Planning", submitted_details: options.event ?? details() } }),
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
    expect(res.body.requirements.facilities).toEqual(["Projector", "Wi-Fi"]);
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
    const { app, bookingsQuery } = buildApp({
      event: details({ equipment: "Projector" }),
      bookings: [
        { venue_id: 1, event_id: null },
        { venue_id: 3, event_id: 7 },
      ],
    });
    const res = await recommend(app);

    expect(bookingsQuery.eq).toHaveBeenCalledWith("booking_date", "2026-11-10");
    expect(bookingsQuery.lt).toHaveBeenCalledWith("start_time", "16:00");
    expect(bookingsQuery.gt).toHaveBeenCalledWith("end_time", "14:00");
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
