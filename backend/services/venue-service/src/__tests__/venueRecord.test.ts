import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { staffRouter } from "../routes/staff.js";
import { parseVenueInput } from "../lib/venueRecord.js";
import { findBufferOverlaps, findCapacityShortfalls, type LiveBooking } from "../lib/venueChanges.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "VEN-0001", role: "venue_staff" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const validVenue = {
  name: "Courtyard Pavilion",
  location: "East Campus",
  description: "Covered courtyard beside the cafeteria.",
  capacity: 120,
  accessibility: ["Wheelchair access", "Step-free entry"],
  layouts: ["Reception (standing)"],
  facilities: ["PA system", "Power outlets"],
  setupMinutes: 30,
  turnaroundMinutes: 45,
  openingTime: "09:00",
  closingTime: "21:00",
};

/** The venues row as stored, for update tests. */
const storedVenue = {
  id: 6,
  name: "Courtyard Pavilion",
  location: "East Campus",
  description: null,
  capacity: 300,
  accessibility: ["Wheelchair access"],
  layouts: ["Reception (standing)"],
  facilities: ["PA system"],
  setup_minutes: 0,
  turnaround_minutes: 0,
  opening_time: "08:00:00",
  closing_time: "22:00:00",
  status: "Available",
  staff_id: "VEN-0001",
};

function eventInfo(overrides: Record<string, unknown>) {
  return {
    id: 7,
    status: "Confirmed",
    name: "Nut Festival",
    proposedDate: "2099-09-24",
    startTime: "10:00",
    endTime: "12:00",
    expectedAttendance: 200,
    venue: null,
    accessibility: null,
    equipment: null,
    technicalSupport: null,
    coordinatorId: "COO-0001",
    ...overrides,
  };
}

/**
 * venues is read as: options list (select → resolves), my-venues
 * (select → eq → order), single venue (select → eq → maybeSingle), and
 * written by insert/update (… → select → single).
 */
function buildApp(
  options: {
    user?: { id: string; role: string };
    insertError?: boolean;
    existing?: unknown[];
    stored?: Record<string, unknown> | null;
    bookings?: { id: number; event_id: number; status: string; hold_expires_at: string | null }[];
    events?: Record<string, unknown>[];
    notifyOk?: boolean;
  } = {},
) {
  const written = { ...storedVenue, name: validVenue.name, opening_time: "09:00:00", closing_time: "21:00:00" };
  const single = vi.fn().mockResolvedValue(
    options.insertError ? { data: null, error: { message: "boom" } } : { data: { ...written, id: 11 }, error: null },
  );
  const insert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single }) });

  const updateSingle = vi.fn().mockResolvedValue({ data: written, error: null });
  const updateEq = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: updateSingle }) });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  const venueQuery: any = {
    eq: vi.fn(),
    order: vi.fn().mockResolvedValue({ data: options.existing ?? [], error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: options.stored === undefined ? storedVenue : options.stored, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: options.existing ?? [], error: null }),
  };
  venueQuery.eq.mockReturnValue(venueQuery);
  const select = vi.fn().mockReturnValue(venueQuery);

  const bookingsQuery: any = { eq: vi.fn(), in: vi.fn().mockResolvedValue({ data: options.bookings ?? [], error: null }) };
  bookingsQuery.eq.mockReturnValue(bookingsQuery);

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venues") return { insert, select, update };
      if (table === "venue_bookings") return { select: vi.fn().mockReturnValue(bookingsQuery) };
      throw new Error(`unexpected table ${table}`);
    }),
  };

  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    if (url.includes("/venue-booking-info")) {
      return { ok: true, status: 200, json: async () => ({ events: options.events ?? [] }) };
    }
    if (url.includes("/api/notifications")) {
      return { ok: options.notifyOk ?? true, status: 201, json: async () => JSON.parse(init?.body ?? "{}") };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  (globalThis as any).__mockUser = options.user;
  (globalThis as any).__mockSupabase = supabase;

  const app = express();
  app.use(express.json());
  app.use("/api/venues/staff", staffRouter);
  return { app, insert, update, fetchMock };
}

