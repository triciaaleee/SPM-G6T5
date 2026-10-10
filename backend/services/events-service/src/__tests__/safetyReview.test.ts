import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { findOutstandingArrangements, parseSafetyNotes } from "../lib/safetyReview.js";
import type { ArrangementBooking, ArrangementEquipmentRequest } from "../lib/arrangementsClient.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser;
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const coordinator = { id: "COORD-0001", role: "coordinator" };

const notes = {
  equipmentPlacement: "Projector at the back, cables taped down",
  crowdMovement: "Single entrance, one-way flow to the exits",
  emergencyAccess: "Fire lane on the east side kept clear",
  venueRestrictions: "None known",
};

function booking(id: number, status: string, name = `Venue ${id}`): ArrangementBooking {
  return { id, status, venue: { id, name } };
}

function equipmentRequest(id: number, items: [string, number, number][]): ArrangementEquipmentRequest {
  return {
    id,
    status: "Requested",
    items: items.map(([equipmentType, quantity, quantityFulfilled], index) => ({
      id: id * 10 + index,
      equipmentType,
      quantity,
      quantityFulfilled,
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildApp(
  options: {
    user?: { id: string; role: string };
    event?: { id: number; status: string; coordinator_id: string | null } | null;
    bookings?: ArrangementBooking[];
    equipmentRequests?: ArrangementEquipmentRequest[];
    venueServiceFails?: boolean;
    submissionId?: number | null;
  } = {},
) {
  const event = options.event === undefined ? { id: 7, status: "Planning", coordinator_id: coordinator.id } : options.event;

  // authorizeCoordinatorReview: .select("id, status, coordinator_id").eq().maybeSingle()
  // the reload afterwards:      .select(EVENT_COLUMNS).eq().single()
  const reloaded = { ...event, status: "Safety Review" };
  const eventsSelect = vi.fn().mockImplementation(() => ({
    eq: () => ({
      maybeSingle: vi.fn().mockResolvedValue({ data: event, error: null }),
      single: vi.fn().mockResolvedValue({ data: reloaded, error: null }),
    }),
  }));
  const denialInsert = vi.fn().mockResolvedValue({ error: null });
  const rpc = vi.fn().mockResolvedValue({
    data: options.submissionId === undefined ? 501 : options.submissionId,
    error: null,
  });

  (globalThis as any).__mockSupabase = {
    from: vi.fn((table: string) => (table === "access_denials" ? { insert: denialInsert } : { select: eventsSelect })),
    rpc,
  };
  (globalThis as any).__mockUser = options.user ?? coordinator;

  const fetchMock = vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("/api/venues/events/")) {
      if (options.venueServiceFails) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ bookings: options.bookings ?? [booking(1, "Approved")] }) };
    }
    if (url.includes("/api/equipment-requests")) {
      return { ok: true, status: 200, json: async () => ({ equipmentRequests: options.equipmentRequests ?? [] }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return { app, rpc, fetchMock };
}

function submit(app: express.Express, body: unknown = { safetyNotes: notes }) {
  return request(app).post("/api/events/7/submit-safety-review").set("Authorization", "Bearer t").send(body as object);
}

describe("POST /api/events/:id/submit-safety-review (E3-4)", () => {
  it("AC1: moves a ready event to Safety Review and records the safety notes", async () => {
    const { app, rpc, fetchMock } = buildApp({
      bookings: [booking(1, "Approved"), booking(2, "Rejected"), booking(3, "Withdrawn"), booking(4, "Expired")],
      equipmentRequests: [equipmentRequest(9, [["Projector", 2, 2]])],
    });
    const res = await submit(app);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Safety Review");
    expect(res.body.submissionId).toBe(501);
    expect(rpc).toHaveBeenCalledWith("submit_event_for_safety_review", {
      p_event_id: 7,
      p_submitted_by: coordinator.id,
      p_equipment_placement: notes.equipmentPlacement,
      p_crowd_movement: notes.crowdMovement,
      p_emergency_access: notes.emergencyAccess,
      p_venue_restrictions: notes.venueRestrictions,
    });
    // The caller's token is forwarded so each service applies its own access check.
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/venues\/events\/7\/bookings$/), {
      headers: { Authorization: "Bearer t" },
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/equipment-requests\?eventId=7$/), {
      headers: { Authorization: "Bearer t" },
    });
  });

  it("AC2: blocks an event with no approved venue booking", async () => {
    const { app, rpc } = buildApp({ bookings: [booking(2, "Rejected", "Seminar Room")] });
    const res = await submit(app);

    expect(res.status).toBe(409);
    expect(res.body.outstanding.noApprovedVenue).toBe(true);
    expect(res.body.error).toContain("no approved venue booking");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("AC2: blocks while any booking is Requested, On Hold or Replacement Required, naming each", async () => {
    const { app, rpc } = buildApp({
      bookings: [
        booking(1, "Approved", "Grand Ballroom"),
        booking(2, "Requested", "Seminar Room"),
        booking(3, "On Hold", "Innovation Hub"),
        booking(4, "Replacement Required", "Rooftop Terrace"),
      ],
    });
    const res = await submit(app);

    expect(res.status).toBe(409);
    expect(res.body.outstanding.bookings.map((b: { venueName: string }) => b.venueName)).toEqual([
      "Seminar Room",
      "Innovation Hub",
      "Rooftop Terrace",
    ]);
    expect(res.body.error).toContain("Seminar Room is still Requested");
    expect(res.body.error).toContain("Innovation Hub is still On Hold");
    expect(res.body.error).toContain("Rooftop Terrace is still Replacement Required");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("AC3: blocks while requested equipment isn't fully reserved, listing the items", async () => {
    const { app, rpc } = buildApp({
      equipmentRequests: [equipmentRequest(9, [["Projector", 2, 1], ["Microphone", 4, 4], ["Speaker", 2, 0]])],
    });
    const res = await submit(app);

    expect(res.status).toBe(409);
    expect(res.body.outstanding.equipment).toEqual([
      { requestId: 9, equipmentType: "Projector", quantity: 2, quantityReserved: 1 },
      { requestId: 9, equipmentType: "Speaker", quantity: 2, quantityReserved: 0 },
    ]);
    expect(res.body.error).toContain("Projector: 1 of 2 reserved");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("AC4: allows an event that requested no equipment", async () => {
    const { app } = buildApp({ equipmentRequests: [] });
    expect((await submit(app)).status).toBe(200);
  });

  it("AC5: requires every safety note, reporting each missing one", async () => {
    const { app, rpc, fetchMock } = buildApp();
    const res = await submit(app, { safetyNotes: { ...notes, crowdMovement: "  ", venueRestrictions: "" } });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(["crowdMovement", "venueRestrictions"]);
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["Requested", "Clarification Requested", "Safety Review", "Confirmed", "Completed", "Cancelled"])(
    "AC6: blocks an event in %s",
    async (status) => {
      const { app, rpc } = buildApp({ event: { id: 7, status, coordinator_id: coordinator.id } });
      const res = await submit(app);

      expect(res.status).toBe(409);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("AC7: blocks a coordinator who isn't assigned to the event", async () => {
    const { app, rpc } = buildApp({ event: { id: 7, status: "Planning", coordinator_id: "COORD-0002" } });
    const res = await submit(app);

    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("AC7: blocks any role other than coordinator", async () => {
    const { app } = buildApp({ user: { id: "ORG-0001", role: "organiser" } });
    expect((await submit(app)).status).toBe(403);
  });

  it("AC8: a resubmission after the event returns to Planning goes through like the first", async () => {
    // Rejected or sent back for changes, the event is in Planning again.
    const { app, rpc } = buildApp({ submissionId: 502 });
    const res = await submit(app);

    expect(res.status).toBe(200);
    expect(res.body.submissionId).toBe(502);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the event left Planning or was reassigned between the checks and the write", async () => {
    const { app } = buildApp({ submissionId: null });
    expect((await submit(app)).status).toBe(409);
  });

  it("returns 502 when the arrangements can't be checked, rather than guessing", async () => {
    const { app, rpc } = buildApp({ venueServiceFails: true });
    const res = await submit(app);

    expect(res.status).toBe(502);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown event", async () => {
    const { app } = buildApp({ event: null });
    expect((await submit(app)).status).toBe(404);
  });
});

describe("findOutstandingArrangements", () => {
  it("counts an event with only settled-but-not-approved bookings as having no venue", () => {
    const outstanding = findOutstandingArrangements([booking(1, "Withdrawn"), booking(2, "Expired")], []);
    expect(outstanding).toEqual({ noApprovedVenue: true, bookings: [], equipment: [] });
  });

  it("checks items across every equipment request", () => {
    const outstanding = findOutstandingArrangements(
      [booking(1, "Approved")],
      [equipmentRequest(1, [["Projector", 1, 1]]), equipmentRequest(2, [["Stage lights", 6, 3]])],
    );
    expect(outstanding.equipment).toEqual([{ requestId: 2, equipmentType: "Stage lights", quantity: 6, quantityReserved: 3 }]);
  });
});

describe("parseSafetyNotes", () => {
  it("trims each note", () => {
    const result = parseSafetyNotes({ safetyNotes: { ...notes, emergencyAccess: "  Clear  " } });
    expect(result.valid && result.notes.emergencyAccess).toBe("Clear");
  });

  it("reports every note missing when none are sent", () => {
    const result = parseSafetyNotes({});
    expect(result.valid).toBe(false);
    expect(!result.valid && Object.keys(result.fields)).toHaveLength(4);
  });

  it("rejects an overly long note", () => {
    const result = parseSafetyNotes({ safetyNotes: { ...notes, crowdMovement: "x".repeat(2001) } });
    expect(!result.valid && result.fields.crowdMovement).toContain("2000");
  });
});
