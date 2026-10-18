import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { venuesRouter } from "../routes/venues.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "COORD-0001", role: "coordinator" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

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