function notificationsSent(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/notifications"));
  return call ? (JSON.parse((call[1] as { body: string }).body).notifications as { recipientId: string; type: string }[]) : [];
}

afterEach(() => {
  delete (globalThis as any).__mockUser;
  delete (globalThis as any).__mockSupabase;
  vi.unstubAllGlobals();
});

describe("parseVenueInput", () => {
  it("accepts a complete venue", () => {
    expect(parseVenueInput(validVenue)).toEqual({ valid: true, venue: validVenue });
  });

  it("AC2: blocks a venue missing mandatory attributes and names each one", () => {
    const result = parseVenueInput({ setupMinutes: 0 });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.missing).toEqual([
        "name",
        "location",
        "maximum capacity",
        "operating hours",
        "supported layouts",
        "facilities",
        "accessibility features",
      ]);
    }
  });

  it("AC3: stores whole-minute setup and turnaround, 0 allowed", () => {
    const result = parseVenueInput({ ...validVenue, setupMinutes: 0, turnaroundMinutes: "15" });
    expect(result).toMatchObject({ valid: true, venue: { setupMinutes: 0, turnaroundMinutes: 15 } });
  });

  it.each([-5, "abc", 1.5, "1e2", "10.0"])("AC4: blocks setup/turnaround of %s", (value) => {
    for (const key of ["setupMinutes", "turnaroundMinutes"]) {
      const result = parseVenueInput({ ...validVenue, [key]: value });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.fields[key]).toBeDefined();
    }
  });

  it.each([0, -1, "abc", 2.5])("AC5: blocks a capacity of %s", (capacity) => {
    const result = parseVenueInput({ ...validVenue, capacity });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.fields.capacity).toBeDefined();
  });

  it("rejects closing before opening, and accepts 24:00 closing", () => {
    expect(parseVenueInput({ ...validVenue, openingTime: "18:00", closingTime: "09:00" }).valid).toBe(false);
    expect(parseVenueInput({ ...validVenue, closingTime: "24:00" }).valid).toBe(true);
  });

  it("trims and de-duplicates option lists", () => {
    const result = parseVenueInput({ ...validVenue, facilities: [" Wi-Fi ", "wi-fi", "", "Stage"] });
    expect(result.valid && result.venue.facilities).toEqual(["Wi-Fi", "Stage"]);
  });

  it("accepts an explicit 'No accessibility features', stored as an empty list", () => {
    const result = parseVenueInput({ ...validVenue, accessibility: [], noAccessibilityFeatures: true });
    expect(result.valid && result.venue.accessibility).toEqual([]);
  });

  it("rejects 'No accessibility features' alongside chosen features", () => {
    const result = parseVenueInput({ ...validVenue, noAccessibilityFeatures: true });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.fields.accessibility).toBeDefined();
      expect(result.missing).toEqual([]);
    }
  });

  it("still treats a blank accessibility section as missing", () => {
    const result = parseVenueInput({ ...validVenue, accessibility: [] });
    expect(!result.valid && result.missing).toEqual(["accessibility features"]);
  });

  it("rejects option lists that aren't string arrays", () => {
    expect(parseVenueInput({ ...validVenue, layouts: "Theatre" }).valid).toBe(false);
  });
});

describe("findCapacityShortfalls (AC6)", () => {
  const booking = (id: number, overrides: Record<string, unknown>, status: "Approved" | "On Hold" = "Approved") =>
    ({ id, status, event: eventInfo({ id, ...overrides }) }) as LiveBooking;
  const today = "2026-10-10";

  it("flags future Approved bookings whose attendance exceeds the reduced capacity", () => {
    const bookings = [
      booking(1, { expectedAttendance: 200 }),
      booking(2, { expectedAttendance: "250" }),
      booking(3, { expectedAttendance: 100 }),
      booking(4, { expectedAttendance: 500 }, "On Hold"),
      booking(5, { expectedAttendance: 500, proposedDate: "2026-01-01" }),
    ];
    expect(findCapacityShortfalls(bookings, 300, 150, today).map((s) => s.bookingId)).toEqual([1, 2]);
  });

  it("flags nothing when capacity isn't reduced", () => {
    expect(findCapacityShortfalls([booking(1, { expectedAttendance: 500 })], 300, 300, today)).toEqual([]);
  });
});

