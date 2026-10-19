import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { registrationsRouter } from "../routes/registrations.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser;
      req.supabase = (globalThis as any).__mockSupabase;
      req.headers.authorization = "Bearer test-token";
      next();
    },
  };
});

const clients = vi.hoisted(() => ({
  fetchAttendeeEvents: vi.fn(),
  fetchOpenEvents: vi.fn(),
  canViewEvent: vi.fn(),
  fetchVenueNames: vi.fn(),
  fetchUserNames: vi.fn(),
}));

vi.mock("../lib/eventsClient.js", () => ({
  fetchAttendeeEvents: clients.fetchAttendeeEvents,
  fetchOpenEvents: clients.fetchOpenEvents,
  canViewEvent: clients.canViewEvent,
}));
vi.mock("../lib/venuesClient.js", () => ({ fetchVenueNames: clients.fetchVenueNames }));
vi.mock("../lib/usersClient.js", () => ({ fetchUserNames: clients.fetchUserNames }));

const attendee = { id: "ATT-0001", role: "attendee" };
const organiser = { id: "ORG-0001", role: "organiser" };
const coordinator = { id: "COORD-0001", role: "coordinator" };

function eventInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "Freshman Orientation Fair",
    description: "Booths and tours",
    proposedDate: "2099-01-01",
    startTime: "09:00",
    endTime: "15:00",
    accessibility: "Step-free entry",
    organiserName: "Pat Organiser",
    registrationNeeded: true,
    open: true,
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    registration_id: 10,
    event_id: 1,
    user_id: "ATT-0001",
    status: "Registered",
    created_at: "2026-01-01T00:00:00Z",
    additional_info: null,
    ...overrides,
  };
}

/**
 * A supabase-js style query: every filter returns the query; awaiting it
 * yields `result`; maybeSingle/single resolve to `single ?? result`.
 */
function query(result: { data: unknown; error: unknown }, single?: { data: unknown; error: unknown }) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "in", "order", "update", "insert"]) q[method] = vi.fn(() => q);
  q.maybeSingle = vi.fn().mockResolvedValue(single ?? result);
  q.single = vi.fn().mockResolvedValue(single ?? result);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

/** Builds the app with a supabase whose `registrations` table hands out the queued queries in call order. */
function buildApp(user: { id: string; role: string }, ...registrationQueries: Record<string, any>[]) {
  const queue = [...registrationQueries];
  const from = vi.fn(() => queue.shift() ?? query({ data: [], error: null }));
  (globalThis as any).__mockSupabase = { from };
  (globalThis as any).__mockUser = user;

  const app = express();
  app.use(express.json());
  app.use("/api/registrations", registrationsRouter);
  return { app, from };
}

const publish = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  vi.clearAllMocks();
  publish.mockReset().mockResolvedValue(true);
  setPublisherForTest({ publish });
  clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo()] });
  clients.fetchOpenEvents.mockResolvedValue({ status: "ok", events: [eventInfo()] });
  clients.canViewEvent.mockResolvedValue({ status: "ok" });
  clients.fetchVenueNames.mockResolvedValue({ status: "ok", venuesByEvent: new Map([[1, ["Great Lawn"]]]) });
  clients.fetchUserNames.mockResolvedValue(new Map([["ATT-0001", "Attendee One"]]));
});

describe("role gates", () => {
  it.each([
    ["GET", "/api/registrations/open-events"],
    ["GET", "/api/registrations/user/ORG-0001"],
    ["POST", "/api/registrations"],
    ["PATCH", "/api/registrations/event/1/withdraw"],
    ["GET", "/api/registrations/event/1/view"],
  ])("%s %s refuses a non-attendee", async (method, path) => {
    const { app, from } = buildApp(organiser);

    const res = await request(app)[method.toLowerCase() as "get" | "post" | "patch"](path).send({ eventId: 1 });

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });
});

