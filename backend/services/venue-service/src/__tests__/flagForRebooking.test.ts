import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { venuesRouter } from "../routes/venues.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

/** E3-11 AC2: flags an Approved booking for rebooking after a coordinator approves an invalidating change request. */

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser ?? { id: "COORD-0001", role: "coordinator" };
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

function buildApp(
  options: {
    user?: { id: string; role: string };
    booking?: { id: number; venue_id: number; event_id: number; status: string } | null;
    bookingError?: boolean;
    eventCoordinatorId?: string | null;
    eventHttpStatus?: number;
    updated?: { id: number; status: string } | null;
    updateError?: boolean;
    staffId?: string | null;
  } = {},
) {
  const resolved = (data: unknown, error: unknown = null) => vi.fn().mockResolvedValue({ data, error });

  const booking =
    options.booking === undefined
      ? { id: 94, venue_id: 4, event_id: 163, status: "Approved" }
      : options.booking;

  const bookingSelectChain: any = {};
  bookingSelectChain.eq = () => bookingSelectChain;
  bookingSelectChain.maybeSingle = resolved(
    options.bookingError ? null : booking,
    options.bookingError ? { message: "boom" } : null,
  );

  const updateChain: any = {};
  updateChain.eq = () => updateChain;
  updateChain.select = () => updateChain;
  updateChain.maybeSingle = resolved(
    options.updateError ? null : options.updated === undefined ? { id: 94, status: "Replacement Required" } : options.updated,
    options.updateError ? { message: "boom" } : null,
  );

  const venueSelectChain: any = {};
  venueSelectChain.eq = () => venueSelectChain;
  venueSelectChain.maybeSingle = resolved(
    { id: 4, name: "Seminar Room 3-01", staff_id: options.staffId === undefined ? "VEN-0001" : options.staffId },
    null,
  );

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venue_bookings") {
        return { select: () => bookingSelectChain, update: () => updateChain };
      }
      if (table === "venues") return { select: () => venueSelectChain };
      throw new Error(`unexpected table ${table}`);
    }),
  };

  const status = options.eventHttpStatus ?? 200;
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      event: {
        id: booking?.event_id ?? 163,
        coordinator_id: options.eventCoordinatorId === undefined ? "COORD-0001" : options.eventCoordinatorId,
      },
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);

  const publish = vi.fn().mockResolvedValue(true);
  setPublisherForTest({ publish });

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? { id: "COORD-0001", role: "coordinator" };

  const app = express();
  app.use(express.json());
  app.use("/api/venues", venuesRouter);
  return { app, publish };
}

function flag(app: express.Express, bookingId = "94", body: Record<string, unknown> = { reason: "Schedule change approved" }) {
  return request(app).post(`/api/venues/bookings/${bookingId}/flag-for-rebooking`).send(body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/venues/bookings/:bookingId/flag-for-rebooking", () => {
  it("400s an invalid booking id", async () => {
    const { app } = buildApp();
    const res = await flag(app, "abc");
    expect(res.status).toBe(400);
  });

  it("400s a missing reason", async () => {
    const { app } = buildApp();
    const res = await flag(app, "94", {});
    expect(res.status).toBe(400);
  });

  it("404s an unknown booking", async () => {
    const { app } = buildApp({ booking: null });
    const res = await flag(app);
    expect(res.status).toBe(404);
  });

  it("500s when the booking lookup fails", async () => {
    const { app } = buildApp({ bookingError: true });
    const res = await flag(app);
    expect(res.status).toBe(500);
  });

  it("403s a coordinator who isn't assigned to the event", async () => {
    const { app } = buildApp({ eventCoordinatorId: "COORD-0002" });
    const res = await flag(app);
    expect(res.status).toBe(403);
  });

  it("502s when the event can't be loaded", async () => {
    const { app } = buildApp({ eventHttpStatus: 500 });
    const res = await flag(app);
    expect(res.status).toBe(502);
  });

  it("409s a booking that isn't Approved", async () => {
    const { app } = buildApp({ booking: { id: 94, venue_id: 4, event_id: 163, status: "Requested" } });
    const res = await flag(app);
    expect(res.status).toBe(409);
  });

  it("flags an Approved booking as Replacement Required and notifies the venue's staff", async () => {
    const { app, publish } = buildApp();
    const res = await flag(app, "94", { reason: "Attendance change invalidated this booking" });

    expect(res.status).toBe(200);
    expect(res.body.booking).toEqual({ id: 94, status: "Replacement Required" });
    expect(res.body.staffNotified).toBe(true);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "booking.flagged_for_rebooking",
        recipients: { userIds: ["VEN-0001"], roles: [] },
      }),
    );
  });

  it("doesn't notify, but still flags, when the venue has no staff assigned", async () => {
    const { app, publish } = buildApp({ staffId: null });
    const res = await flag(app);

    expect(res.status).toBe(200);
    expect(res.body.staffNotified).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("409s when the booking was decided again in the meantime", async () => {
    const { app } = buildApp({ updated: null });
    const res = await flag(app);
    expect(res.status).toBe(409);
  });

  it("500s when the update fails", async () => {
    const { app } = buildApp({ updateError: true });
    const res = await flag(app);
    expect(res.status).toBe(500);
  });
});
