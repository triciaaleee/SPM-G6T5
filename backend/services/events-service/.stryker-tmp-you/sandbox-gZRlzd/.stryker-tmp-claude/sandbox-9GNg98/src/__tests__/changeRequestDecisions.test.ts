// @ts-nocheck
// 
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

/** E3-11 (#36): the coordinator approves or rejects a held change request. */

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

const coordinator = { id: "COORD-0001", role: "coordinator" };
const organiser = { id: "ORG-0001", role: "organiser" };

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

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Options {
  user?: { id: string; role: string };
  coordinatorId?: string | null;
  changeRequest?: { id: number; status: string } | null;
  changeRequestError?: boolean;
  fields?: { field: string; old_value: string | null; new_value: string; is_critical: boolean }[];
  fieldsError?: boolean;
  fieldsApplyError?: boolean;
  eventUpdateError?: boolean;
  decideError?: boolean;
  historyError?: boolean;
  /** Impact-check fetches: venue/equipment/registration/availability responses. */
  bookings?: { id: number; status: string; venue: { id: number; name: string; capacity: number } | null }[];
  availability?: { available: boolean; unavailabilityConflict?: unknown; bookingConflict?: unknown };
  flagBookingOk?: boolean;
  flagEquipmentOk?: boolean;
  flaggedRequestIds?: number[];
  /** The event row comes back from the update without the approved values (the write did not take). */
  storeIgnoresUpdate?: boolean;
  /** The event's status when the decision is made; left out, the fixture has none. */
  eventStatus?: string;
  /** Other Pending requests left on the event after a rejection (Needs Review only). */
  pendingRemaining?: number;
  /** Whether the Needs Review -> Confirmed update matches a row (approval not stale). */
  revertMatches?: boolean;
}

