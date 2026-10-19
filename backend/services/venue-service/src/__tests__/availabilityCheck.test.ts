import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { venuesRouter } from "../routes/venues.js";

/** E3-10 AC2: read-only check of a proposed new date/time for an existing booking. */

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "COORD-0001", role: "coordinator" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

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
