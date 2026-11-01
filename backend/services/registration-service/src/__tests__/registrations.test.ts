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
  for (const method of ["select", "eq", "in", "order", "update", "insert", "delete"]) q[method] = vi.fn(() => q);
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
      registrationNeeded: true,
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
        "registrationNeeded",
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

  it("adds each event's venue names, and none when it has no booking, asking for the open ids with the caller's token", async () => {
    clients.fetchOpenEvents.mockResolvedValue({ status: "ok", events: [eventInfo(), eventInfo({ id: 2 })] });
    clients.fetchVenueNames.mockResolvedValue({ status: "ok", venuesByEvent: new Map([[1, ["Great Lawn", "Hall B"]]]) });
    const { app } = buildApp(attendee, query({ data: [], error: null }));

    const res = await request(app).get("/api/registrations/open-events");

    expect(res.body.events.map((e: { id: number; venues: string[] }) => [e.id, e.venues])).toEqual([
      [1, ["Great Lawn", "Hall B"]],
      [2, []],
    ]);
    expect(clients.fetchVenueNames).toHaveBeenCalledWith([1, 2], "Bearer test-token");
  });

  it("answers 502 when the venues can't be looked up", async () => {
    clients.fetchOpenEvents.mockResolvedValue({ status: "ok", events: [eventInfo()] });
    clients.fetchVenueNames.mockResolvedValue({ status: "error" });
    const { app } = buildApp(attendee, query({ data: [], error: null }));

    const res = await request(app).get("/api/registrations/open-events");

    expect(res.status).toBe(502);
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

  it("lets an unregistered attendee read about an event that needs no registration, with nothing to register for", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo({ registrationNeeded: false, open: false, listed: false, viewable: true, capacity: null })],
    });
    const { app } = buildApp(attendee, query({ data: null, error: null }));

    const res = await request(app).get("/api/registrations/event/1/view");

    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ registrationNeeded: false, open: false, slotsLeft: null });
  });

  it("still denies an unregistered attendee an event that is neither listed nor viewable", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo({ registrationNeeded: false, open: false, listed: false, viewable: false })],
    });
    const { app } = buildApp(attendee, query({ data: null, error: null }));

    expect((await request(app).get("/api/registrations/event/1/view")).status).toBe(403);
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

describe("event ids", () => {
  // events.id is a Postgres integer: past this, the query errors and the caller gets a 500 instead of a 400.
  const TOO_BIG = "2147483648";

  it.each([
    ["GET", `/api/registrations/event/${TOO_BIG}/view`],
    ["PATCH", `/api/registrations/event/${TOO_BIG}/withdraw`],
  ])("%s %s refuses an id that doesn't fit the column, before any query", async (method, path) => {
    const { app, from } = buildApp(attendee);
    const res = await (method === "GET" ? request(app).get(path) : request(app).patch(path));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid event id" });
    expect(from).not.toHaveBeenCalled();
  });

  it("the roster refuses an id that doesn't fit the column", async () => {
    const { app } = buildApp(organiser);
    const res = await request(app).get(`/api/registrations/event/${TOO_BIG}`);
    expect(res.status).toBe(400);
    expect(clients.canViewEvent).not.toHaveBeenCalled();
  });

  it("registering refuses an id that doesn't fit the column", async () => {
    const { app } = buildApp(attendee);
    const res = await request(app).post("/api/registrations").send({ eventId: 2147483648 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "eventId must be a positive integer", field: "eventId" });
  });

  it("accepts the largest id that fits", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [] });
    const { app } = buildApp(attendee);
    const res = await request(app).get("/api/registrations/event/2147483647/view");
    expect(res.status).toBe(403);
    expect(clients.fetchAttendeeEvents).toHaveBeenCalledWith([2147483647], "Bearer test-token");
  });
});

