import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { staffRouter } from "../routes/staff.js";
import { AUTO_REJECT_REASON } from "../lib/bookingDecisions.js";
import { HOLD_DURATION_HOURS, canTransition } from "../lib/bookingStatus.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "VEN-0001", role: "venue_staff" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const staff = { id: "VEN-0001", role: "venue_staff" };

/** Venue 1 pads every booking by 30 min setup and 45 min turnaround. */
const venues = [
  {
    id: 1,
    name: "Grand Ballroom",
    location: "Central Campus",
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
    capacity: 40,
    accessibility: [],
    layouts: ["Classroom"],
    facilities: ["Projector"],
    setup_minutes: 0,
    turnaround_minutes: 0,
  },
];

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

function booking(overrides: Partial<BookingFixture> & { id: number }): BookingFixture {
  return {
    venue_id: 1,
    event_id: 7,
    status: "Requested",
    hold_expires_at: null,
    decision_reason: null,
    decided_by: null,
    decided_at: null,
    ...overrides,
  };
}

/** The event under decision: 2026-11-10 10:00–12:00 → 09:30–12:45 at venue 1. */
function bookedEvent(id: number, startTime = "10:00", endTime = "12:00", date = "2026-11-10") {
  return {
    id,
    // venue-booking-info carries the lifecycle status, since venue staff
    // cannot read an event any other way (E4-10 AC2).
    status: "Planning",
    name: `Event ${id}`,
    proposedDate: date,
    startTime,
    endTime,
    expectedAttendance: 120,
    venue: "Banquet",
    equipment: "PA system",
    accessibility: "NA",
    technicalSupport: "None",
  };
}

/**
 * A hand-rolled Supabase double. venue_bookings is queried four ways, so
 * the builder records the filters each call applies and answers from the
 * fixture list; updates are captured for assertions.
 */
