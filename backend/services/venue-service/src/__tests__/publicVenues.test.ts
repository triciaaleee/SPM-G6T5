import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { from: (...args: unknown[]) => from(...args) } }));

const fetchPublicEvents = vi.fn();
vi.mock("../lib/eventsClient.js", () => ({ fetchPublicEvents: () => fetchPublicEvents() }));

const { publicVenuesRouter } = await import("../routes/publicVenues.js");

/** A thenable supabase-js style query: every filter returns it, awaiting it yields `result`. */
function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "in", "order"]) q[method] = vi.fn(() => q);
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return q;
}

function mockTables(tables: { venues?: unknown[]; bookings?: unknown[]; venuesError?: unknown }) {
  const venues = query({ data: tables.venues ?? [], error: tables.venuesError ?? null });
  const bookings = query({ data: tables.bookings ?? [], error: null });
  from.mockImplementation((table: string) => (table === "venues" ? venues : bookings));
  return { venues, bookings };
}

const hall = {
  id: 1,
  name: "Main Hall",
  location: "Block A",
  description: "Big hall",
  capacity: 300,
  accessibility: ["Wheelchair access"],
  layouts: ["Theatre"],
  facilities: ["Projector"],
};

function buildApp() {
  const app = express();
  app.use("/api/venues/public", publicVenuesRouter);
  return app;
}

beforeEach(() => {
  from.mockReset();
  fetchPublicEvents.mockReset().mockResolvedValue({ status: "ok", events: [] });
});

describe("GET /api/venues/public", () => {
  it("needs no token and lists Available venues with only the public columns", async () => {
    const { venues } = mockTables({ venues: [hall] });

    const res = await request(buildApp()).get("/api/venues/public");

    expect(res.status).toBe(200);
    expect(venues.eq).toHaveBeenCalledWith("status", "Available");
    expect(venues.select).toHaveBeenCalledWith(expect.not.stringContaining("staff_id"));
    expect(venues.select).toHaveBeenCalledWith(expect.not.stringContaining("setup_minutes"));
    expect(res.body.venues).toEqual([{ ...hall, upcomingEvents: [] }]);
  });

  it("adds each venue's publicly listed events, soonest first, from Approved bookings only", async () => {
    fetchPublicEvents.mockResolvedValue({
      status: "ok",
      events: [
        { id: 5, name: "Late Fair", proposedDate: "2099-03-01", startTime: "10:00" },
        { id: 6, name: "Early Fair", proposedDate: "2099-01-01", startTime: "10:00" },
      ],
    });
    const { bookings } = mockTables({
      venues: [hall],
      bookings: [
        { event_id: 5, venue_id: 1, venues: { name: "Main Hall" } },
        { event_id: 6, venue_id: 1, venues: { name: "Main Hall" } },
      ],
    });

    const res = await request(buildApp()).get("/api/venues/public");

    expect(bookings.eq).toHaveBeenCalledWith("status", "Approved");
    expect(bookings.in).toHaveBeenCalledWith("event_id", [5, 6]);
    expect(res.body.venues[0].upcomingEvents.map((e: { name: string }) => e.name)).toEqual(["Early Fair", "Late Fair"]);
  });

  it("answers 502 when the public event list can't be loaded", async () => {
    mockTables({ venues: [hall] });
    fetchPublicEvents.mockResolvedValue({ status: "error" });

    const res = await request(buildApp()).get("/api/venues/public");

    expect(res.status).toBe(502);
  });
});

describe("GET /api/venues/public/event-venues", () => {
  it("returns venue names for listed events and ignores ids for any other event", async () => {
    fetchPublicEvents.mockResolvedValue({ status: "ok", events: [{ id: 5, name: "Fair", proposedDate: null, startTime: null }] });
    const { bookings } = mockTables({ bookings: [{ event_id: 5, venue_id: 1, venues: { name: "Main Hall" } }] });

    const res = await request(buildApp()).get("/api/venues/public/event-venues?eventIds=5,9");

    expect(res.status).toBe(200);
    expect(bookings.in).toHaveBeenCalledWith("event_id", [5]);
    expect(res.body.venues).toEqual([{ eventId: 5, venueName: "Main Hall" }]);
  });

  it("doesn't query bookings at all when none of the ids are listed", async () => {
    mockTables({});

    const res = await request(buildApp()).get("/api/venues/public/event-venues?eventIds=9");

    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  it("answers 400 for malformed ids", async () => {
    const res = await request(buildApp()).get("/api/venues/public/event-venues?eventIds=abc");

    expect(res.status).toBe(400);
  });
});