describe("withdrawing while the organiser cancels", () => {
  // The event is fetched between reading the place and giving it up, so a cancellation can land in between.
  it("only gives up a place that is still Registered", async () => {
    const updateQuery = query({ data: null, error: null }, { data: row({ status: "Withdrawn" }), error: null });
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: row(), error: null }), updateQuery);

    await request(app).patch("/api/registrations/event/1/withdraw");

    expect(updateQuery.eq).toHaveBeenCalledWith("registration_id", 10);
    expect(updateQuery.eq).toHaveBeenCalledWith("status", "Registered");
  });

  it("answers 409 and notifies nobody when the place is gone by the time it writes", async () => {
    const updateQuery = query({ data: null, error: null });
    const { app } = buildApp(attendee, query({ data: null, error: null }, { data: row(), error: null }), updateQuery);

    const res = await request(app).patch("/api/registrations/event/1/withdraw");

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "You no longer hold a place for this event", code: "no_place" });
    expect(publish).not.toHaveBeenCalled();
  });
});

const COLUMNS = "registration_id, event_id, user_id, status, created_at, additional_info";
const failed = { data: null, error: { message: "boom" } };

describe("GET /open-events: details", () => {
  it("answers 502 when the events can't be loaded", async () => {
    clients.fetchOpenEvents.mockResolvedValue({ status: "error" });
    const { app } = buildApp(attendee);
    const res = await request(app).get("/api/registrations/open-events");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load events" });
  });

  it("reads the caller's own status for just those events, on the registrations table", async () => {
    const statuses = query({ data: [{ event_id: 1, status: "Withdrawn" }], error: null });
    const { app, from } = buildApp(attendee, statuses);

    const res = await request(app).get("/api/registrations/open-events");

    expect(from).toHaveBeenCalledWith("registrations");
    expect(statuses.select).toHaveBeenCalledWith("event_id, status");
    expect(statuses.eq).toHaveBeenCalledWith("user_id", "ATT-0001");
    expect(statuses.in).toHaveBeenCalledWith("event_id", [1]);
    expect(clients.fetchOpenEvents).toHaveBeenCalledWith("Bearer test-token");
    expect(clients.fetchVenueNames).toHaveBeenCalledWith([1], "Bearer test-token");
    expect(res.body.events[0]).toEqual({
      ...eventInfo(),
      venues: ["Great Lawn"],
      capacity: null,
      slotsLeft: null,
      registrationStatus: "Withdrawn",
    });
  });

  it("answers 500 when the caller's statuses can't be loaded", async () => {
    const { app } = buildApp(attendee, query(failed));
    const res = await request(app).get("/api/registrations/open-events");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load registrations" });
  });

  it("reads missing status rows as no registration", async () => {
    const { app } = buildApp(attendee, query({ data: null, error: null }));
    const res = await request(app).get("/api/registrations/open-events");
    expect(res.body.events[0].registrationStatus).toBeNull();
  });

  it("counts only Registered places, only for capped events", async () => {
    clients.fetchOpenEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo({ id: 1, capacity: 3 }), eventInfo({ id: 2 }), eventInfo({ id: 3, capacity: 1 })],
    });
    const counts = query({ data: [{ event_id: 1 }, { event_id: 1 }, { event_id: 3 }], error: null });
    const { app } = buildApp(attendee, query({ data: [], error: null }), counts);

    const res = await request(app).get("/api/registrations/open-events");

    expect(counts.select).toHaveBeenCalledWith("event_id");
    expect(counts.eq).toHaveBeenCalledWith("status", "Registered");
    expect(counts.in).toHaveBeenCalledWith("event_id", [1, 3]);
    expect(res.body.events.map((e: { slotsLeft: number | null }) => e.slotsLeft)).toEqual([1, null, 0]);
  });

  it("reads missing count rows as nobody registered", async () => {
    clients.fetchOpenEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ capacity: 3 })] });
    const { app } = buildApp(attendee, query({ data: [], error: null }), query({ data: null, error: null }));
    const res = await request(app).get("/api/registrations/open-events");
    expect(res.body.events[0].slotsLeft).toBe(3);
  });

  it("answers 500 when the places can't be counted", async () => {
    clients.fetchOpenEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ capacity: 3 })] });
    const { app } = buildApp(attendee, query({ data: [], error: null }), query(failed));
    const res = await request(app).get("/api/registrations/open-events");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load registrations" });
  });

  it("only shows FULL for an OPEN event with no places left", async () => {
    clients.fetchOpenEvents.mockResolvedValue({
      status: "ok",
      events: [
        eventInfo({ id: 1, capacity: 1, registrationState: "CLOSED" }),
        eventInfo({ id: 2, capacity: 2, registrationState: "OPEN" }),
        eventInfo({ id: 3, capacity: 1, registrationState: "OPEN" }),
      ],
    });
    const counts = query({ data: [{ event_id: 1 }, { event_id: 2 }, { event_id: 3 }], error: null });
    const { app } = buildApp(attendee, query({ data: [], error: null }), counts);

    const res = await request(app).get("/api/registrations/open-events");

    expect(res.body.events.map((e: { registrationState: string }) => e.registrationState)).toEqual(["CLOSED", "OPEN", "FULL"]);
  });
});