describe("findBufferOverlaps", () => {
  const booking = (id: number, startTime: string, endTime: string) =>
    ({ id, status: "Approved", event: eventInfo({ id, startTime, endTime }) }) as LiveBooking;

  it("reports pairs that only overlap under the new setup/turnaround", () => {
    const bookings = [booking(1, "10:00", "12:00"), booking(2, "12:30", "14:00"), booking(3, "18:00", "19:00")];
    const overlaps = findBufferOverlaps(bookings, {}, { setup_minutes: 15, turnaround_minutes: 30 }, "2026-10-10");
    expect(overlaps.map((o) => [o.first.bookingId, o.second.bookingId])).toEqual([[1, 2]]);
  });

  it("reports nothing when setup and turnaround are unchanged", () => {
    const bookings = [booking(1, "10:00", "12:00"), booking(2, "11:00", "13:00")];
    expect(findBufferOverlaps(bookings, { setup_minutes: 5 }, { setup_minutes: 5 }, "2026-10-10")).toEqual([]);
  });
});

describe("POST /api/venues/staff/venues", () => {
  it("AC1: creates the venue, Available and assigned to the staff member who added it", async () => {
    const { app, insert } = buildApp();
    const res = await request(app).post("/api/venues/staff/venues").send(validVenue);

    expect(res.status).toBe(201);
    expect(res.body.venue).toMatchObject({ id: 11, name: validVenue.name, openingTime: "09:00" });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        capacity: 120,
        setup_minutes: 30,
        turnaround_minutes: 45,
        opening_time: "09:00",
        closing_time: "21:00",
        status: "Available",
        active: true,
        staff_id: "VEN-0001",
      }),
    );
  });

  it("AC2: blocks a venue with missing attributes and names them, without writing", async () => {
    const { app, insert } = buildApp();
    const res = await request(app)
      .post("/api/venues/staff/venues")
      .send({ ...validVenue, location: "", layouts: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Missing required details: location, supported layouts");
    expect(res.body.missing).toEqual(["location", "supported layouts"]);
    expect(insert).not.toHaveBeenCalled();
  });

  it("is venue staff only", async () => {
    const { app, insert } = buildApp({ user: { id: "COO-0001", role: "coordinator" } });
    const res = await request(app).post("/api/venues/staff/venues").send(validVenue);
    expect(res.status).toBe(403);
    expect(insert).not.toHaveBeenCalled();
  });

  it("reports a failed insert", async () => {
    const { app } = buildApp({ insertError: true });
    const res = await request(app).post("/api/venues/staff/venues").send(validVenue);
    expect(res.status).toBe(500);
  });
});

describe("GET /api/venues/staff/my-venues", () => {
  it("returns the caller's venues as form records", async () => {
    const { app } = buildApp({ existing: [storedVenue] });
    const res = await request(app).get("/api/venues/staff/my-venues");

    expect(res.status).toBe(200);
    expect(res.body.venues).toEqual([
      expect.objectContaining({ id: 6, capacity: 300, setupMinutes: 0, openingTime: "08:00", closingTime: "22:00" }),
    ]);
  });
});