describe("GET /user/:userId", () => {
  it("lists the caller's registrations with attendee-safe event info", async () => {
    const { app } = buildApp(
      attendee,
      query({
        data: [row(), row({ registration_id: 11, event_id: 2, status: "Withdrawn" })],
        error: null,
      }),
    );
    clients.fetchAttendeeEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo(), eventInfo({ id: 2, name: "Career Networking Night" })],
    });

    const res = await request(app).get("/api/registrations/user/ATT-0001");

    expect(res.status).toBe(200);
    expect(res.body.registrations).toHaveLength(2);
    expect(res.body.registrations[0]).toEqual({
      registrationId: 10,
      eventId: 1,
      userId: "ATT-0001",
      status: "Registered",
      createdAt: "2026-01-01T00:00:00Z",
      additionalInfo: null,
      event: {
        name: "Freshman Orientation Fair",
        description: "Booths and tours",
        proposedDate: "2099-01-01",
        startTime: "09:00",
        endTime: "15:00",
        venues: ["Great Lawn"],
        accessibility: "Step-free entry",
        organiserName: "Pat Organiser",
      },
    });
    expect(res.body.registrations[1].status).toBe("Withdrawn");
    expect(res.body.registrations[1].event.venues).toEqual([]);
    expect(clients.fetchVenueNames).toHaveBeenCalledWith([1, 2], "Bearer test-token");
  });

  it("answers 502 when venue names can't be loaded", async () => {
    const { app } = buildApp(attendee, query({ data: [row()], error: null }));
    clients.fetchVenueNames.mockResolvedValue({ status: "error" });

    expect((await request(app).get("/api/registrations/user/ATT-0001")).status).toBe(502);
  });

  it("refuses another user's id", async () => {
    const { app, from } = buildApp(attendee);

    const res = await request(app).get("/api/registrations/user/ATT-0002");

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it("returns null event info when the event is no longer visible", async () => {
    const { app } = buildApp(attendee, query({ data: [row()], error: null }));
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [] });

    const res = await request(app).get("/api/registrations/user/ATT-0001");

    expect(res.body.registrations[0].event).toBeNull();
  });
});