describe("GET /user/:userId: details", () => {
  it("reads the caller's rows newest first, asking for each event once", async () => {
    const rows = query({ data: [row({ registration_id: 2 }), row({ registration_id: 1 })], error: null });
    const { app, from } = buildApp(attendee, rows);

    const res = await request(app).get("/api/registrations/user/ATT-0001");

    expect(from).toHaveBeenCalledWith("registrations");
    expect(rows.select).toHaveBeenCalledWith(COLUMNS);
    expect(rows.eq).toHaveBeenCalledWith("user_id", "ATT-0001");
    expect(rows.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(clients.fetchAttendeeEvents).toHaveBeenCalledWith([1], "Bearer test-token");
    expect(clients.fetchVenueNames).toHaveBeenCalledWith([1], "Bearer test-token");
    expect(res.body.registrations[0]).toEqual({
      registrationId: 2,
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
  });

  it("fills in what other services left out", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ organiserName: undefined })] });
    clients.fetchVenueNames.mockResolvedValue({ status: "ok", venuesByEvent: new Map() });
    const { app } = buildApp(attendee, query({ data: [row()], error: null }));

    const res = await request(app).get("/api/registrations/user/ATT-0001");

    expect(res.body.registrations[0].event).toMatchObject({ venues: [], organiserName: null });
  });

  it("answers 500 when the rows can't be loaded", async () => {
    const { app } = buildApp(attendee, query(failed));
    const res = await request(app).get("/api/registrations/user/ATT-0001");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load registrations" });
  });

  it("reads missing rows as none", async () => {
    const { app } = buildApp(attendee, query({ data: null, error: null }));
    const res = await request(app).get("/api/registrations/user/ATT-0001");
    expect(res.body).toEqual({ registrations: [] });
  });

  it("answers 502 when the events can't be loaded", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "error" });
    const { app } = buildApp(attendee, query({ data: [row()], error: null }));
    const res = await request(app).get("/api/registrations/user/ATT-0001");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load events" });
  });

  it("names the failure when venues can't be loaded", async () => {
    clients.fetchVenueNames.mockResolvedValue({ status: "error" });
    const { app } = buildApp(attendee, query({ data: [row()], error: null }));
    const res = await request(app).get("/api/registrations/user/ATT-0001");
    expect(res.body).toEqual({ error: "Failed to load the events' venues" });
  });
});