describe("PATCH /api/venues/staff/venues/:venueId", () => {
  const approved = { id: 1, event_id: 7, status: "Approved", hold_expires_at: null };

  it("AC1/AC3: saves the new details, including setup and turnaround", async () => {
    const { app, update } = buildApp();
    const res = await request(app).patch("/api/venues/staff/venues/6").send(validVenue);

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ capacity: 120, setup_minutes: 30, turnaround_minutes: 45 }));
  });

  it("AC6: notifies the coordinator when capacity drops below a future Approved booking's attendance", async () => {
    const { app, fetchMock } = buildApp({ bookings: [approved], events: [eventInfo({ expectedAttendance: 200 })] });
    const res = await request(app).patch("/api/venues/staff/venues/6").send({ ...validVenue, setupMinutes: 0, turnaroundMinutes: 0 });

    expect(res.status).toBe(200);
    expect(res.body.capacityShortfalls).toEqual([
      expect.objectContaining({ bookingId: 1, expectedAttendance: 200, hasCoordinator: true }),
    ]);
    expect(res.body.capacityShortfalls[0]).not.toHaveProperty("coordinatorId");
    expect(res.body.coordinatorsNotified).toBe(1);
    expect(notificationsSent(fetchMock)).toEqual([
      expect.objectContaining({ recipientId: "COO-0001", type: "venue_capacity_reduced" }),
    ]);
  });

  it("AC6: notifies nobody when attendance still fits", async () => {
    const { app, fetchMock } = buildApp({ bookings: [approved], events: [eventInfo({ expectedAttendance: 100 })] });
    const res = await request(app).patch("/api/venues/staff/venues/6").send({ ...validVenue, setupMinutes: 0, turnaroundMinutes: 0 });

    expect(res.body.capacityShortfalls).toEqual([]);
    expect(notificationsSent(fetchMock)).toEqual([]);
  });

  it("keeps the save when notifications fail", async () => {
    const { app, update } = buildApp({
      bookings: [approved],
      events: [eventInfo({ expectedAttendance: 200 })],
      notifyOk: false,
    });
    const res = await request(app).patch("/api/venues/staff/venues/6").send(validVenue);

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalled();
    expect(res.body.notificationsFailed).toBe(true);
  });

  it("flags bookings that now overlap under a longer setup/turnaround", async () => {
    const { app, fetchMock } = buildApp({
      bookings: [approved, { id: 2, event_id: 8, status: "Approved", hold_expires_at: null }],
      events: [
        eventInfo({ id: 7, startTime: "10:00", endTime: "12:00", expectedAttendance: 50 }),
        eventInfo({ id: 8, startTime: "12:30", endTime: "14:00", expectedAttendance: 50, coordinatorId: "COO-0002" }),
      ],
    });
    const res = await request(app).patch("/api/venues/staff/venues/6").send(validVenue);

    expect(res.body.bufferOverlaps).toHaveLength(1);
    expect(notificationsSent(fetchMock).map((n) => [n.recipientId, n.type])).toEqual([
      ["COO-0001", "venue_setup_conflict"],
      ["COO-0002", "venue_setup_conflict"],
    ]);
  });

  it("preview reports the impact without writing or notifying", async () => {
    const { app, update, fetchMock } = buildApp({ bookings: [approved], events: [eventInfo({ expectedAttendance: 200 })] });
    const res = await request(app).post("/api/venues/staff/venues/6/preview").send(validVenue);

    expect(res.status).toBe(200);
    expect(res.body.capacityShortfalls).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
    expect(notificationsSent(fetchMock)).toEqual([]);
  });

  it("AC2/AC4/AC5: blocks invalid details without writing", async () => {
    const { app, update } = buildApp();
    const res = await request(app)
      .patch("/api/venues/staff/venues/6")
      .send({ ...validVenue, capacity: 0, setupMinutes: "abc" });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(["capacity", "setupMinutes"]);
    expect(update).not.toHaveBeenCalled();
  });

  it("only the staff member who looks after the venue may edit it", async () => {
    const { app, update } = buildApp({ stored: { ...storedVenue, staff_id: "VEN-0002" } });
    const res = await request(app).patch("/api/venues/staff/venues/6").send(validVenue);

    expect(res.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it("404s an unknown venue", async () => {
    const { app } = buildApp({ stored: null });
    const res = await request(app).patch("/api/venues/staff/venues/99").send(validVenue);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/venues/staff/venue-options", () => {
  it("returns the catalogue plus values existing venues use", async () => {
    const { app } = buildApp({
      existing: [{ location: "East Campus", capacity: 50, accessibility: [], layouts: [], facilities: ["Karaoke machine"] }],
    });
    const res = await request(app).get("/api/venues/staff/venue-options");

    expect(res.status).toBe(200);
    expect(res.body.locations).toEqual(["East Campus"]);
    expect(res.body.facilities).toEqual(expect.arrayContaining(["Karaoke machine", "PA system"]));
    expect(res.body).not.toHaveProperty("capacity");
  });
});