function buildApp(options: Options = {}) {
  const event = {
    id: 163,
    status: options.eventStatus,
    coordinator_id: options.coordinatorId === undefined ? "COORD-0001" : options.coordinatorId,
    submitted_details: submittedDetails,
    // Reject's handler re-selects the event with organiser_id afterwards;
    // same row, so the one fixture carries both shapes.
    organiser_id: "ORG-0001",
    organiser: { name: "Pat Organiser" },
  };
  const reloadedEvent = {
    id: 163,
    status: "Planning",
    organiser_id: "ORG-0001",
    organiser: { name: "Pat Organiser" },
    submitted_details: submittedDetails,
  };

  const resolved = (data: unknown, error: unknown = null) => vi.fn().mockResolvedValue({ data, error });

  const eventsSelectChain: any = {};
  eventsSelectChain.eq = () => eventsSelectChain;
  eventsSelectChain.maybeSingle = resolved(event);

  const eventsUpdateChain: any = {};
  eventsUpdateChain.eq = () => eventsUpdateChain;
  eventsUpdateChain.select = () => eventsUpdateChain;
  // Only the Needs Review -> Confirmed update awaits the chain directly.
  eventsUpdateChain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: options.revertMatches === false ? [] : [{ id: 163 }], error: null }).then(resolve);
  // Returns the row as the update left it, so the route's read-back check sees what was written.
  let lastPatch: Record<string, unknown> = {};
  eventsUpdateChain.single = vi.fn(async () => ({
    data: options.eventUpdateError
      ? null
      : {
          ...reloadedEvent,
          submitted_details: options.storeIgnoresUpdate ? submittedDetails : (lastPatch.submitted_details ?? submittedDetails),
        },
    error: options.eventUpdateError ? { message: "boom" } : null,
  }));

  const changeRequestSelectChain: any = {};
  changeRequestSelectChain.eq = () => changeRequestSelectChain;
  // The Needs Review check counts the event's other Pending requests.
  changeRequestSelectChain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ count: options.pendingRemaining ?? 0, error: null }).then(resolve);
  changeRequestSelectChain.maybeSingle = resolved(
    options.changeRequestError ? null : options.changeRequest === undefined ? { id: 5, status: "Pending" } : options.changeRequest,
    options.changeRequestError ? { message: "boom" } : null,
  );

  // Backs both approve's `.update(...).eq(...)` (awaited directly, no
  // .select()) and reject's `.update(...).eq(...).select(...).single()` —
  // one chainable+awaitable object answers both, since .eq() and .select()
  // just return itself and only .single()/bare-await are terminal.
  const changeRequestUpdateChain: any = {};
  changeRequestUpdateChain.eq = () => changeRequestUpdateChain;
  changeRequestUpdateChain.select = () => changeRequestUpdateChain;
  changeRequestUpdateChain.single = resolved(
    options.decideError ? null : { id: 5, status: "Rejected", decided_at: "2026-10-19T00:00:00Z", decision_reason: "Not needed" },
    options.decideError ? { message: "boom" } : null,
  );
  changeRequestUpdateChain.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: null, error: options.decideError ? { message: "boom" } : null }).then(resolve);

  // Backs loadPendingChangeRequest's .select(...).eq(...).is("applied_at", null).
  const fieldsSelectChain: any = {};
  fieldsSelectChain.eq = () => fieldsSelectChain;
  fieldsSelectChain.is = resolved(
    options.fieldsError ? null : options.fields ?? [{ field: "expectedAttendance", old_value: "100", new_value: "150", is_critical: true }],
    options.fieldsError ? { message: "boom" } : null,
  );

  // Backs the approve route's stamping of the now-resolved field rows:
  // .update({applied_at}).eq(...).in(...) — .in() is the awaited terminal call.
  const fieldsUpdateChain: any = {};
  fieldsUpdateChain.eq = () => fieldsUpdateChain;
  fieldsUpdateChain.in = resolved(null, options.fieldsApplyError ? { message: "boom" } : null);

  const eventsUpdateSpy = vi.fn((patch: Record<string, unknown>) => {
    lastPatch = patch;
    return eventsUpdateChain;
  });
  const changeRequestUpdateSpy = vi.fn(() => changeRequestUpdateChain);

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "events") return { select: () => eventsSelectChain, update: eventsUpdateSpy };
      if (table === "change_requests") {
        return { select: () => changeRequestSelectChain, update: changeRequestUpdateSpy };
      }
      if (table === "change_request_fields") return { select: () => fieldsSelectChain, update: () => fieldsUpdateChain };
      if (table === "event_history") return { insert: resolved(null, options.historyError ? { message: "boom" } : null) };
      // The outbox stores a message before publishing it; echo the stored row back.
      if (table === "event_outbox") {
        return {
          insert: (payload: Record<string, unknown>) => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: 1, message_id: "00000000-0000-0000-0000-000000000001", occurred_at: "2099-01-01T00:00:00Z", ...payload },
                  error: null,
                }),
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
    if (url.includes("/flag-for-rebooking")) {
      return json({ staffNotified: true }, options.flagBookingOk !== false);
    }
    if (url.includes("/flag-for-event/")) {
      return json({ flaggedRequestIds: options.flaggedRequestIds ?? [1], notified: true }, options.flagEquipmentOk !== false);
    }
    if (url.includes("/availability-check")) {
      return json(options.availability ?? { available: true, unavailabilityConflict: null, bookingConflict: null });
    }
    if (url.includes("/api/venues/events/")) {
      return json({ bookings: options.bookings ?? [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 120 } }] });
    }
    if (url.includes("/api/equipment-requests")) return json({ equipmentRequests: [] });
    if (url.includes("/api/registrations/event/")) return json({ registrations: [] });
    throw new Error(`unexpected fetch url ${url} ${init?.method}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? coordinator;

  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return { app, fetchMock, eventsUpdateSpy, changeRequestUpdateSpy, fieldsUpdateChain };
}

describe("POST /api/events/:id/change-requests/:requestId/approve", () => {
  it("blocks a non-assigned coordinator", async () => {
    const { app } = buildApp({ coordinatorId: "COORD-0002" });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");
    expect(res.status).toBe(403);
  });

  it("blocks the organiser", async () => {
    const { app } = buildApp({ user: organiser });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");
    expect(res.status).toBe(403);
  });

  it("404s an unknown change request", async () => {
    const { app } = buildApp({ changeRequest: null });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");
    expect(res.status).toBe(404);
  });

  it("409s a request that's already been decided", async () => {
    const { app } = buildApp({ changeRequest: { id: 5, status: "Approved" } });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");
    expect(res.status).toBe(409);
  });

  it("applies the held field, moves the event to Planning, and records the decision", async () => {
    const { app } = buildApp({ bookings: [] });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Planning");
    expect(res.body.bookingsFlagged).toEqual([]);
    expect(res.body.equipmentFlagged).toBe(false);
  });

  it("flags the booking when the approval creates a real capacity conflict", async () => {
    const { app, fetchMock } = buildApp({
      fields: [{ field: "expectedAttendance", old_value: "100", new_value: "150", is_critical: true }],
      bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 120 } }],
    });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(200);
    expect(res.body.bookingsFlagged).toEqual([{ bookingId: 900, staffNotified: true }]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/venues/bookings/900/flag-for-rebooking"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("doesn't flag the booking when the approval doesn't actually conflict", async () => {
    const { app } = buildApp({
      fields: [{ field: "expectedAttendance", old_value: "100", new_value: "110", is_critical: true }],
      bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 120 } }],
    });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(200);
    expect(res.body.bookingsFlagged).toEqual([]);
  });

  it("flags equipment for reassessment when the equipment field was held", async () => {
    const { app, fetchMock } = buildApp({
      fields: [{ field: "equipment", old_value: "Stage", new_value: "Stage and extra lighting", is_critical: true }],
      bookings: [],
    });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(200);
    expect(res.body.equipmentFlagged).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/equipment-requests/flag-for-event/163"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("doesn't flag equipment when the equipment field wasn't held", async () => {
    const { app } = buildApp({
      fields: [{ field: "venue", old_value: "Grand Ballroom", new_value: "Seminar Room", is_critical: true }],
      bookings: [],
    });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(200);
    expect(res.body.equipmentFlagged).toBe(false);
  });

  it("notifies the organiser", async () => {
    const { app } = buildApp({ bookings: [] });
    await request(app).post("/api/events/163/change-requests/5/approve");

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "change.decided", data: expect.objectContaining({ outcome: "approved" }) }),
    );
  });

  it("500s when applying the change fails", async () => {
    const { app } = buildApp({ eventUpdateError: true });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");
    expect(res.status).toBe(500);
  });

  it("500s when recording the decision fails", async () => {
    const { app } = buildApp({ decideError: true });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");
    expect(res.status).toBe(500);
  });

  it("still succeeds even if flagging the booking itself fails (AC5: no separate re-approval needed)", async () => {
    const { app } = buildApp({
      fields: [{ field: "expectedAttendance", old_value: "100", new_value: "150", is_critical: true }],
      bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 120 } }],
      flagBookingOk: false,
    });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(200);
    expect(res.body.bookingsFlagged).toEqual([]);
  });

  describe("partial approval (approving some held fields now, leaving the rest held for later)", () => {
    const twoHeldFields = [
      { field: "expectedAttendance", old_value: "100", new_value: "110", is_critical: true },
      { field: "startTime", old_value: "18:00", new_value: "19:00", is_critical: true },
    ];

    it("defaults to approving every held field when no `fields` is given (unchanged behavior)", async () => {
      const { app, eventsUpdateSpy, changeRequestUpdateSpy } = buildApp({ fields: twoHeldFields, bookings: [] });
      const res = await request(app).post("/api/events/163/change-requests/5/approve");

      expect(res.status).toBe(200);
      expect(res.body.approvedFields).toEqual(["expectedAttendance", "startTime"]);
      expect(res.body.remainingFields).toEqual([]);
      expect(eventsUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          submitted_details: expect.objectContaining({ expectedAttendance: 110, startTime: "19:00" }),
        }),
      );
      // Nothing left held — the request closes out as Approved.
      expect(changeRequestUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "Approved" }));
    });

    it("tells equipment-service the event was rescheduled when an approved field is a date or time", async () => {
      const { app } = buildApp({ fields: twoHeldFields, bookings: [] });
      await request(app).post("/api/events/163/change-requests/5/approve").send({ fields: ["startTime"] });

      const rescheduled = publish.mock.calls.map((c) => c[0]).filter((m) => m.type === "event.rescheduled");
      expect(rescheduled).toEqual([
        expect.objectContaining({
          eventId: 163,
          recipients: { userIds: [], roles: [] },
          data: expect.objectContaining({ startTime: "19:00" }),
        }),
      ]);
    });

    it("tells venue-service the attendance changed when an approved field is the expected attendance", async () => {
      const { app } = buildApp({ fields: twoHeldFields, bookings: [] });
      await request(app).post("/api/events/163/change-requests/5/approve").send({ fields: ["expectedAttendance"] });

      const messages = publish.mock.calls.map((c) => c[0]).filter((m) => m.type === "event.attendance_changed");
      expect(messages).toEqual([
        expect.objectContaining({ eventId: 163, recipients: { userIds: [], roles: [] }, data: expect.objectContaining({ expectedAttendance: 110 }) }),
      ]);
    });

    it("does not announce an attendance change when only a time was approved", async () => {
      const { app } = buildApp({ fields: twoHeldFields, bookings: [] });
      await request(app).post("/api/events/163/change-requests/5/approve").send({ fields: ["startTime"] });

      expect(publish.mock.calls.map((c) => c[0].type)).not.toContain("event.attendance_changed");
    });

    it("does not announce a reschedule when the approved field is not a date or time", async () => {
      const { app } = buildApp({ fields: twoHeldFields, bookings: [] });
      await request(app).post("/api/events/163/change-requests/5/approve").send({ fields: ["expectedAttendance"] });

      expect(publish.mock.calls.map((c) => c[0].type)).not.toContain("event.rescheduled");
    });

    it("approves only the named fields and leaves the rest held, not rejected", async () => {
      const { app, eventsUpdateSpy, changeRequestUpdateSpy, fieldsUpdateChain } = buildApp({
        fields: twoHeldFields,
        bookings: [],
      });
      const res = await request(app)
        .post("/api/events/163/change-requests/5/approve")
        .send({ fields: ["expectedAttendance"] });

      expect(res.status).toBe(200);
      expect(res.body.approvedFields).toEqual(["expectedAttendance"]);
      expect(res.body.remainingFields).toEqual(["startTime"]);
      // Only the approved field's value is written — startTime stays at its
      // committed value (18:00), not the still-held requested one (19:00).
      expect(eventsUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          submitted_details: expect.objectContaining({ expectedAttendance: 110, startTime: "18:00" }),
        }),
      );
      // startTime is still held (not decided either way) — the request
      // itself is never touched while anything remains.
      expect(changeRequestUpdateSpy).not.toHaveBeenCalled();
      // Only the approved field's row is cleared off the request.
      expect(fieldsUpdateChain.in).toHaveBeenCalledWith("field", ["expectedAttendance"]);
    });

    it("rejects an unknown field name", async () => {
      const { app } = buildApp({ fields: twoHeldFields });
      const res = await request(app)
        .post("/api/events/163/change-requests/5/approve")
        .send({ fields: ["venue"], reason: "n/a" });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("venue");
    });

    it("rejects an empty `fields` list — must approve at least one field", async () => {
      const { app } = buildApp({ fields: twoHeldFields });
      const res = await request(app).post("/api/events/163/change-requests/5/approve").send({ fields: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least one/i);
    });

    it("only flags a booking/equipment impact for an approved field, not one still held", async () => {
      const { app, fetchMock } = buildApp({
        fields: twoHeldFields,
        bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom", capacity: 105 } }],
      });
      const res = await request(app)
        .post("/api/events/163/change-requests/5/approve")
        .send({ fields: ["startTime"] });

      expect(res.status).toBe(200);
      // expectedAttendance (the field that would have conflicted) is still
      // held, not approved, so no flag call should fire for it.
      expect(res.body.bookingsFlagged).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/flag-for-rebooking"),
        expect.anything(),
      );
    });

    it("notifies with the partially_approved outcome and both field lists", async () => {
      const { app } = buildApp({ fields: twoHeldFields, bookings: [] });
      await request(app)
        .post("/api/events/163/change-requests/5/approve")
        .send({ fields: ["expectedAttendance"] });

      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "change.decided",
          data: expect.objectContaining({
            outcome: "partially_approved",
            approvedFields: ["expectedAttendance"],
            remainingFields: ["startTime"],
          }),
        }),
      );
    });

    it("a later approve call on the still-open request resolves the remaining field", async () => {
      // Second call only sees the field still held (the earlier one was
      // deleted from change_request_fields already).
      const { app, changeRequestUpdateSpy } = buildApp({
        fields: [{ field: "startTime", old_value: "18:00", new_value: "19:00", is_critical: true }],
        bookings: [],
      });
      const res = await request(app).post("/api/events/163/change-requests/5/approve").send({ fields: ["startTime"] });

      expect(res.status).toBe(200);
      expect(res.body.approvedFields).toEqual(["startTime"]);
      expect(res.body.remainingFields).toEqual([]);
      expect(changeRequestUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: "Approved" }));
    });
  });
});

describe("a field is only applied once the change is confirmed", () => {
  it("rolls the event back and stamps nothing when the stored event doesn't hold the approved value", async () => {
    const { app, eventsUpdateSpy, changeRequestUpdateSpy } = buildApp({ eventStatus: "Confirmed", storeIgnoresUpdate: true });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/expectedAttendance/);
    // second call is the rollback to the pre-approval details and status
    expect(eventsUpdateSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ submitted_details: submittedDetails, status: "Confirmed", safety_approval_stale: false }),
    );
    // never reached the point of marking the request Approved
    expect(changeRequestUpdateSpy).not.toHaveBeenCalled();
  });

  it("rolls the event back when the field can't be stamped applied", async () => {
    const { app, eventsUpdateSpy } = buildApp({ eventStatus: "Confirmed", fieldsApplyError: true });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(500);
    expect(eventsUpdateSpy).toHaveBeenLastCalledWith(expect.objectContaining({ submitted_details: submittedDetails, status: "Confirmed" }));
  });

  it("rolls the event back when the request can't be closed out", async () => {
    const { app, eventsUpdateSpy } = buildApp({ eventStatus: "Confirmed", decideError: true });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(500);
    expect(eventsUpdateSpy).toHaveBeenLastCalledWith(expect.objectContaining({ submitted_details: submittedDetails, status: "Confirmed" }));
  });

  it("doesn't roll back a successful approval", async () => {
    const { app, eventsUpdateSpy } = buildApp({ eventStatus: "Confirmed" });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(200);
    expect(eventsUpdateSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Needs Review (AGENTS.md section 3)", () => {
  it.each([
    ["Confirmed", "Needs Review"],
    ["Needs Review", "Needs Review"],
    ["Safety Review", "Planning"],
    ["Planning", "Planning"],
  ])("approving a held change on a %s event leaves it %s and marks the safety approval stale", async (from, to) => {
    const { app, eventsUpdateSpy } = buildApp({ eventStatus: from });
    const res = await request(app).post("/api/events/163/change-requests/5/approve");

    expect(res.status).toBe(200);
    expect(eventsUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ status: to, safety_approval_stale: true }));
  });

  it("rejecting the last open request returns an unchanged Needs Review event straight to Confirmed", async () => {
    const { app, eventsUpdateSpy } = buildApp({ eventStatus: "Needs Review" });
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({ reason: "Not feasible" });

    expect(res.status).toBe(200);
    expect(res.body.returnedToConfirmed).toBe(true);
    expect(eventsUpdateSpy).toHaveBeenCalledWith({ status: "Confirmed" });
  });

  it("keeps the event in Needs Review when its safety approval is already stale (an arrangement was lost)", async () => {
    const { app } = buildApp({ eventStatus: "Needs Review", revertMatches: false });
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({ reason: "Not feasible" });

    expect(res.status).toBe(200);
    expect(res.body.returnedToConfirmed).toBe(false);
  });

  it("keeps the event in Needs Review while another request is still open", async () => {
    const { app, eventsUpdateSpy } = buildApp({ eventStatus: "Needs Review", pendingRemaining: 1 });
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({ reason: "Not feasible" });

    expect(res.body.returnedToConfirmed).toBe(false);
    expect(eventsUpdateSpy).not.toHaveBeenCalled();
  });

  it("does not touch the status when rejecting on a Confirmed event", async () => {
    const { app, eventsUpdateSpy } = buildApp({ eventStatus: "Confirmed" });
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({ reason: "Not feasible" });

    expect(res.body.returnedToConfirmed).toBe(false);
    expect(eventsUpdateSpy).not.toHaveBeenCalled();
  });
});

describe("POST /api/events/:id/change-requests/:requestId/reject", () => {
  it("requires a reason", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({});
    expect(res.status).toBe(400);
  });

  it("blocks a non-assigned coordinator", async () => {
    const { app } = buildApp({ coordinatorId: "COORD-0002" });
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({ reason: "Not feasible" });
    expect(res.status).toBe(403);
  });

  it("404s an unknown change request", async () => {
    const { app } = buildApp({ changeRequest: null });
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({ reason: "Not feasible" });
    expect(res.status).toBe(404);
  });

  it("409s a request that's already been decided", async () => {
    const { app } = buildApp({ changeRequest: { id: 5, status: "Rejected" } });
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({ reason: "Not feasible" });
    expect(res.status).toBe(409);
  });

  it("rejects with a reason and notifies the organiser, applying nothing", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({ reason: "Not feasible" });

    expect(res.status).toBe(200);
    expect(res.body.changeRequest.status).toBe("Rejected");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "change.decided",
        data: expect.objectContaining({ outcome: "rejected", reason: "Not feasible" }),
      }),
    );
  });

  it("500s when recording the decision fails", async () => {
    const { app } = buildApp({ decideError: true });
    const res = await request(app).post("/api/events/163/change-requests/5/reject").send({ reason: "Not feasible" });
    expect(res.status).toBe(500);
  });
});
