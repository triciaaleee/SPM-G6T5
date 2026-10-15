import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { combinedReason, currentArrangements, hasChanged, parseChangeRequest, resolveFlags } from "../lib/safetyChanges.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

/** E3-14: the Safety Officer requests specific changes, short of rejecting. */

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

const safetyOfficer = { id: "SAF-0001", role: "safety_officer" };
const coordinator = { id: "COORD-0001", role: "coordinator" };

/** What venue-service and equipment-service say event 7 has. */
const bookings = [
  { id: 31, status: "Approved", venue: { id: 1, name: "Grand Ballroom" } },
  { id: 32, status: "Approved", venue: { id: 2, name: "Seminar Room 3-01" } },
  { id: 33, status: "Withdrawn", venue: { id: 3, name: "Sports Hall" } },
];
const equipmentRequests = [
  { id: 50, status: "Arranged", items: [{ id: 51, equipmentType: "PA system", quantity: 2, quantityFulfilled: 2 }] },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Options {
  user?: { id: string; role: string };
  status?: string;
  reviewId?: number | null;
  rpcError?: boolean;
  arrangementsFail?: boolean;
  currentBookings?: typeof bookings;
  currentEquipment?: typeof equipmentRequests;
  latestReview?: Record<string, unknown> | null;
  flags?: Record<string, unknown>[];
  hasSubmission?: boolean;
}

function buildApp(options: Options = {}) {
  const event = { id: 7, status: options.status ?? "Safety Review", coordinator_id: "COORD-0001", organiser_id: "ORG-0001" };
  const reloaded = { ...event, status: "Planning", submitted_details: { name: "Spring Gala" } };
  const resolved = (data: unknown) => vi.fn().mockResolvedValue({ data, error: null });

  const flagUpdate = { in: vi.fn(() => ({ is: resolved(null) })) };
  const tables: Record<string, any> = {
    events: {
      select: () => ({
        eq: () => ({ maybeSingle: resolved({ ...event, organiser_id: "ORG-0001" }), single: resolved(reloaded) }),
      }),
    },
    event_safety_reviews: {
      select: () => ({
        eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: resolved(options.latestReview ?? null) }) }) }),
      }),
    },
    event_safety_review_flags: {
      select: () => ({ eq: () => ({ order: resolved(options.flags ?? []) }) }),
      update: vi.fn(() => flagUpdate),
    },
    event_safety_submissions: {
      select: () => ({
        eq: () => ({ limit: () => ({ maybeSingle: resolved(options.hasSubmission ? { id: 1 } : null) }) }),
      }),
    },
    access_denials: { insert: resolved(null) },
  };
  const rpc = vi.fn().mockResolvedValue({
    data: options.rpcError ? null : options.reviewId === undefined ? 903 : options.reviewId,
    error: options.rpcError ? { message: "boom" } : null,
  });
  (globalThis as any).__mockSupabase = { from: vi.fn((table: string) => tables[table]), rpc };
  (globalThis as any).__mockUser = options.user ?? safetyOfficer;

  const fetchMock = vi.fn(async (url: string) => {
    const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
    if (options.arrangementsFail) return json({}, false);
    if (url.includes("/api/venues/events/7/bookings")) return json({ bookings: options.currentBookings ?? bookings });
    if (url.includes("/api/equipment-requests?eventId=7")) {
      return json({ equipmentRequests: options.currentEquipment ?? equipmentRequests });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const publish = vi.fn().mockResolvedValue(true);
  setPublisherForTest({ publish });

  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return { app, rpc, fetchMock, flagUpdate, tables, publish };
}

const validBody = {
  arrangements: [
    { type: "venue_booking", id: 32, note: "Exits are blocked by the stage." },
    { type: "equipment_item", id: 51, note: "Move the PA away from the fire exit." },
  ],
  generalNote: "Send an updated crowd plan.",
};

const expectedFlags = [
  {
    type: "venue_booking",
    id: 32,
    label: "Seminar Room 3-01",
    note: "Exits are blocked by the stage.",
    snapshot: { status: "Approved" },
  },
  {
    type: "equipment_item",
    id: 51,
    label: "PA system × 2",
    note: "Move the PA away from the fire exit.",
    snapshot: { equipmentType: "PA system", quantity: 2, quantityFulfilled: 2 },
  },
];

const expectedReason =
  "Seminar Room 3-01: Exits are blocked by the stage; PA system × 2: Move the PA away from the fire exit. General: Send an updated crowd plan.";

function requestChanges(app: express.Express, body: unknown = validBody) {
  return request(app).post("/api/events/7/safety-review/request-changes").set("Authorization", "Bearer t").send(body as object);
}

describe("parseChangeRequest (AC2)", () => {
  it("accepts arrangements each with a note, and an optional general note", () => {
    expect(parseChangeRequest(validBody)).toEqual({
      valid: true,
      request: { arrangements: validBody.arrangements, generalNote: "Send an updated crowd plan." },
    });
    expect(parseChangeRequest({ arrangements: [validBody.arrangements[0]] })).toMatchObject({
      valid: true,
      request: { generalNote: null },
    });
  });

  it.each([
    ["no arrangement", { generalNote: "Move the PA" }, ["arrangements"]],
    ["an empty arrangement list", { arrangements: [] }, ["arrangements"]],
    ["an arrangement with no note", { arrangements: [{ type: "venue_booking", id: 32 }] }, ["note:venue_booking:32"]],
    [
      "one of two notes blank",
      { arrangements: [validBody.arrangements[0], { type: "equipment_item", id: 51, note: "  " }] },
      ["note:equipment_item:51"],
    ],
    ["nothing at all", {}, ["arrangements"]],
  ])("blocks %s", (_label, body, fields) => {
    const result = parseChangeRequest(body);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(Object.keys(result.fields).sort()).toEqual(fields);
  });

  it("rejects a malformed arrangement", () => {
    expect(parseChangeRequest({ arrangements: [{ type: "room", id: 1, note: "x" }] }).valid).toBe(false);
  });

  it("combines the notes into the decision's reason", () => {
    const flags = [
      { label: "Seminar Room 3-01", note: "Exits blocked." },
      { label: "PA system × 2", note: "Move it." },
    ];
    expect(combinedReason(flags, null)).toBe("Seminar Room 3-01: Exits blocked; PA system × 2: Move it");
    expect(combinedReason(flags.slice(0, 1), "Update the crowd plan.")).toBe(
      "Seminar Room 3-01: Exits blocked. General: Update the crowd plan.",
    );
  });
});

describe("flags", () => {
  it("only flags this event's live arrangements", () => {
    const ended = { type: "venue_booking" as const, id: 33, note: "x" };
    expect(resolveFlags([ended], bookings, equipmentRequests)).toEqual({ ok: false, unknown: [ended] });
    expect(resolveFlags([{ type: "equipment_item", id: 999, note: "x" }], bookings, equipmentRequests).ok).toBe(false);
  });

  it("snapshots each arrangement with its label and note", () => {
    expect(resolveFlags(validBody.arrangements as never, bookings, equipmentRequests)).toEqual({
      ok: true,
      flags: expectedFlags,
    });
  });

  it("AC3: a flag clears when its arrangement changes or disappears, not otherwise", () => {
    const flag = { arrangement_type: "venue_booking" as const, arrangement_id: 32, snapshot: { status: "Approved" } };
    expect(hasChanged(flag, currentArrangements(bookings, equipmentRequests))).toBe(false);

    const released = bookings.map((b) => (b.id === 32 ? { ...b, status: "Withdrawn" } : b));
    expect(hasChanged(flag, currentArrangements(released, equipmentRequests))).toBe(true);

    const item = {
      arrangement_type: "equipment_item" as const,
      arrangement_id: 51,
      snapshot: { equipmentType: "PA system", quantity: 2, quantityFulfilled: 2 },
    };
    const fewer = [{ ...equipmentRequests[0], items: [{ ...equipmentRequests[0].items[0], quantity: 1, quantityFulfilled: 1 }] }];
    expect(hasChanged(item, currentArrangements(bookings, fewer))).toBe(true);
    expect(hasChanged(item, currentArrangements(bookings, []))).toBe(true);
  });
});

describe("POST /api/events/:id/safety-review/request-changes (E3-14)", () => {
  it("AC1: returns the event to Planning and records the decision, the officer, each note and the flags", async () => {
    const { app, rpc } = buildApp();
    const res = await requestChanges(app);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Planning");
    expect(res.body.reviewId).toBe(903);
    expect(rpc).toHaveBeenCalledWith("request_event_safety_changes", {
      p_event_id: 7,
      p_officer_id: "SAF-0001",
      p_reason: expectedReason,
      p_general_note: "Send an updated crowd plan.",
      p_flags: expectedFlags,
    });
  });

  it("AC1: notifies only the assigned coordinator, with each arrangement and what must change", async () => {
    const { app, publish } = buildApp();
    await requestChanges(app);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "safety.decided",
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: expect.objectContaining({
          outcome: "changes_requested",
          reason: expectedReason,
        }),
      }),
    );
  });

  it.each([
    ["no arrangement", { arrangements: [], generalNote: "Move the PA" }],
    ["an arrangement without a note", { arrangements: [{ type: "venue_booking", id: 32, note: " " }] }],
  ])("AC2: blocks a request with %s", async (_label, body) => {
    const { app, rpc, fetchMock } = buildApp();
    const res = await requestChanges(app, body);

    expect(res.status).toBe(400);
    expect(res.body.fields).toBeDefined();
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks an arrangement that isn't this event's", async () => {
    const { app, rpc } = buildApp();
    const res = await requestChanges(app, { arrangements: [{ type: "venue_booking", id: 999, note: "x" }] });

    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["Draft", "Unassigned", "Requested", "Clarification Requested", "Planning", "Confirmed", "Rejected", "Cancelled", "Completed"])(
    "AC4: blocks an event in %s",
    async (status) => {
      const { app, rpc } = buildApp({ status });
      const res = await requestChanges(app);

      expect(res.status).toBe(409);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it.each(["coordinator", "organiser", "coordinator_lead", "venue_staff", "technical_support", "attendee"])(
    "AC4: blocks the %s role, even calling the API directly",
    async (role) => {
      const { app, rpc } = buildApp({ user: { id: "USR-0001", role } });
      const res = await requestChanges(app);

      expect(res.status).toBe(403);
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("returns 409 when the event left Safety Review between the check and the write", async () => {
    const { app, publish } = buildApp({ reviewId: null });
    expect((await requestChanges(app)).status).toBe(409);
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns 502 without deciding when the arrangements can't be read", async () => {
    const { app, rpc } = buildApp({ arrangementsFail: true });
    expect((await requestChanges(app)).status).toBe(502);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns 500 when the decision can't be written", async () => {
    const { app } = buildApp({ rpcError: true });
    expect((await requestChanges(app)).status).toBe(500);
  });
});

describe("GET /api/events/:id/safety-changes (AC3)", () => {
  const latestReview = {
    id: 903,
    outcome: "Changes Requested",
    reason: "Seminar Room 3-01: Exits blocked.; PA system × 2: Move it.. General: Update the crowd plan.",
    general_note: "Update the crowd plan.",
    created_at: "2026-10-15T06:32:00.000Z",
    officer: { name: "Sam Tan" },
  };
  const flags = [
    {
      id: 1,
      arrangement_type: "venue_booking",
      arrangement_id: 32,
      label: "Seminar Room 3-01",
      note: "Exits blocked.",
      snapshot: { status: "Approved" },
      cleared_at: null,
    },
    {
      id: 2,
      arrangement_type: "equipment_item",
      arrangement_id: 51,
      label: "PA system × 2",
      note: "Move it.",
      snapshot: { equipmentType: "PA system", quantity: 2, quantityFulfilled: 2 },
      cleared_at: null,
    },
  ];

  function getChanges(app: express.Express) {
    return request(app).get("/api/events/7/safety-changes").set("Authorization", "Bearer t");
  }

  it("shows the coordinator the officer's name, time, each flag with its note, and the general note", async () => {
    const { app } = buildApp({ user: coordinator, latestReview, flags });
    const res = await getChanges(app);

    expect(res.status).toBe(200);
    expect(res.body.changeRequest).toMatchObject({
      reviewId: 903,
      officerName: "Sam Tan",
      requestedAt: "2026-10-15T06:32:00.000Z",
      generalNote: "Update the crowd plan.",
      arrangementsChecked: true,
      flags: [
        { type: "venue_booking", id: 32, label: "Seminar Room 3-01", note: "Exits blocked.", clearedAt: null },
        { type: "equipment_item", id: 51, label: "PA system × 2", note: "Move it.", clearedAt: null },
      ],
    });
  });

  it("clears the flag of an arrangement that changed, and only that one", async () => {
    const released = bookings.map((b) => (b.id === 32 ? { ...b, status: "Withdrawn" } : b));
    const { app, flagUpdate, tables } = buildApp({ user: coordinator, latestReview, flags, currentBookings: released });
    const res = await getChanges(app);

    expect(tables.event_safety_review_flags.update).toHaveBeenCalledWith({ cleared_at: expect.any(String) });
    expect(flagUpdate.in).toHaveBeenCalledWith("id", [1]);
    const [booking, equipment] = res.body.changeRequest.flags;
    expect(booking.clearedAt).not.toBeNull();
    expect(equipment.clearedAt).toBeNull();
  });

  it("keeps the flags as they are when the arrangements can't be read", async () => {
    const { app, tables } = buildApp({ user: coordinator, latestReview, flags, arrangementsFail: true });
    const res = await getChanges(app);

    expect(res.body.changeRequest.arrangementsChecked).toBe(false);
    expect(tables.event_safety_review_flags.update).not.toHaveBeenCalled();
  });

  it("has nothing to show once a later decision supersedes the change request", async () => {
    const { app } = buildApp({ user: coordinator, latestReview: { ...latestReview, outcome: "Approved" }, flags });
    expect((await getChanges(app)).body.changeRequest).toBeNull();
  });

  it.each(["organiser", "venue_staff", "technical_support", "attendee"])("is not for the %s role", async (role) => {
    const { app } = buildApp({ user: { id: "USR-0001", role }, latestReview, flags });
    expect((await getChanges(app)).status).toBe(403);
  });
});

describe("GET /api/events/:id for the Safety Officer", () => {
  it("lets them read an event that was submitted for safety review", async () => {
    const { app } = buildApp({ hasSubmission: true });
    expect((await request(app).get("/api/events/7").set("Authorization", "Bearer t")).status).toBe(200);
  });

  it("still refuses an event never submitted for safety review", async () => {
    const { app } = buildApp({ hasSubmission: false });
    expect((await request(app).get("/api/events/7").set("Authorization", "Bearer t")).status).toBe(403);
  });
});