describe("GET /event/:eventId (roster): details", () => {
  it("reads this event's rows oldest first, asking for each name once", async () => {
    clients.fetchUserNames.mockResolvedValue(new Map([["ATT-0001", "Attendee One"]]));
    const rows = query({ data: [row(), row({ registration_id: 11 }), row({ registration_id: 12, user_id: "ATT-0002" })], error: null });
    const { app, from } = buildApp(organiser, rows);

    const res = await request(app).get("/api/registrations/event/1");

    expect(clients.canViewEvent).toHaveBeenCalledWith(1, "Bearer test-token");
    expect(from).toHaveBeenCalledWith("registrations");
    expect(rows.select).toHaveBeenCalledWith(COLUMNS);
    expect(rows.eq).toHaveBeenCalledWith("event_id", 1);
    expect(rows.order).toHaveBeenCalledWith("created_at");
    expect(clients.fetchUserNames).toHaveBeenCalledWith(["ATT-0001", "ATT-0002"], "Bearer test-token");
    expect(res.body.registrations[0].name).toBe("Attendee One");
    expect(res.body.registrations[2].name).toBeNull();
  });

  it("answers 500 when the rows can't be loaded", async () => {
    const { app } = buildApp(organiser, query(failed));
    const res = await request(app).get("/api/registrations/event/1");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load registrations" });
  });

  it("reads missing rows as an empty roster", async () => {
    const { app } = buildApp(organiser, query({ data: null, error: null }));
    const res = await request(app).get("/api/registrations/event/1");
    expect(res.body).toEqual({ registrations: [] });
  });

  it("says exactly why it refused", async () => {
    clients.canViewEvent.mockResolvedValue({ status: "denied" });
    expect((await request(buildApp(organiser).app).get("/api/registrations/event/1")).body).toEqual({ error: "Access denied" });
    clients.canViewEvent.mockResolvedValue({ status: "error" });
    expect((await request(buildApp(organiser).app).get("/api/registrations/event/1")).body).toEqual({ error: "Failed to load the event" });
    expect((await request(buildApp(attendee).app).get("/api/registrations/event/x")).body).toEqual({ error: "Invalid event id" });
    expect((await request(buildApp(attendee).app).get("/api/registrations/event/1")).body).toEqual({ error: "Access denied" });
  });
});

