// @ts-nocheck
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

/** E3-9 (#34) submit; E3-8 (#33) holds critical fields instead of applying them. */

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

const organiser = { id: "ORG-0001", role: "organiser" };
const coordinator = { id: "COORD-0001", role: "coordinator" };

const submittedDetails = {
  name: "Spring Gala",
  purpose: "Celebration",
  description: "End of year gala",
  proposedDate: "2099-06-01",
  startTime: "18:00",
  endTime: "21:00",
  expectedAttendance: 100,
  venue: "Grand Ballroom",
  accessibility: "Step-free access",
  equipment: "Stage and lighting",
  technicalSupport: "AV crew",
  registrationNeeded: true,
};

const publish = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  publish.mockReset().mockResolvedValue(true);
  setPublisherForTest({ publish });
});

interface Options {
  user?: { id: string; role: string };
  status?: string;
  coordinatorId?: string | null;
  insertRequestError?: boolean;
  updateError?: boolean;
  /** For GET: the stored change_requests rows and their fields. */
  storedRequests?: Record<string, unknown>[];
  storedFields?: Record<string, unknown>[];
  listRequestsError?: boolean;
  listFieldsError?: boolean;
  /** For POST merge behavior: the event's already-open Pending request, if any. */
  openRequest?: { id: number } | null;
  openRequestError?: boolean;
  openFields?: { id: number; field: string; old_value: string | null; new_value: string; is_critical: boolean }[];
  openFieldsError?: boolean;
  upsertError?: boolean;
  deleteError?: boolean;
  resolveError?: boolean;
}

function buildApp(options: Options = {}) {
  const event = {
    id: 7,
    status: options.status ?? "Confirmed",
    organiser_id: "ORG-0001",
    coordinator_id: options.coordinatorId === undefined ? "COORD-0001" : options.coordinatorId,
    submitted_details: submittedDetails,
  };

  const resolved = (data: unknown, error: unknown = null) => vi.fn().mockResolvedValue({ data, error });

  // change_requests.select() backs two different call shapes: GET's
  // .select().eq().order() (every request for the event) and POST's
  // .select().eq().eq().maybeSingle() (the one open Pending request) —
  // one chainable stub answers both, since every method just returns
  // itself except the two terminal ones.
  const changeRequestsSelectChain: any = {};
  changeRequestsSelectChain.eq = () => changeRequestsSelectChain;
  changeRequestsSelectChain.order = resolved(
    options.listRequestsError ? null : options.storedRequests ?? [],
    options.listRequestsError ? { message: "boom" } : null,
  );
  changeRequestsSelectChain.maybeSingle = resolved(
    options.openRequestError ? null : options.openRequest ?? null,
    options.openRequestError ? { message: "boom" } : null,
  );

  // change_request_fields.select() likewise backs GET's .in() (every
  // field of several requests) and POST's .eq() (one open request's
  // fields).
  const fieldsSelectChain: any = {};
  fieldsSelectChain.in = resolved(
    options.listFieldsError ? null : options.storedFields ?? [],
    options.listFieldsError ? { message: "boom" } : null,
  );
  fieldsSelectChain.eq = resolved(
    options.openFieldsError ? null : options.openFields ?? [],
    options.openFieldsError ? { message: "boom" } : null,
  );

  const deleteChain: any = {};
  deleteChain.eq = () => deleteChain;
  deleteChain.in = resolved(null, options.deleteError ? { message: "boom" } : null);

  const insertChangeRequest = vi.fn(() => ({
    select: () => ({
      single: resolved(
        options.insertRequestError ? null : { id: 55 },
        options.insertRequestError ? { message: "boom" } : null,
      ),
    }),
  }));
  const updateChangeRequest = vi.fn(() => ({
    eq: resolved(null, options.resolveError ? { message: "boom" } : null),
  }));

  // events.update() is awaited after one or two .eq() filters (the Needs
  // Review move adds a status filter), so the chain is thenable at every depth.
  const updateEvent = vi.fn((_patch: Record<string, unknown>) => {
    const result = { data: null, error: options.updateError ? { message: "boom" } : null };
    const chain: any = { eq: () => chain, then: (resolve: (value: unknown) => unknown) => resolve(result) };
    return chain;
  });

  const tables: Record<string, any> = {
    events: {
      select: () => ({ eq: () => ({ maybeSingle: resolved(event) }) }),
      update: updateEvent,
    },
    event_history: { insert: resolved(null) },
    change_requests: {
      insert: insertChangeRequest,
      select: () => changeRequestsSelectChain,
      update: updateChangeRequest,
    },
    change_request_fields: {
      upsert: resolved(null, options.upsertError ? { message: "boom" } : null),
      delete: () => deleteChain,
      select: () => fieldsSelectChain,
    },
    access_denials: { insert: resolved(null) },
  };

  (globalThis as any).__mockSupabase = { from: vi.fn((table: string) => tables[table]) };
  (globalThis as any).__mockUser = options.user ?? organiser;

  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  // Stashed rather than returned alongside `app` so every existing
  // `const app = buildApp(...)` call site keeps working unchanged; only
  // tests that care about the exact insert/update payload reach for this.
  (app as any).__spies = { insertChangeRequest, updateChangeRequest, updateEvent };
  return app;
}