describe("GET /event/:eventId (roster)", () => {
  it("returns the roster with names to the owning organiser", async () => {
    const { app } = buildApp(
      organiser,
      query({ data: [row(), row({ registration_id: 11, user_id: "ATT-0002", additional_info: { diet: "veg" } })], error: null }),
    );
    clients.fetchUserNames.mockResolvedValue(new Map([["ATT-0001", "Attendee One"]]));

    const res = await request(app).get("/api/registrations/event/1");

    expect(res.status).toBe(200);
    expect(clients.canViewEvent).toHaveBeenCalledWith(1, "Bearer test-token");
    expect(res.body.registrations.map((r: { userId: string; name: string | null }) => [r.userId, r.name])).toEqual([
      ["ATT-0001", "Attendee One"],
      ["ATT-0002", null],
    ]);
    expect(res.body.registrations[1].additionalInfo).toEqual({ diet: "veg" });
  });

  it("allows a coordinator", async () => {
    const { app } = buildApp(coordinator, query({ data: [], error: null }));

    expect((await request(app).get("/api/registrations/event/1")).status).toBe(200);
  });

  it("refuses attendees without asking events-service", async () => {
    const { app } = buildApp(attendee);

    const res = await request(app).get("/api/registrations/event/1");

    expect(res.status).toBe(403);
    expect(clients.canViewEvent).not.toHaveBeenCalled();
  });

  it("refuses an organiser who doesn't own the event", async () => {
    clients.canViewEvent.mockResolvedValue({ status: "denied" });
    const { app, from } = buildApp(organiser);

    const res = await request(app).get("/api/registrations/event/1");

    expect(res.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });

  it("gives a non-owning organiser nothing at all: no body beyond the refusal, no roster read, no names looked up", async () => {
    clients.canViewEvent.mockResolvedValue({ status: "denied" });
    const { app, from } = buildApp(organiser, query({ data: [row()], error: null }));

    const res = await request(app).get("/api/registrations/event/1");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
    expect(from).not.toHaveBeenCalled();
    expect(clients.fetchUserNames).not.toHaveBeenCalled();
  });

  it("answers 502 when events-service can't be reached", async () => {
    clients.canViewEvent.mockResolvedValue({ status: "error" });
    const { app } = buildApp(organiser);

    expect((await request(app).get("/api/registrations/event/1")).status).toBe(502);
  });

  it("rejects a malformed event id", async () => {
    const { app } = buildApp(organiser);

    expect((await request(app).get("/api/registrations/event/abc")).status).toBe(400);
  });
});

describe("POST / (register)", () => {
  /** buildApp, plus the register_for_event RPC answering `outcome`. */
  function buildRegisterApp(outcome: string, ...queries: Record<string, any>[]) {
    const built = buildApp(attendee, ...queries);
    const rpc = vi.fn().mockResolvedValue({ data: outcome, error: null });
    (globalThis as any).__mockSupabase.rpc = rpc;
    return { ...built, rpc };
  }

  it("registers for an open event through the race-safe RPC", async () => {
    const { app, rpc } = buildRegisterApp(
      "registered",
      query({ data: null, error: null }),
      query({ data: null, error: null }, { data: row(), error: null }),
    );

    const res = await request(app).post("/api/registrations").send({ eventId: 1, additionalInfo: { diet: "veg" } });

    expect(res.status).toBe(201);
    expect(res.body.registration).toMatchObject({ eventId: 1, userId: "ATT-0001", status: "Registered" });
    expect(rpc).toHaveBeenCalledWith("register_for_event", {
      p_event_id: 1,
      p_user_id: "ATT-0001",
      p_capacity: null,
      p_additional_info: { diet: "veg" },
      p_set_info: true,
    });
    // #105 row 6: the attendee is notified their registration is confirmed.
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "registration.confirmed",
        eventId: 1,
        recipients: { userIds: ["ATT-0001"], roles: [] },
        data: expect.objectContaining({ eventName: "Freshman Orientation Fair" }),
      }),
    );
  });

  it("takes the user id from the token, never the body", async () => {
    const { app, rpc } = buildRegisterApp(
      "registered",
      query({ data: null, error: null }),
      query({ data: null, error: null }, { data: row(), error: null }),
    );

    await request(app).post("/api/registrations").send({ eventId: 1, userId: "ATT-0099" });

    expect(rpc).toHaveBeenCalledWith("register_for_event", expect.objectContaining({ p_user_id: "ATT-0001" }));
  });

  it.each([
    [{ open: false, registrationState: "NOT_OPEN" }, "not_open"],
    [{ open: false, registrationState: "CLOSED" }, "closed"],
    [{ open: false }, "not_open"],
  ])("refuses an event that isn't open %j", async (overrides, code) => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo(overrides)] });
    const { app, from, rpc } = buildRegisterApp("registered");

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(code);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for an event that doesn't exist", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [] });
    const { app } = buildRegisterApp("registered");

    expect((await request(app).post("/api/registrations").send({ eventId: 99 })).status).toBe(404);
  });

  it("refuses a duplicate registration without calling the RPC", async () => {
    const { app, rpc } = buildRegisterApp("registered", query({ data: null, error: null }, { data: row(), error: null }));

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_registered");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("treats the RPC answering already_registered (a race) as already registered", async () => {
    const { app } = buildRegisterApp("already_registered", query({ data: null, error: null }));

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_registered");
  });

  it("flips a withdrawn registration back to Registered (200, same row), keeping earlier info when none is sent", async () => {
    const lookup = query({ data: null, error: null }, { data: row({ status: "Withdrawn" }), error: null });
    const { app, rpc } = buildRegisterApp(
      "registered",
      lookup,
      query({ data: null, error: null }, { data: row({ status: "Registered" }), error: null }),
    );

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("register_for_event", expect.objectContaining({ p_set_info: false }));
    expect(res.body.registration.status).toBe("Registered");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "registration.confirmed" }));
  });

  it("passes the capacity to the RPC and answers 409 event_full when it says full", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ capacity: 2 })] });
    const { app, rpc } = buildRegisterApp("full", query({ data: null, error: null }));

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("event_full");
    expect(rpc).toHaveBeenCalledWith("register_for_event", expect.objectContaining({ p_capacity: 2 }));
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses re-registering after a withdrawal once the event is full", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ capacity: 1 })] });
    const lookup = query({ data: null, error: null }, { data: row({ status: "Withdrawn" }), error: null });
    const { app } = buildRegisterApp("full", lookup);

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.body.code).toBe("event_full");
  });

  it("still says already registered, not full, to someone holding a place", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ capacity: 1 })] });
    const { app } = buildRegisterApp("full", query({ data: null, error: null }, { data: row(), error: null }));

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.body.code).toBe("already_registered");
  });

  it("answers 500 when the RPC fails", async () => {
    const { app } = buildApp(attendee, query({ data: null, error: null }));
    (globalThis as any).__mockSupabase.rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });

    expect((await request(app).post("/api/registrations").send({ eventId: 1 })).status).toBe(500);
  });

  it.each([
    [{}],
    [{ eventId: "abc" }],
    [{ eventId: 0 }],
    [{ eventId: 1, additionalInfo: "text" }],
    [{ eventId: 1, additionalInfo: [1] }],
    [{ eventId: 1, additionalInfo: { big: "x".repeat(6000) } }],
  ])("rejects invalid input %j", async (body) => {
    const { app } = buildApp(attendee);

    expect((await request(app).post("/api/registrations").send(body)).status).toBe(400);
  });
});