describe("POST / (register): details", () => {
  function setup(outcome: unknown, existing: unknown, saved: { data: unknown; error: unknown } = { data: row(), error: null }) {
    const lookup = query({ data: null, error: null }, { data: existing, error: null });
    const load = query({ data: null, error: null }, saved);
    const built = buildApp(attendee, lookup, load);
    const rpc = vi.fn().mockResolvedValue(outcome);
    (globalThis as any).__mockSupabase.rpc = rpc;
    return { ...built, rpc, lookup, load };
  }
  const ok = { data: "registered", error: null };

  it.each([
    ["a text id", "1", 1],
    ["a one-item list", [1], 1],
    ["a number", 1, 1],
  ])("accepts %s", async (_name, eventId, expected) => {
    const { app } = setup(ok, null);
    const res = await request(app).post("/api/registrations").send({ eventId });
    expect(res.status).toBe(201);
    expect(clients.fetchAttendeeEvents).toHaveBeenCalledWith([expected], "Bearer test-token");
  });

  it.each([[0], [-1], [1.5], ["01"], ["abc"], [null], [{}], [true]])("refuses eventId %j", async (eventId) => {
    const { app } = setup(ok, null);
    const res = await request(app).post("/api/registrations").send({ eventId });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "eventId must be a positive integer", field: "eventId" });
  });

  it("refuses a missing body", async () => {
    const { app } = setup(ok, null);
    expect((await request(app).post("/api/registrations")).status).toBe(400);
  });

  it.each([
    ["a list", [1]],
    ["text", "veg"],
    ["a number", 3],
    ["too long", { note: "x".repeat(5000) }],
  ])("refuses additionalInfo that is %s", async (_name, additionalInfo) => {
    const { app } = setup(ok, null);
    const res = await request(app).post("/api/registrations").send({ eventId: 1, additionalInfo });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "additionalInfo must be an object under 5000 characters", field: "additionalInfo" });
  });

  it("accepts additionalInfo of exactly the maximum size", async () => {
    const { app } = setup(ok, null);
    // {"note":"…"} adds 11 characters around the text.
    const res = await request(app).post("/api/registrations").send({ eventId: 1, additionalInfo: { note: "x".repeat(4989) } });
    expect(res.status).toBe(201);
  });

  it("clears additionalInfo for an explicit null, and keeps it when left out", async () => {
    const cleared = setup(ok, null);
    await request(cleared.app).post("/api/registrations").send({ eventId: 1, additionalInfo: null });
    expect(cleared.rpc.mock.calls[0][1]).toMatchObject({ p_additional_info: null, p_set_info: true });

    const kept = setup(ok, null);
    await request(kept.app).post("/api/registrations").send({ eventId: 1 });
    expect(kept.rpc.mock.calls[0][1]).toMatchObject({ p_additional_info: null, p_set_info: false });
  });

  it("answers exactly when the event can't be loaded or found", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "error" });
    expect((await request(setup(ok, null).app).post("/api/registrations").send({ eventId: 1 })).body).toEqual({ error: "Failed to load the event" });
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ id: 2 })] });
    expect((await request(setup(ok, null).app).post("/api/registrations").send({ eventId: 1 })).body).toEqual({ error: "Event not found" });
  });

  it("tells closed apart from not open yet", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ open: false, registrationState: "CLOSED" })] });
    expect((await request(setup(ok, null).app).post("/api/registrations").send({ eventId: 1 })).body).toEqual({
      error: "Registration for this event is closed",
      code: "closed",
    });
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ open: false, registrationState: "NOT_OPEN" })] });
    expect((await request(setup(ok, null).app).post("/api/registrations").send({ eventId: 1 })).body).toEqual({
      error: "This event is not open for registration",
      code: "not_open",
    });
  });

  it("looks up the caller's own row for this event", async () => {
    const { app, lookup, from } = setup(ok, null);
    await request(app).post("/api/registrations").send({ eventId: 1 });
    expect(from).toHaveBeenCalledWith("registrations");
    expect(lookup.select).toHaveBeenCalledWith(COLUMNS);
    expect(lookup.eq).toHaveBeenCalledWith("event_id", 1);
    expect(lookup.eq).toHaveBeenCalledWith("user_id", "ATT-0001");
  });

  it("answers 500 when the lookup fails", async () => {
    const lookup = query({ data: null, error: null }, failed);
    const res = await request(buildApp(attendee, lookup).app).post("/api/registrations").send({ eventId: 1 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to register" });
  });

  it("answers exactly for already registered and full", async () => {
    expect((await request(setup(ok, row()).app).post("/api/registrations").send({ eventId: 1 })).body).toEqual({
      error: "You are already registered for this event",
      code: "already_registered",
    });
    expect((await request(setup({ data: "already_registered", error: null }, null).app).post("/api/registrations").send({ eventId: 1 })).status).toBe(409);
    expect((await request(setup({ data: "full", error: null }, null).app).post("/api/registrations").send({ eventId: 1 })).body).toEqual({
      error: "This event is full",
      code: "event_full",
    });
  });

  it("names the failure and notifies nobody when the RPC fails", async () => {
    const res = await request(setup(failed, null).app).post("/api/registrations").send({ eventId: 1 });
    expect(res.body).toEqual({ error: "Failed to register" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("reads the saved row back, passing the capacity to the RPC", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ capacity: 40 })] });
    const { app, load, rpc } = setup(ok, null);

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(rpc.mock.calls[0][1].p_capacity).toBe(40);
    expect(load.select).toHaveBeenCalledWith(COLUMNS);
    expect(load.eq).toHaveBeenCalledWith("event_id", 1);
    expect(load.eq).toHaveBeenCalledWith("user_id", "ATT-0001");
    expect(res.body.registration.registrationId).toBe(10);
  });

  it.each([
    ["fails", failed],
    ["finds nothing", { data: null, error: null }],
  ])("answers 500 and notifies nobody when reading it back %s", async (_name, saved) => {
    const res = await request(setup(ok, null, saved).app).post("/api/registrations").send({ eventId: 1 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to register" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes the whole confirmation", async () => {
    await request(setup(ok, null).app).post("/api/registrations").send({ eventId: 1 });
    expect(publish).toHaveBeenCalledWith({
      type: "registration.confirmed",
      eventId: 1,
      actorId: "ATT-0001",
      recipients: { userIds: ["ATT-0001"], roles: [] },
      data: { eventName: "Freshman Orientation Fair" },
    });
  });
});

describe("PATCH /event/:eventId/withdraw: details", () => {
  const held = () => query({ data: null, error: null }, { data: row(), error: null });
  const written = () => query({ data: null, error: null }, { data: row({ status: "Withdrawn" }), error: null });

  it("answers exactly for each refusal", async () => {
    const withdraw = (...queries: Record<string, any>[]) => request(buildApp(attendee, ...queries).app).patch("/api/registrations/event/1/withdraw");

    expect((await request(buildApp(attendee).app).patch("/api/registrations/event/x/withdraw")).body).toEqual({ error: "Invalid event id" });
    expect((await withdraw(query({ data: null, error: null }, failed))).body).toEqual({ error: "Failed to withdraw" });
    expect((await withdraw(query({ data: null, error: null }))).body).toEqual({ error: "You are not registered for this event" });
    expect((await withdraw(query({ data: null, error: null }, { data: row({ status: "Withdrawn" }), error: null }))).body).toEqual({
      error: "You have already withdrawn from this event",
      code: "already_withdrawn",
    });
    expect((await withdraw(query({ data: null, error: null }, { data: row({ status: "Cancelled" }), error: null }))).body).toEqual({
      error: "This event was cancelled by the organiser",
      code: "event_cancelled",
    });
  });

  it("reads the caller's own place, then writes that row", async () => {
    const lookup = held();
    const update = written();
    const { app, from } = buildApp(attendee, lookup, update);

    await request(app).patch("/api/registrations/event/1/withdraw");

    expect(from.mock.calls).toEqual([["registrations"], ["registrations"]]);
    expect(lookup.select).toHaveBeenCalledWith(COLUMNS);
    expect(lookup.eq).toHaveBeenCalledWith("event_id", 1);
    expect(lookup.eq).toHaveBeenCalledWith("user_id", "ATT-0001");
    expect(update.select).toHaveBeenCalledWith(COLUMNS);
    expect(clients.fetchAttendeeEvents).toHaveBeenCalledWith([1], "Bearer test-token");
  });

  it("says why when the event has started or can't be loaded", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ hasStarted: true })] });
    expect((await request(buildApp(attendee, held()).app).patch("/api/registrations/event/1/withdraw")).body).toEqual({
      error: "This event has already started, so you can no longer withdraw",
      code: "event_started",
    });
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "error" });
    expect((await request(buildApp(attendee, held()).app).patch("/api/registrations/event/1/withdraw")).body).toEqual({
      error: "Failed to load the event",
    });
  });

  it("answers 500 and notifies nobody when the write fails", async () => {
    const res = await request(buildApp(attendee, held(), query({ data: null, error: null }, failed)).app).patch("/api/registrations/event/1/withdraw");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to withdraw" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("still withdraws from an event it can't find, without naming it", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [] });

    const res = await request(buildApp(attendee, held(), written()).app).patch("/api/registrations/event/1/withdraw");

    expect(res.status).toBe(200);
    expect(publish).toHaveBeenCalledWith({
      type: "registration.withdrawn",
      eventId: 1,
      actorId: "ATT-0001",
      recipients: { userIds: ["ATT-0001"], roles: [] },
      data: {},
    });
  });

  it("doesn't take another event's start time for this one", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ id: 2, hasStarted: true })] });
    const res = await request(buildApp(attendee, held(), written()).app).patch("/api/registrations/event/1/withdraw");
    expect(res.status).toBe(200);
  });
});