describe("POST /api/events/:id/change-requests", () => {
  it("blocks a non-owner", async () => {
    const app = buildApp({ user: { id: "ORG-0002", role: "organiser" } });
    const res = await request(app).post("/api/events/7/change-requests").send({ description: "New text" });
    expect(res.status).toBe(403);
  });

  it("blocks when the event is not Confirmed", async () => {
    const app = buildApp({ status: "Planning" });
    const res = await request(app).post("/api/events/7/change-requests").send({ description: "New text" });
    expect(res.status).toBe(409);
  });

  it("moves a Confirmed event to Needs Review when a critical field is held", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/events/7/change-requests").send({ expectedAttendance: 150 });
    expect(res.status).toBe(201);
    expect((app as any).__spies.updateEvent).toHaveBeenCalledWith({ status: "Needs Review" });
  });

  it("leaves the status alone when only a non-critical field changes", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/events/7/change-requests").send({ description: "New text" });
    expect(res.status).toBe(201);
    expect((app as any).__spies.updateEvent).not.toHaveBeenCalledWith({ status: "Needs Review" });
  });

  it("accepts another change request while the event is already in Needs Review", async () => {
    const app = buildApp({ status: "Needs Review" });
    const res = await request(app).post("/api/events/7/change-requests").send({ expectedAttendance: 150 });
    expect(res.status).toBe(201);
    expect((app as any).__spies.updateEvent).not.toHaveBeenCalledWith({ status: "Needs Review" });
  });

  it("blocks a Completed event", async () => {
    const app = buildApp({ status: "Completed" });
    const res = await request(app).post("/api/events/7/change-requests").send({ description: "New text" });
    expect(res.status).toBe(409);
  });

  it("blocks a Cancelled event", async () => {
    const app = buildApp({ status: "Cancelled" });
    const res = await request(app).post("/api/events/7/change-requests").send({ description: "New text" });
    expect(res.status).toBe(409);
  });

  it("rejects an invalid field value", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/events/7/change-requests")
      .send({ expectedAttendance: -5 });
    expect(res.status).toBe(400);
    expect(res.body.fields.expectedAttendance).toBeDefined();
  });

  it("rejects an empty submission", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/events/7/change-requests").send({});
    expect(res.status).toBe(400);
  });

  it("rejects a no-op submission (same value as current)", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/events/7/change-requests")
      .send({ description: submittedDetails.description });
    expect(res.status).toBe(400);
  });

  it("applies a non-critical field immediately, recorded as Approved with no held fields", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/events/7/change-requests")
      .send({ description: "Updated gala description" });

    expect(res.status).toBe(201);
    expect(res.body.applied).toEqual(["description"]);
    expect(res.body.held).toEqual([]);
    expect(res.body.changeRequestId).toBe(55);
  });

  it("stamps a non-critical-only Approved request as automatic, so it reads as system-resolved rather than coordinator-decided", async () => {
    const app = buildApp();
    await request(app).post("/api/events/7/change-requests").send({ description: "Updated gala description" });

    expect((app as any).__spies.insertChangeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Approved",
        decision_reason: expect.stringContaining("Applied automatically"),
      }),
    );
  });

  it("holds a critical field instead of applying it", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/events/7/change-requests")
      .send({ expectedAttendance: 150 });

    expect(res.status).toBe(201);
    expect(res.body.applied).toEqual([]);
    expect(res.body.held).toEqual(["expectedAttendance"]);
    expect(res.body.changeRequestId).toBe(55);
  });

  it("splits a mixed submission into applied and held", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/events/7/change-requests")
      .send({ description: "Updated gala description", venue: "Seminar Room 3-01" });

    expect(res.status).toBe(201);
    expect(res.body.applied).toEqual(["description"]);
    expect(res.body.held).toEqual(["venue"]);
  });

  it("notifies the assigned coordinator", async () => {
    const app = buildApp();
    await request(app).post("/api/events/7/change-requests").send({ venue: "Seminar Room 3-01" });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "change.requested",
        recipients: { userIds: ["COORD-0001"], roles: [] },
      }),
    );
  });

  it("skips notifying when there's no assigned coordinator", async () => {
    const app = buildApp({ coordinatorId: null });
    await request(app).post("/api/events/7/change-requests").send({ venue: "Seminar Room 3-01" });

    expect(publish).not.toHaveBeenCalled();
  });

  it("500s when the submitted_details update fails", async () => {
    const app = buildApp({ updateError: true });
    const res = await request(app)
      .post("/api/events/7/change-requests")
      .send({ description: "Updated gala description" });
    expect(res.status).toBe(500);
  });

  it("500s when the change_requests insert fails", async () => {
    const app = buildApp({ insertRequestError: true });
    const res = await request(app).post("/api/events/7/change-requests").send({ venue: "Seminar Room 3-01" });
    expect(res.status).toBe(500);
  });

  it("500s when the change_request_fields upsert fails", async () => {
    const app = buildApp({ upsertError: true });
    const res = await request(app).post("/api/events/7/change-requests").send({ venue: "Seminar Room 3-01" });
    expect(res.status).toBe(500);
  });
});