describe("PATCH /event/:eventId/withdraw", () => {
  it("marks the registration Withdrawn without deleting it", async () => {
    const updateQuery = query({ data: null, error: null }, { data: row({ status: "Withdrawn" }), error: null });
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: row(), error: null }), updateQuery);

    const res = await request(app).patch("/api/registrations/event/1/withdraw");

    expect(res.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith({ status: "Withdrawn" });
    expect(res.body.registration.status).toBe("Withdrawn");
    // #105 row 7: the attendee is notified their withdrawal went through.
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "registration.withdrawn",
        eventId: 1,
        recipients: { userIds: ["ATT-0001"], roles: [] },
        data: { eventName: "Freshman Orientation Fair" },
      }),
    );
  });

  it("still lets the attendee withdraw inside the last 5 days, when registration has closed", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo({ open: false, registrationState: "CLOSED", hasStarted: false })],
    });
    const updateQuery = query({ data: null, error: null }, { data: row({ status: "Withdrawn" }), error: null });
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: row(), error: null }), updateQuery);

    const res = await request(app).patch("/api/registrations/event/1/withdraw");

    expect(res.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith({ status: "Withdrawn" });
  });

  it("refuses once the event has started (409 event_started), keeping the place", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ open: false, hasStarted: true })] });
    const updateQuery = query({ data: null, error: null });
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: row(), error: null }), updateQuery);

    const res = await request(app).patch("/api/registrations/event/1/withdraw");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("event_started");
    expect(updateQuery.update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("refuses a registration the organiser's cancellation already ended (409 event_cancelled)", async () => {
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: row({ status: "Cancelled" }), error: null }));

    const res = await request(app).patch("/api/registrations/event/1/withdraw");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("event_cancelled");
    expect(clients.fetchAttendeeEvents).not.toHaveBeenCalled();
  });

  it("answers 502 without withdrawing when the event can't be loaded", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "error" });
    const updateQuery = query({ data: null, error: null });
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: row(), error: null }), updateQuery);

    const res = await request(app).patch("/api/registrations/event/1/withdraw");

    expect(res.status).toBe(502);
    expect(updateQuery.update).not.toHaveBeenCalled();
  });

  it("answers 404 when the attendee isn't registered", async () => {
    const { app } = buildApp(attendee, query({ data: null, error: null }));

    expect((await request(app).patch("/api/registrations/event/1/withdraw")).status).toBe(404);
  });

  it("answers 409 when already withdrawn", async () => {
    const { app } = buildApp(
      attendee,
      query({ data: null, error: null }, { data: row({ status: "Withdrawn" }), error: null }),
    );

    const res = await request(app).patch("/api/registrations/event/1/withdraw");

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_withdrawn");
  });
});