describe("GET /event/:eventId/view: details", () => {
  const place = (status: string | null) => query({ data: null, error: null }, { data: status ? { status } : null, error: null });

  it("reads the caller's own status for this event", async () => {
    const lookup = place("Registered");
    const { app, from } = buildApp(attendee, lookup);

    await request(app).get("/api/registrations/event/1/view");

    expect(from).toHaveBeenCalledWith("registrations");
    expect(lookup.select).toHaveBeenCalledWith("status");
    expect(lookup.eq).toHaveBeenCalledWith("event_id", 1);
    expect(lookup.eq).toHaveBeenCalledWith("user_id", "ATT-0001");
    expect(clients.fetchAttendeeEvents).toHaveBeenCalledWith([1], "Bearer test-token");
    expect(clients.fetchVenueNames).toHaveBeenCalledWith([1], "Bearer test-token");
  });

  it("answers exactly for each failure", async () => {
    const view = (...queries: Record<string, any>[]) => request(buildApp(attendee, ...queries).app).get("/api/registrations/event/1/view");

    const invalid = await request(buildApp(attendee).app).get("/api/registrations/event/x/view");
    expect(invalid.body).toEqual({ error: "Invalid event id" });

    const lookup = await view(query({ data: null, error: null }, failed));
    expect(lookup.status).toBe(500);
    expect(lookup.body).toEqual({ error: "Failed to load the event" });

    clients.fetchAttendeeEvents.mockResolvedValueOnce({ status: "error" });
    const events = await view(place("Registered"));
    expect(events.status).toBe(502);
    expect(events.body).toEqual({ error: "Failed to load the event" });

    clients.fetchVenueNames.mockResolvedValueOnce({ status: "error" });
    const venues = await view(place("Registered"));
    expect(venues.status).toBe(502);
    expect(venues.body).toEqual({ error: "Failed to load the event's venue" });
  });

  it("answers 500 when the places can't be counted", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ capacity: 3 })] });
    const res = await request(buildApp(attendee, place("Registered"), query(failed)).app).get("/api/registrations/event/1/view");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the event" });
  });

  it("logs who was refused and answers the same as for a missing event", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ open: false })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(buildApp(attendee, place(null)).app).get("/api/registrations/event/1/view");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
    expect(warn).toHaveBeenCalledWith("Attendee ATT-0001 denied access to event 1 (not registered, not listed)");
    warn.mockRestore();
  });

  it("returns the full attendee shape, with what other services left out filled in", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({
      status: "ok",
      events: [eventInfo({ organiserName: undefined, capacity: 2, registrationState: "OPEN", internalNote: "secret" })],
    });
    clients.fetchVenueNames.mockResolvedValue({ status: "ok", venuesByEvent: new Map() });
    const counts = query({ data: [{ event_id: 1 }, { event_id: 1 }], error: null });

    const res = await request(buildApp(attendee, place("Registered"), counts).app).get("/api/registrations/event/1/view");

    expect(res.body).toEqual({
      event: {
        id: 1,
        name: "Freshman Orientation Fair",
        description: "Booths and tours",
        proposedDate: "2099-01-01",
        startTime: "09:00",
        endTime: "15:00",
        venues: [],
        accessibility: "Step-free entry",
        organiserName: null,
        capacity: 2,
        slotsLeft: 0,
        registrationNeeded: true,
        registrationState: "FULL",
        registrationStatus: "Registered",
        open: true,
        hasStarted: false,
      },
    });
  });

  it.each([
    ["viewable wins over listed and open", { viewable: false, listed: true, open: true }, 403],
    ["listed wins over open", { listed: false, open: true }, 403],
    ["open is the last resort", { open: true }, 200],
  ])("for someone with no place, %s", async (_name, flags, status) => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo(flags)] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(buildApp(attendee, place(null)).app).get("/api/registrations/event/1/view");
    expect(res.status).toBe(status);
    warn.mockRestore();
  });
});

