import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { venuesRouter } from "../routes/venues.js";
import { suitabilityRouter } from "../routes/suitability.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { checkSuitability, effectivePlan, parseBookingPlan, type EventDefaults } from "../lib/bookingPlan.js";

/** E4-17: each venue booking is checked against its own purpose, headcount and needs. */

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "COORD-0001", role: "coordinator" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

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