describe("GET /event/:eventId/view (attendee view)", () => {
  it("shows only the attendee-facing fields to a registered attendee", async () => {
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: { status: "Registered" }, error: null }));
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ open: false })] });

    const res = await request(app).get("/api/registrations/event/1/view");

    expect(res.status).toBe(200);
    expect(res.body.event).toEqual({
      id: 1,
      name: "Freshman Orientation Fair",
      description: "Booths and tours",
      proposedDate: "2099-01-01",
      startTime: "09:00",
      endTime: "15:00",
      venues: ["Great Lawn"],
      accessibility: "Step-free entry",
      organiserName: "Pat Organiser",
      capacity: null,
      slotsLeft: null,
      registrationStatus: "Registered",
      open: false,
      hasStarted: false,
    });
  });

  it("shows how many places are left, without saying who holds them", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ capacity: 3 })] });
    const { app } = buildApp(
      attendee,
      query({ data: null, error: null }),
      query({ data: [{ event_id: 1 }, { event_id: 1 }], error: null }),
    );

    const res = await request(app).get("/api/registrations/event/1/view");

    expect(res.body.event).toMatchObject({ capacity: 3, slotsLeft: 1 });
  });

  it("exposes nothing internal or about other attendees", async () => {
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: { status: "Registered" }, error: null }));

    const res = await request(app).get("/api/registrations/event/1/view");
    const body = JSON.stringify(res.body);

    for (const forbidden of ["organiserId", "ORG-0001", "email", "coordinator", "equipment", "purpose", "ATT-0002", "booking", "additional"]) {
      expect(body).not.toContain(forbidden);
    }
    expect(Object.keys(res.body.event).sort()).toEqual(
      [
        "accessibility",
        "capacity",
        "description",
        "endTime",
        "hasStarted",
        "id",
        "name",
        "open",
        "organiserName",
        "proposedDate",
        "registrationStatus",
        "slotsLeft",
        "startTime",
        "venues",
      ],
    );
  });

  it("says the organiser's name is null when events-service doesn't give one", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ organiserName: undefined })] });
    const { app } = buildApp(attendee, query({ data: null, error: null }));

    const res = await request(app).get("/api/registrations/event/1/view");

    expect(res.body.event.organiserName).toBeNull();
  });

  it("lets an unregistered attendee look at an open event (status null)", async () => {
    const { app } = buildApp(attendee, query({ data: null, error: null }));

    const res = await request(app).get("/api/registrations/event/1/view");

    expect(res.status).toBe(200);
    expect(res.body.event.registrationStatus).toBeNull();
  });

  it("denies an unregistered attendee an event that isn't open", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ open: false })] });
    const { app } = buildApp(attendee, query({ data: null, error: null }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).get("/api/registrations/event/1/view");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
    expect(clients.fetchVenueNames).not.toHaveBeenCalled();
  });

  it("denies a withdrawn attendee once the event is no longer open", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ open: false })] });
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: { status: "Withdrawn" }, error: null }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await request(app).get("/api/registrations/event/1/view")).status).toBe(403);
  });

  it("lets an attendee whose registration was Cancelled see the event the organiser cancelled", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ open: false, listed: false })] });
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: { status: "Cancelled" }, error: null }));

    const res = await request(app).get("/api/registrations/event/1/view");

    expect(res.status).toBe(200);
    expect(res.body.event.registrationStatus).toBe("Cancelled");
  });

  it("passes on whether the event has started", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ hasStarted: true })] });
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: { status: "Registered" }, error: null }));

    const res = await request(app).get("/api/registrations/event/1/view");

    expect(res.body.event.hasStarted).toBe(true);
  });

  it("denies an event that doesn't exist the same way", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [] });
    const { app } = buildApp(attendee, query({ data: null, error: null }));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect((await request(app).get("/api/registrations/event/99/view")).status).toBe(403);
  });
});