describe("exact refusals", () => {
  it("tells a non-attendee and another attendee the same thing", async () => {
    const asOrganiser = await request(buildApp(organiser).app).get("/api/registrations/open-events");
    expect(asOrganiser.body).toEqual({ error: "Access denied" });
    const asOther = await request(buildApp(attendee).app).get("/api/registrations/user/ATT-0002");
    expect(asOther.body).toEqual({ error: "Access denied" });
  });

  it("names the failure when an open event's venues can't be loaded", async () => {
    clients.fetchVenueNames.mockResolvedValue({ status: "error" });
    const res = await request(buildApp(attendee).app).get("/api/registrations/open-events");
    expect(res.body).toEqual({ error: "Failed to load the events' venues" });
  });
});

describe("the right table and the right event", () => {
  it("counts places on the registrations table", async () => {
    clients.fetchOpenEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ capacity: 3 })] });
    const { app, from } = buildApp(attendee, query({ data: [], error: null }), query({ data: [], error: null }));
    await request(app).get("/api/registrations/open-events");
    expect(from.mock.calls).toEqual([["registrations"], ["registrations"]]);
  });

  it("registering reads and reads back the registrations table", async () => {
    const { app, from } = buildApp(
      attendee,
      query({ data: null, error: null }),
      query({ data: null, error: null }, { data: row(), error: null }),
    );
    (globalThis as any).__mockSupabase.rpc = vi.fn().mockResolvedValue({ data: "registered", error: null });
    await request(app).post("/api/registrations").send({ eventId: 1 });
    expect(from.mock.calls).toEqual([["registrations"], ["registrations"]]);
  });

  it("the attendee view doesn't take another event in the reply for this one", async () => {
    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [eventInfo({ id: 2 })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await request(buildApp(attendee, query({ data: null, error: null })).app).get("/api/registrations/event/1/view");
    expect(res.status).toBe(403);
    warn.mockRestore();
  });
});