describe("POST /api/events/:id/change-requests — merging into an open Pending request", () => {
  const heldVenue = { id: 1, field: "venue", old_value: "Grand Ballroom", new_value: "Seminar Room 3-01", is_critical: true };
  const heldAttendance = { id: 2, field: "expectedAttendance", old_value: "100", new_value: "150", is_critical: true };

  it("overwrites an already-held field's value, reusing the same request", async () => {
    const app = buildApp({ openRequest: { id: 55 }, openFields: [heldVenue] });
    const res = await request(app).post("/api/events/7/change-requests").send({ venue: "Auditorium B" });

    expect(res.status).toBe(201);
    expect(res.body.changeRequestId).toBe(55);
    expect(res.body.held).toEqual(["venue"]);
    expect(res.body.reverted).toEqual([]);
    expect(res.body.autoResolved).toBe(false);
  });

  it("resubmitting the exact same held value is a no-op (field stays held, no error)", async () => {
    const app = buildApp({ openRequest: { id: 55 }, openFields: [heldVenue, heldAttendance] });
    // Resubmits the already-held venue value plus a genuinely new field.
    const res = await request(app)
      .post("/api/events/7/change-requests")
      .send({ venue: "Seminar Room 3-01", accessibility: "Hearing loop available" });

    expect(res.status).toBe(201);
    expect(res.body.held).toEqual(["accessibility"]);
  });

  it("adds a new field to the open request without disturbing the one already held", async () => {
    const app = buildApp({ openRequest: { id: 55 }, openFields: [heldVenue] });
    const res = await request(app).post("/api/events/7/change-requests").send({ expectedAttendance: 150 });

    expect(res.status).toBe(201);
    expect(res.body.changeRequestId).toBe(55);
    expect(res.body.held).toEqual(["expectedAttendance"]);
  });

  it("reverting one held field while another stays held keeps the request Pending", async () => {
    const app = buildApp({ openRequest: { id: 55 }, openFields: [heldVenue, heldAttendance] });
    const res = await request(app).post("/api/events/7/change-requests").send({ venue: "Grand Ballroom" });

    expect(res.status).toBe(201);
    expect(res.body.reverted).toEqual(["venue"]);
    expect(res.body.held).toEqual([]);
    expect(res.body.autoResolved).toBe(false);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "change.requested" }));
  });

  it("reverting the only held field auto-resolves the request and notifies both sides", async () => {
    const app = buildApp({ openRequest: { id: 55 }, openFields: [heldVenue] });
    const res = await request(app).post("/api/events/7/change-requests").send({ venue: "Grand Ballroom" });

    expect(res.status).toBe(201);
    expect(res.body.reverted).toEqual(["venue"]);
    expect(res.body.autoResolved).toBe(true);
    // It's its own status, not "Approved" — nothing was actually approved.
    expect((app as any).__spies.updateChangeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Auto-Withdrawn", decided_by: null }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "change.withdrawn",
        recipients: { userIds: ["ORG-0001", "COORD-0001"], roles: [] },
      }),
    );
  });

  it("folds a non-critical edit into the same open request instead of a separate row", async () => {
    const app = buildApp({ openRequest: { id: 55 }, openFields: [heldVenue] });
    const res = await request(app)
      .post("/api/events/7/change-requests")
      .send({ description: "Updated gala description" });

    expect(res.status).toBe(201);
    expect(res.body.changeRequestId).toBe(55);
    expect(res.body.applied).toEqual(["description"]);
  });
});