describe("GET /open-events", () => {
  it("adds the caller's own registration status to each open event", async () => {
    clients.fetchOpenEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo(), eventInfo({ id: 2, name: "Career Networking Night" })],
    });
    const { app } = buildApp(attendee, query({ data: [{ event_id: 1, status: "Registered" }], error: null }));

    const res = await request(app).get("/api/registrations/open-events");

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { id: number; registrationStatus: string | null }) => [e.id, e.registrationStatus])).toEqual([
      [1, "Registered"],
      [2, null],
    ]);
  });

  it("passes the organiser's name through, and null when it isn't known", async () => {
    clients.fetchOpenEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo(), eventInfo({ id: 2, organiserName: undefined })],
    });
    const { app } = buildApp(attendee, query({ data: [], error: null }));

    const res = await request(app).get("/api/registrations/open-events");

    expect(res.body.events.map((e: { organiserName: string | null }) => e.organiserName)).toEqual(["Pat Organiser", null]);
  });

  it("adds slots left to capped events, never below zero, and null to uncapped ones", async () => {
    clients.fetchOpenEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo({ capacity: 5 }), eventInfo({ id: 2, capacity: 1 }), eventInfo({ id: 3, capacity: null })],
    });
    const countQuery = query({ data: [{ event_id: 1 }, { event_id: 2 }, { event_id: 2 }], error: null });
    const { app } = buildApp(attendee, query({ data: [], error: null }), countQuery);

    const res = await request(app).get("/api/registrations/open-events");

    expect(res.body.events.map((e: { id: number; slotsLeft: number | null }) => [e.id, e.slotsLeft])).toEqual([
      [1, 4],
      [2, 0],
      [3, null],
    ]);
    expect(countQuery.in).toHaveBeenCalledWith("event_id", [1, 2]);
  });

  it("skips the registrations query when nothing is open", async () => {
    clients.fetchOpenEvents.mockResolvedValue({ status: "ok", events: [] });
    const { app, from } = buildApp(attendee);

    const res = await request(app).get("/api/registrations/open-events");

    expect(res.body).toEqual({ events: [] });
    expect(from).not.toHaveBeenCalled();
  });
});

describe("registration state (open / full / closed)", () => {
  it("lists closed events as CLOSED and upgrades an OPEN event with no places left to FULL", async () => {
    clients.fetchOpenEvents.mockResolvedValue({
      status: "ok",
      events: [
        eventInfo({ id: 1, capacity: 1, registrationState: "OPEN" }),
        eventInfo({ id: 2, open: false, registrationState: "CLOSED" }),
        eventInfo({ id: 3, capacity: 5, registrationState: "OPEN" }),
      ],
    });
    const { app } = buildApp(
      attendee,
      query({ data: [], error: null }),
      query({ data: [{ event_id: 1 }], error: null }),
    );

    const res = await request(app).get("/api/registrations/open-events");

    expect(res.body.events.map((e: { id: number; registrationState: string }) => [e.id, e.registrationState])).toEqual([
      [1, "FULL"],
      [2, "CLOSED"],
      [3, "OPEN"],
    ]);
  });

  it("lets an unregistered attendee look at a listed event that is now closed", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo({ open: false, listed: true, registrationState: "CLOSED" })],
    });
    const { app } = buildApp(attendee, query({ data: null, error: null }), query({ data: [], error: null }));

    const res = await request(app).get("/api/registrations/event/1/view");

    expect(res.status).toBe(200);
    expect(res.body.event.registrationState).toBe("CLOSED");
  });
});