describe("POST /: the event closes while registering", () => {
  const stillOpen = { status: "ok", events: [eventInfo()] };
  const nowClosed = { status: "ok", events: [eventInfo({ open: false, registrationState: "CLOSED" })] };
  const registered = { data: "registered", error: null };

  /** The first event lookup says open, the second `recheck`. The queries are the lookup, then whatever the route does next. */
  function setup(recheck: unknown, existing: unknown, next: Record<string, any>) {
    clients.fetchAttendeeEvents.mockResolvedValueOnce(stillOpen).mockResolvedValueOnce(recheck);
    const built = buildApp(attendee, query({ data: null, error: null }, { data: existing, error: null }), next);
    (globalThis as any).__mockSupabase.rpc = vi.fn().mockResolvedValue(registered);
    return built;
  }

  it("checks again after saving, with the caller's token", async () => {
    const { app } = setup(stillOpen, null, query({ data: null, error: null }, { data: row(), error: null }));

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(201);
    expect(clients.fetchAttendeeEvents.mock.calls).toEqual([
      [[1], "Bearer test-token"],
      [[1], "Bearer test-token"],
    ]);
  });

  it("removes a new place, answers closed and notifies nobody", async () => {
    const undo = query({ data: null, error: null });
    const { app, from } = setup(nowClosed, null, undo);

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Registration for this event is closed", code: "closed" });
    expect(from.mock.calls).toEqual([["registrations"], ["registrations"]]);
    expect(undo.delete).toHaveBeenCalledOnce();
    expect(undo.update).not.toHaveBeenCalled();
    expect(undo.eq).toHaveBeenCalledWith("event_id", 1);
    expect(undo.eq).toHaveBeenCalledWith("user_id", "ATT-0001");
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["Cancelled", "Withdrawn"])("puts a %s row back as it was", async (status) => {
    const undo = query({ data: null, error: null });
    const { app, from } = setup(nowClosed, row({ status, additional_info: { diet: "veg" } }), undo);

    const res = await request(app).post("/api/registrations").send({ eventId: 1, additionalInfo: { diet: "halal" } });

    expect(res.status).toBe(409);
    expect(from.mock.calls).toEqual([["registrations"], ["registrations"]]);
    expect(undo.update).toHaveBeenCalledWith({ status, additional_info: { diet: "veg" } });
    expect(undo.delete).not.toHaveBeenCalled();
    expect(undo.eq).toHaveBeenCalledWith("registration_id", 10);
    expect(publish).not.toHaveBeenCalled();
  });

  it("treats an event no longer returned as closed", async () => {
    const undo = query({ data: null, error: null });
    const { app } = setup({ status: "ok", events: [eventInfo({ id: 2 })] }, null, undo);

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(409);
    expect(undo.delete).toHaveBeenCalledOnce();
  });

  it("keeps the registration when the second check can't be made: a brief outage shouldn't cost anyone a place", async () => {
    const { app } = setup({ status: "error" }, null, query({ data: null, error: null }, { data: row(), error: null }));

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(201);
    expect(publish).toHaveBeenCalledOnce();
  });

  it("answers 500 and logs it when the place can't be undone", async () => {
    const failure = { message: "boom" };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = setup(nowClosed, null, query({ data: null, error: failure }));

    const res = await request(app).post("/api/registrations").send({ eventId: 1 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to register" });
    expect(error).toHaveBeenCalledWith("registration-service: couldn't undo a registration for closed event 1 (ATT-0001)", failure);
    expect(publish).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