describe("GET /api/events/:id/change-requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stubs the three services loadChangeRequestImpact calls out to. */
  function stubArrangementsFetch(options: {
    bookings?: { id: number; status: string; venue: { id: number; name: string; capacity: number } | null }[];
    equipmentRequests?: { id: number; status: string; items: unknown[] }[];
    registrations?: { registrationId: number; userId: string; status: string; name: string | null }[];
    availability?: {
      available: boolean;
      unavailabilityConflict?: { reason: string; description: string } | null;
      bookingConflict?: { bookingId: number; status: string; window: string } | null;
    };
    fail?: "bookings" | "equipment" | "registrations";
  }) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
        if (url.includes("/availability-check")) {
          return json({
            available: options.availability?.available ?? true,
            unavailabilityConflict: options.availability?.unavailabilityConflict ?? null,
            bookingConflict: options.availability?.bookingConflict ?? null,
          });
        }
        if (url.includes("/api/venues/events/")) {
          return json({ bookings: options.bookings ?? [] }, options.fail !== "bookings");
        }
        if (url.includes("/api/equipment-requests")) {
          return json({ equipmentRequests: options.equipmentRequests ?? [] }, options.fail !== "equipment");
        }
        if (url.includes("/api/registrations/event/")) {
          return json({ registrations: options.registrations ?? [] }, options.fail !== "registrations");
        }
        throw new Error(`unexpected fetch url ${url}`);
      }),
    );
  }

  const pendingRequestWithVenue = {
    storedRequests: [
      { id: 55, status: "Pending", decided_at: null, decision_reason: null, created_at: "2026-10-16T00:00:00Z" },
    ],
    storedFields: [
      { request_id: 55, field: "venue", old_value: "Grand Ballroom", new_value: "Seminar Room 3-01", is_critical: true },
      { request_id: 55, field: "description", old_value: "old", new_value: "new", is_critical: false },
    ],
  };

  it("blocks a non-owner, non-assigned-coordinator", async () => {
    const app = buildApp({ user: { id: "ORG-0002", role: "organiser" } });
    const res = await request(app).get("/api/events/7/change-requests");
    expect(res.status).toBe(403);
  });

  it("blocks a coordinator who isn't assigned to this event", async () => {
    const app = buildApp({ user: { id: "COORD-0002", role: "coordinator" } });
    const res = await request(app).get("/api/events/7/change-requests");
    expect(res.status).toBe(403);
  });

  it("allows the assigned coordinator", async () => {
    stubArrangementsFetch({});
    const app = buildApp({ user: coordinator, ...pendingRequestWithVenue });
    const res = await request(app).get("/api/events/7/change-requests");
    expect(res.status).toBe(200);
  });

  it("returns an empty list when nothing's been raised", async () => {
    const app = buildApp({ storedRequests: [], storedFields: [] });
    const res = await request(app).get("/api/events/7/change-requests");
    expect(res.status).toBe(200);
    expect(res.body.changeRequests).toEqual([]);
  });

  it("returns requests with their fields and impact attached", async () => {
    stubArrangementsFetch({
      bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 300 } }],
      equipmentRequests: [{ id: 50, status: "Arranged", items: [] }],
      registrations: [
        { registrationId: 1, userId: "ATT-1", status: "Registered", name: "Ash" },
        { registrationId: 2, userId: "ATT-2", status: "Withdrawn", name: "Bo" },
      ],
    });
    const app = buildApp(pendingRequestWithVenue);
    const res = await request(app).get("/api/events/7/change-requests");

    expect(res.status).toBe(200);
    expect(res.body.changeRequests).toEqual([
      {
        id: 55,
        status: "Pending",
        decidedAt: null,
        decisionReason: null,
        createdAt: "2026-10-16T00:00:00Z",
        fields: [
          { field: "venue", oldValue: "Grand Ballroom", newValue: "Seminar Room 3-01", isCritical: true, outcome: "pending" },
          { field: "description", oldValue: "old", newValue: "new", isCritical: false, outcome: "applied" },
        ],
        impact: {
          bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom" } }],
          equipmentReservations: [{ id: 50, status: "Arranged", items: [] }],
          registrations: {
            registeredCount: 1,
            total: 2,
            registrations: [
              { registrationId: 1, userId: "ATT-1", name: "Ash", status: "Registered" },
              { registrationId: 2, userId: "ATT-2", name: "Bo", status: "Withdrawn" },
            ],
          },
          capacityConflict: null,
          availabilityConflict: null,
        },
      },
    ]);
  });

  it("flags a capacity conflict when the requested attendance exceeds a booked venue's capacity", async () => {
    stubArrangementsFetch({
      bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 300 } }],
    });
    const app = buildApp({
      storedRequests: [
        { id: 55, status: "Pending", decided_at: null, decision_reason: null, created_at: "2026-10-16T00:00:00Z" },
      ],
      storedFields: [
        { request_id: 55, field: "expectedAttendance", old_value: "100", new_value: "350", is_critical: true },
      ],
    });
    const res = await request(app).get("/api/events/7/change-requests");

    expect(res.status).toBe(200);
    expect(res.body.changeRequests[0].impact.capacityConflict).toEqual({
      bookingId: 900,
      venueName: "Grand Ballroom",
      capacity: 300,
      requestedAttendance: 350,
    });
  });

  it("ignores a Withdrawn booking's venue when checking capacity — only an active booking holds the venue", async () => {
    // Regression: a withdrawn/rejected booking doesn't actually hold a
    // venue, so flagging a conflict against it names a venue the event
    // no longer has. Found live: an earlier withdrawn Boardroom A (cap.
    // 20) booking was reported as the conflict instead of the real,
    // currently Approved Seminar Room 3-01 (cap. 40) booking.
    stubArrangementsFetch({
      bookings: [
        { id: 93, status: "Withdrawn", venue: { id: 7, name: "Boardroom A", capacity: 20 } },
        { id: 94, status: "Approved", venue: { id: 4, name: "Seminar Room 3-01", capacity: 40 } },
      ],
    });
    const app = buildApp({
      storedRequests: [
        { id: 55, status: "Pending", decided_at: null, decision_reason: null, created_at: "2026-10-16T00:00:00Z" },
      ],
      storedFields: [
        { request_id: 55, field: "expectedAttendance", old_value: "15", new_value: "55", is_critical: true },
      ],
    });
    const res = await request(app).get("/api/events/7/change-requests");

    expect(res.status).toBe(200);
    expect(res.body.changeRequests[0].impact.capacityConflict).toEqual({
      bookingId: 94,
      venueName: "Seminar Room 3-01",
      capacity: 40,
      requestedAttendance: 55,
    });
  });

  it("checks availability when a schedule field is held, flagging an unavailability clash", async () => {
    stubArrangementsFetch({
      bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 300 } }],
      availability: {
        available: false,
        unavailabilityConflict: { reason: "maintenance", description: "on 2026-11-10 (all day)" },
      },
    });
    const app = buildApp({
      storedRequests: [
        { id: 55, status: "Pending", decided_at: null, decision_reason: null, created_at: "2026-10-16T00:00:00Z" },
      ],
      storedFields: [
        { request_id: 55, field: "startTime", old_value: "18:00", new_value: "19:00", is_critical: true },
      ],
    });
    const res = await request(app).get("/api/events/7/change-requests");

    expect(res.status).toBe(200);
    expect(res.body.changeRequests[0].impact.availabilityConflict).toEqual({
      bookingId: 900,
      unavailabilityConflict: { reason: "maintenance", description: "on 2026-11-10 (all day)" },
      bookingConflict: null,
    });
  });

  it("flags a rival-booking clash the same way", async () => {
    stubArrangementsFetch({
      bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 300 } }],
      availability: {
        available: false,
        bookingConflict: { bookingId: 901, status: "Approved", window: "2026-11-10 09:30–12:45" },
      },
    });
    const app = buildApp({
      storedRequests: [
        { id: 55, status: "Pending", decided_at: null, decision_reason: null, created_at: "2026-10-16T00:00:00Z" },
      ],
      storedFields: [
        { request_id: 55, field: "endTime", old_value: "21:00", new_value: "22:00", is_critical: true },
      ],
    });
    const res = await request(app).get("/api/events/7/change-requests");

    expect(res.body.changeRequests[0].impact.availabilityConflict).toEqual({
      bookingId: 900,
      unavailabilityConflict: null,
      bookingConflict: { bookingId: 901, status: "Approved", window: "2026-11-10 09:30–12:45" },
    });
  });

  it("doesn't check availability when no schedule field is held", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/availability-check")) throw new Error("should not have been called");
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes("/api/venues/events/")) {
        return json({ bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 300 } }] });
      }
      if (url.includes("/api/equipment-requests")) return json({ equipmentRequests: [] });
      if (url.includes("/api/registrations/event/")) return json({ registrations: [] });
      throw new Error(`unexpected fetch url ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const app = buildApp(pendingRequestWithVenue);
    const res = await request(app).get("/api/events/7/change-requests");

    expect(res.status).toBe(200);
    expect(res.body.changeRequests[0].impact.availabilityConflict).toBeNull();
  });

  it("doesn't compute impact for an Approved or Rejected request", async () => {
    stubArrangementsFetch({});
    const app = buildApp({
      storedRequests: [
        { id: 56, status: "Approved", decided_at: "2026-10-16T01:00:00Z", decision_reason: null, created_at: "2026-10-16T00:00:00Z" },
      ],
      storedFields: [
        { request_id: 56, field: "description", old_value: "old", new_value: "new", is_critical: false },
      ],
    });
    const res = await request(app).get("/api/events/7/change-requests");

    expect(res.status).toBe(200);
    expect(res.body.changeRequests[0].impact).toBeNull();
  });

  it("degrades to impact null, without 500ing, when a downstream fetch fails", async () => {
    stubArrangementsFetch({ fail: "registrations" });
    const app = buildApp(pendingRequestWithVenue);
    const res = await request(app).get("/api/events/7/change-requests");

    expect(res.status).toBe(200);
    expect(res.body.changeRequests[0].impact).toBeNull();
  });

  it("500s when the change_requests list fails", async () => {
    const app = buildApp({ listRequestsError: true });
    const res = await request(app).get("/api/events/7/change-requests");
    expect(res.status).toBe(500);
  });

  it("500s when the change_request_fields list fails", async () => {
    const app = buildApp({ storedRequests: [], listFieldsError: true });
    const res = await request(app).get("/api/events/7/change-requests");
    expect(res.status).toBe(500);
  });
});