function buildApp(
  options: {
    user?: { id: string; role: string };
    assignedVenueIds?: number[];
    bookings?: BookingFixture[];
    events?: Record<string, unknown>[];
    eventStatus?: string;
    eventHttpStatus?: number;
    updateReturnsNothing?: boolean;
  } = {},
) {
  const rows = options.bookings ?? [];
  const updates: { filters: Record<string, unknown>; ids?: number[]; patch: Record<string, unknown> }[] = [];
  /** Venue ids this staff member owns (venues.staff_id). */
  const assigned = options.assignedVenueIds ?? [1, 2];

  function bookingsQuery() {
    const filters: Record<string, unknown> = {};
    const q: any = {
      eq: vi.fn((column: string, value: unknown) => {
        filters[column] = value;
        return q;
      }),
      in: vi.fn((column: string, values: unknown[]) => {
        filters[`${column}__in`] = values;
        return q;
      }),
      maybeSingle: vi.fn(async () => ({ data: match(filters)[0] ?? null, error: null })),
      then: undefined,
    };
    // Awaiting the builder itself resolves to the full list.
    q.then = (resolve: (value: unknown) => unknown) => resolve({ data: match(filters), error: null });
    return q;
  }

  function match(filters: Record<string, unknown>): BookingFixture[] {
    return rows.filter((row) => {
      if (filters.id !== undefined && row.id !== filters.id) return false;
      if (filters.venue_id !== undefined && row.venue_id !== filters.venue_id) return false;
      if (filters.status !== undefined && row.status !== filters.status) return false;
      const statusIn = filters.status__in as string[] | undefined;
      if (statusIn && !statusIn.includes(row.status)) return false;
      const venueIn = filters.venue_id__in as number[] | undefined;
      if (venueIn && !venueIn.includes(row.venue_id)) return false;
      return true;
    });
  }

  function updateBuilder(patch: Record<string, unknown>) {
    const filters: Record<string, unknown> = {};
    let ids: number[] | undefined;
    const q: any = {
      eq: vi.fn((column: string, value: unknown) => {
        filters[column] = value;
        return q;
      }),
      in: vi.fn((column: string, values: number[]) => {
        ids = values;
        return q;
      }),
      select: vi.fn(() => q),
      maybeSingle: vi.fn(async () => {
        updates.push({ filters, ids, patch });
        if (options.updateReturnsNothing) return { data: null, error: null };
        const target = rows.find((row) => row.id === filters.id);
        return { data: target ? { ...target, ...patch } : null, error: null };
      }),
    };
    q.then = (resolve: (value: unknown) => unknown) => {
      updates.push({ filters, ids, patch });
      return resolve({ data: null, error: null });
    };
    return q;
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venue_bookings") {
        return { select: vi.fn(() => bookingsQuery()), update: vi.fn((patch: Record<string, unknown>) => updateBuilder(patch)) };
      }
      if (table === "venues") {
        // venues is read three ways: the assignment check
        // (.eq("id").eq("staff_id")), this staff member's venues
        // (.eq("staff_id")), and the venue behind one booking (.eq("id")).
        const filters: Record<string, unknown> = {};
        const matching = () =>
          venues.filter((venue) => {
            if (filters.id !== undefined && venue.id !== filters.id) return false;
            if (filters.staff_id !== undefined && !assigned.includes(venue.id)) return false;
            return true;
          });
        const q: any = {
          eq: vi.fn((column: string, value: unknown) => {
            filters[column] = value;
            return q;
          }),
          in: vi.fn(() => q),
          maybeSingle: vi.fn(async () => ({ data: matching()[0] ?? null, error: null })),
        };
        q.then = (resolve: (value: unknown) => unknown) => resolve({ data: matching(), error: null });
        return { select: vi.fn(() => q) };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };

  const eventHttpStatus = options.eventHttpStatus ?? 200;
  const fetchMock = vi.fn(async (url: string) => {
    const events = (options.events ?? [bookedEvent(7)]).map((event) =>
      options.eventStatus && (event as { id: number }).id === 7
        ? { ...event, status: options.eventStatus }
        : event,
    );
    return {
      ok: eventHttpStatus >= 200 && eventHttpStatus < 300,
      status: eventHttpStatus,
      json: async () => ({ events }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? staff;

  const app = express();
  app.use(express.json());
  app.use("/api/venues/staff", staffRouter);
  return { app, supabase, updates, fetchMock };
}

function act(app: express.Express, action: string, bookingId = 10, body: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/venues/staff/bookings/${bookingId}/${action}`)
    .set("Authorization", "Bearer test-token")
    .send(body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canTransition", () => {
  it("allows the decisions §3a lists", () => {
    expect(canTransition("Requested", "On Hold")).toBe(true);
    expect(canTransition("Requested", "Approved")).toBe(true);
    expect(canTransition("On Hold", "Approved")).toBe(true);
    expect(canTransition("On Hold", "Rejected")).toBe(true);
  });

  it("treats Rejected, Expired and Withdrawn as end states", () => {
    for (const from of ["Rejected", "Expired", "Withdrawn"] as const) {
      expect(canTransition(from, "Approved")).toBe(false);
      expect(canTransition(from, "On Hold")).toBe(false);
    }
  });

  it("AC5: offers no way back to Requested, so a decision can't be overridden", () => {
    for (const from of ["On Hold", "Approved", "Rejected", "Expired", "Withdrawn"] as const) {
      expect(canTransition(from, "Requested")).toBe(false);
    }
  });
});

describe("venue staff decision access", () => {
  it.each([
    ["a coordinator", { id: "COORD-0001", role: "coordinator" }],
    ["an organiser", { id: "ORG-0001", role: "organiser" }],
  ])("AC5/AC7: rejects %s with 403", async (_label, user) => {
    const { app, supabase } = buildApp({ user, bookings: [booking({ id: 10 })] });
    expect((await act(app, "approve")).status).toBe(403);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("AC7: blocks venue staff who aren't assigned to that venue", async () => {
    const { app, updates } = buildApp({ bookings: [booking({ id: 10 })], assignedVenueIds: [2] });
    const res = await act(app, "hold");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not assigned/i);
    expect(updates).toHaveLength(0);
  });
});

describe("POST /bookings/:id/hold", () => {
  it("AC1: holds the venue with a 72-hour expiry", async () => {
    const { app, updates } = buildApp({ bookings: [booking({ id: 10 })] });
    const res = await act(app, "hold");

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("On Hold");
    const patch = updates[0].patch as { hold_expires_at: string; decided_by: string };
    const hours = (Date.parse(patch.hold_expires_at) - Date.now()) / (60 * 60 * 1000);
    expect(hours).toBeGreaterThan(HOLD_DURATION_HOURS - 1);
    expect(hours).toBeLessThanOrEqual(HOLD_DURATION_HOURS);
    expect(patch.decided_by).toBe("VEN-0001");
  });

  it("AC2: blocked by an overlapping approved booking, with the window shown", async () => {
    const { app, updates } = buildApp({
      bookings: [booking({ id: 10 }), booking({ id: 11, event_id: 20, status: "Approved" })],
      // 12:30 is past the event's 12:00 end but inside its 12:45 turnaround.
      events: [bookedEvent(7), bookedEvent(20, "12:30", "14:00")],
    });
    const res = await act(app, "hold");

    expect(res.status).toBe(409);
    expect(res.body.conflict).toMatchObject({
      bookingId: 11,
      status: "Approved",
      window: "2026-11-10 12:00–14:45",
      requestedWindow: "2026-11-10 09:30–12:45",
    });
    expect(updates).toHaveLength(0);
  });

  it("AC2: blocked by an unexpired hold on the same period", async () => {
    const { app } = buildApp({
      bookings: [
        booking({ id: 10 }),
        booking({ id: 11, event_id: 20, status: "On Hold", hold_expires_at: "2099-01-01T00:00:00.000Z" }),
      ],
      events: [bookedEvent(7), bookedEvent(20)],
    });
    const res = await act(app, "hold");

    expect(res.status).toBe(409);
    expect(res.body.conflict.status).toBe("On Hold");
  });

  it("ignores a hold that has already lapsed", async () => {
    const { app } = buildApp({
      bookings: [
        booking({ id: 10 }),
        booking({ id: 11, event_id: 20, status: "On Hold", hold_expires_at: "2020-01-01T00:00:00.000Z" }),
      ],
      events: [bookedEvent(7), bookedEvent(20)],
    });

    expect((await act(app, "hold")).status).toBe(200);
  });

  it.each(["Safety Review", "Confirmed", "Cancelled", "Rejected"])(
    "AC2: blocked once the event is %s rather than Planning",
    async (status) => {
      const { app, updates } = buildApp({ bookings: [booking({ id: 10 })], eventStatus: status });
      const res = await act(app, "hold");

      expect(res.status).toBe(409);
      expect(res.body.error).toContain(status);
      expect(updates).toHaveLength(0);
    },
  );
});

describe("POST /bookings/:id/approve", () => {
  it("AC3: approves a request and clears any hold", async () => {
    const { app, updates } = buildApp({ bookings: [booking({ id: 10 })] });
    const res = await act(app, "approve");

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("Approved");
    expect(updates[0].patch).toMatchObject({ status: "Approved", hold_expires_at: null, decided_by: "VEN-0001" });
  });

  it("AC3: approves a booking that is on hold", async () => {
    const { app } = buildApp({
      bookings: [booking({ id: 10, status: "On Hold", hold_expires_at: "2099-01-01T00:00:00.000Z" })],
    });

    expect((await act(app, "approve")).status).toBe(200);
  });

  it("E4-12: refuses to approve a hold that has already lapsed, and expires it", async () => {
    const { app, updates } = buildApp({
      bookings: [booking({ id: 10, status: "On Hold", hold_expires_at: "2020-01-01T00:00:00.000Z" })],
    });
    const res = await act(app, "approve");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/expired/i);
    expect(updates[0].patch).toMatchObject({ status: "Expired", decided_by: null });
  });

  it.each(["Rejected", "Expired", "Withdrawn", "Approved"])("refuses a %s booking", async (status) => {
    const { app, updates } = buildApp({ bookings: [booking({ id: 10, status, decision_reason: "x" })] });
    const res = await act(app, "approve");

    expect(res.status).toBe(409);
    expect(updates).toHaveLength(0);
  });

  it("E4-11 AC4: auto-rejects the overlapping requests that lost the venue", async () => {
    const { app, updates } = buildApp({
      bookings: [
        booking({ id: 10 }),
        booking({ id: 11, event_id: 21 }), // overlaps → loses
        booking({ id: 12, event_id: 22 }), // same day, no overlap → survives
        booking({ id: 13, event_id: 23, venue_id: 2 }), // other venue → untouched
      ],
      events: [bookedEvent(7), bookedEvent(21, "11:00", "13:00"), bookedEvent(22, "16:00", "18:00"), bookedEvent(23)],
    });
    const res = await act(app, "approve");

    expect(res.status).toBe(200);
    expect(res.body.autoRejectedBookingIds).toEqual([11]);
    const autoReject = updates.find((update) => update.patch.status === "Rejected");
    expect(autoReject?.ids).toEqual([11]);
    expect(autoReject?.patch).toMatchObject({ decision_reason: AUTO_REJECT_REASON, decided_by: null });
  });

  it("409s when another decision landed first", async () => {
    const { app } = buildApp({ bookings: [booking({ id: 10 })], updateReturnsNothing: true });
    const res = await act(app, "approve");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/someone else/i);
  });
});

describe("POST /bookings/:id/reject", () => {
  it("AC4: requires a reason", async () => {
    const { app, updates } = buildApp({ bookings: [booking({ id: 10 })] });
    const res = await act(app, "reject", 10, { reason: "   " });

    expect(res.status).toBe(400);
    expect(res.body.fields.reason).toBeDefined();
    expect(updates).toHaveLength(0);
  });

  it("AC4: records the reason and the decider, and releases any hold", async () => {
    const { app, updates } = buildApp({
      bookings: [booking({ id: 10, status: "On Hold", hold_expires_at: "2099-01-01T00:00:00.000Z" })],
    });
    const res = await act(app, "reject", 10, { reason: "  Floor resurfacing that week  " });

    expect(res.status).toBe(200);
    expect(res.body.booking.status).toBe("Rejected");
    expect(updates[0].patch).toMatchObject({
      status: "Rejected",
      decision_reason: "Floor resurfacing that week",
      decided_by: "VEN-0001",
      hold_expires_at: null,
    });
  });

  it("doesn't ask events-service anything — a request can be refused whatever the event is doing", async () => {
    const { app, fetchMock } = buildApp({ bookings: [booking({ id: 10 })] });
    await act(app, "reject", 10, { reason: "Double-booked internally" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a booking that doesn't exist", async () => {
    const { app } = buildApp({ bookings: [] });
    expect((await act(app, "reject", 10, { reason: "no" })).status).toBe(404);
  });

  it("returns 400 for a non-numeric booking id", async () => {
    const { app } = buildApp({ bookings: [] });
    const res = await request(app)
      .post("/api/venues/staff/bookings/abc/reject")
      .set("Authorization", "Bearer t")
      .send({ reason: "no" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/venues/staff/requests", () => {
  function queue(app: express.Express) {
    return request(app).get("/api/venues/staff/requests").set("Authorization", "Bearer test-token");
  }

  it("AC6: lists pending requests ordered by event date, soonest first", async () => {
    const { app } = buildApp({
      bookings: [
        booking({ id: 10, event_id: 7 }),
        booking({ id: 11, event_id: 21 }),
        booking({ id: 12, event_id: 22, status: "On Hold", hold_expires_at: "2099-01-01T00:00:00.000Z" }),
      ],
      events: [
        bookedEvent(7, "10:00", "12:00", "2026-11-10"),
        bookedEvent(21, "09:00", "10:00", "2026-11-02"),
        bookedEvent(22, "14:00", "16:00", "2026-11-10"),
      ],
    });
    const res = await queue(app);

    expect(res.status).toBe(200);
    expect(res.body.requests.map((r: { id: number }) => r.id)).toEqual([11, 10, 12]);
    expect(res.body.requests[2]).toMatchObject({ status: "On Hold", venue: { setupMinutes: 30, turnaroundMinutes: 45 } });
  });

  it("leaves out decided bookings", async () => {
    const { app } = buildApp({
      bookings: [
        booking({ id: 10, status: "Approved" }),
        booking({ id: 11, status: "Rejected", decision_reason: "x" }),
        booking({ id: 12, status: "Withdrawn" }),
      ],
    });
    const res = await queue(app);

    expect(res.body.requests).toEqual([]);
  });

  it("E4-12 AC4: expires a lapsed hold and drops it from the queue", async () => {
    const { app, updates } = buildApp({
      bookings: [booking({ id: 10, status: "On Hold", hold_expires_at: "2020-01-01T00:00:00.000Z" })],
    });
    const res = await queue(app);

    expect(res.body.requests).toEqual([]);
    expect(updates[0]).toMatchObject({ ids: [10], patch: { status: "Expired", decided_by: null } });
  });

  it("AC7: only covers the venues this staff member is assigned to", async () => {
    const { app } = buildApp({
      assignedVenueIds: [2],
      bookings: [booking({ id: 10, venue_id: 1 }), booking({ id: 11, venue_id: 2, event_id: 21 })],
      events: [bookedEvent(21)],
    });
    const res = await queue(app);

    expect(res.body.requests.map((r: { id: number }) => r.id)).toEqual([11]);
  });

  it("returns nothing for a staff member with no venues", async () => {
    const { app, supabase } = buildApp({ assignedVenueIds: [], bookings: [booking({ id: 10 })] });
    const res = await queue(app);

    expect(res.body.requests).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalledWith("venue_bookings");
  });
});
