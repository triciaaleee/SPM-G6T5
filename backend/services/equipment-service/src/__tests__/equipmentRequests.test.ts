import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { equipmentRequestsRouter } from "../routes/equipmentRequests.js";
import { validateAmendedItems, validateEquipmentItems, validateStatusUpdate } from "../lib/validateEquipmentRequest.js";
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

const coordinator = { id: "COORD-0001", role: "coordinator" };
const technicalSupport = { id: "TS-0001", role: "technical_support" };
const organiser = { id: "ORG-0001", role: "organiser" };

/** A supabase-js style query: every filter returns the query, and awaiting it yields `result`. */
function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "order", "in"]) q[method] = vi.fn(() => q);
  q.single = vi.fn().mockResolvedValue(result);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

/**
 * A minimal in-memory table: enough `eq`/`neq`/`in`/`order`/`limit` filtering
 * to let the real claim/release/flag logic (lib/equipmentConflicts.ts,
 * lib/reservationFlags.ts) run against it unmocked, same as production.
 * Used for `equipment_requests`, `equipment_request_items`, `equipment` and
 * `equipment_booking` — every table this story's logic actually reads/writes
 * beyond a single canned response.
 */
function recordTable(seedRows: Record<string, unknown>[]) {
  let rows = [...seedRows];
  let nextId = rows.reduce((max, r) => Math.max(max, Number(r.id ?? 0)), 0) + 1;

  function makeQuery(initialRows: Record<string, unknown>[]) {
    let filtered = initialRows;
    const q: Record<string, any> = {};
    q.eq = vi.fn((field: string, value: unknown) => {
      filtered = filtered.filter((r) => r[field] === value);
      return q;
    });
    q.neq = vi.fn((field: string, value: unknown) => {
      filtered = filtered.filter((r) => r[field] !== value);
      return q;
    });
    q.in = vi.fn((field: string, values: unknown[]) => {
      filtered = filtered.filter((r) => values.includes(r[field]));
      return q;
    });
    q.order = vi.fn((field: string, opts?: { ascending?: boolean }) => {
      filtered = [...filtered].sort((a, b) => {
        const av = Number(a[field]);
        const bv = Number(b[field]);
        return opts?.ascending === false ? bv - av : av - bv;
      });
      return q;
    });
    q.limit = vi.fn((n: number) => {
      filtered = filtered.slice(0, n);
      return q;
    });
    q.maybeSingle = vi.fn(async () => ({ data: filtered[0] ?? null, error: null }));
    q.single = vi.fn(async () => ({ data: filtered[0] ?? null, error: null }));
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    return q;
  }

  return {
    select: vi.fn(() => makeQuery(rows)),
    insert: vi.fn((payload: Record<string, unknown> | Record<string, unknown>[]) => {
      const inserted = (Array.isArray(payload) ? payload : [payload]).map((item) => ({ id: nextId++, ...item }));
      rows.push(...inserted);
      const q: Record<string, any> = {};
      q.select = vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: inserted, error: null }).then(resolve),
      }));
      q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: inserted, error: null }).then(resolve, reject);
      return q;
    }),
    delete: vi.fn(() => {
      const q: Record<string, any> = {};
      q.eq = vi.fn((field: string, value: unknown) => {
        rows = rows.filter((r) => r[field] !== value);
        return q;
      });
      q.in = vi.fn((field: string, values: unknown[]) => {
        rows = rows.filter((r) => !values.includes(r[field]));
        return q;
      });
      q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: null }).then(resolve, reject);
      return q;
    }),
    update: vi.fn((patch: Record<string, unknown>) => {
      let matched: Record<string, unknown>[] = [];
      const q: Record<string, any> = {};
      q.eq = vi.fn((field: string, value: unknown) => {
        matched = rows.filter((r) => r[field] === value);
        for (const row of matched) Object.assign(row, patch);
        return q;
      });
      q.select = vi.fn(() => ({
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: matched, error: null }).then(resolve),
      }));
      q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve({ data: matched, error: null }).then(resolve, reject);
      return q;
    }),
    get rows() {
      return rows;
    },
  };
}

const validItems = [{ equipmentCatalogId: 1, quantity: 2 }];
const defaultCatalogRows = [{ id: 1, name: "Projector" }];

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    status: "Planning",
    coordinator_id: "COORD-0001",
    submitted_details: { name: "Alumni Gala", proposedDate: "2026-09-20", startTime: "09:00", endTime: "12:00" },
    ...overrides,
  };
}

const defaultBookingInfoEvents = [
  { id: 7, name: "Alumni Gala", proposedDate: "2026-09-20", startTime: "09:00", endTime: "12:00" },
];

const defaultEquipmentRows = [
  { id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 },
  { id: 202, type: "Projector", status: "Available", equipment_catalog_id: 1 },
  { id: 203, type: "Projector", status: "Available", equipment_catalog_id: 1 },
];

function buildApp(
  options: {
    user?: { id: string; role: string };
    eventStatus?: number;
    event?: Record<string, unknown> | null;
    catalogRows?: Record<string, unknown>[];
    insertRequestError?: boolean;
    insertItemsError?: boolean;
    requests?: Record<string, unknown>[];
    items?: Record<string, unknown>[];
    technicalSupportStaff?: { id: string }[];
    notificationsStatus?: number;
    bookingInfoEvents?: Record<string, unknown>[];
    updatedRequest?: Record<string, unknown> | null;
    applyError?: { message: string } | null;
    releaseError?: { message: string } | null;
    /** What the amend_equipment_request / release_equipment_for_request functions answer (migration 0042). */
    amendOutcome?: Record<string, unknown>;
    amendError?: { message: string } | null;
    cancelOutcome?: Record<string, unknown>;
    cancelError?: { message: string } | null;
    equipmentRows?: Record<string, unknown>[];
    equipmentBookingRows?: Record<string, unknown>[];
    /** E5-5: periods Technical Support marked on units (migration 0043). */
    unavailabilityRows?: Record<string, unknown>[];
    /** What /api/users/names answers for requestedBy — defaults to no names resolved. */
    userNames?: { id: string; name: string }[];
  } = {},
) {
  const requestInsert = vi.fn((row: Record<string, unknown>) =>
    query({
      data: options.insertRequestError
        ? null
        : { id: 55, event_id: row.event_id, status: "Requested", created_at: "2026-01-01T00:00:00Z" },
      error: options.insertRequestError ? { message: "boom" } : null,
    }),
  );
  const itemsInsert = vi.fn((rows: Record<string, unknown>[]) =>
    query({
      data: options.insertItemsError ? null : rows.map((row, i) => ({ id: 100 + i, ...row })),
      error: options.insertItemsError ? { message: "boom" } : null,
    }),
  );
  const deleteQuery = query({ data: null, error: null });
  const usersSelect = query({ data: options.technicalSupportStaff ?? [], error: null });
  const catalogSelect = query({ data: options.catalogRows ?? defaultCatalogRows, error: null });

  const requestsSeed =
    options.requests ??
    (options.updatedRequest !== undefined
      ? options.updatedRequest === null
        ? []
        : [options.updatedRequest]
      : [
          {
            id: 55,
            event_id: 7,
            coordinator_id: "COORD-0001",
            status: "Arranged",
            fulfillment_note: null,
            created_at: "2026-01-01T00:00:00Z",
          },
        ]);
  const requestsTable = recordTable(requestsSeed);
  const itemsTable = recordTable(options.items ?? []);
  const equipmentTable = recordTable(options.equipmentRows ?? defaultEquipmentRows);
  // A booking holds its unit unless it was Released (migration 0052), so fixtures default to Reserved.
  const equipmentBookingTable = recordTable((options.equipmentBookingRows ?? []).map((row) => ({ status: "Reserved", ...row })));
  const unavailabilityTable = recordTable(options.unavailabilityRows ?? []);

  const rpcMock = vi.fn(async (fn: string, _args?: Record<string, unknown>) => {
    if (fn === "release_equipment_for_event") return { data: null, error: options.releaseError ?? null };
    if (fn === "amend_equipment_request") {
      return { data: options.amendOutcome ?? { status: "Requested", changes: [] }, error: options.amendError ?? null };
    }
    if (fn === "release_equipment_for_request") {
      return { data: options.cancelOutcome ?? { released: [] }, error: options.cancelError ?? null };
    }
    return { data: null, error: options.applyError ?? null };
  });

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "equipment_requests") {
        return {
          insert: requestInsert,
          select: requestsTable.select,
          delete: vi.fn(() => deleteQuery),
          update: requestsTable.update,
        };
      }
      if (table === "equipment_request_items") {
        return { insert: itemsInsert, select: itemsTable.select };
      }
      if (table === "equipment_catalog") {
        return { select: catalogSelect.select };
      }
      if (table === "users") {
        return { select: usersSelect.select };
      }
      if (table === "equipment") {
        return { select: equipmentTable.select };
      }
      if (table === "equipment_booking") {
        return {
          select: equipmentBookingTable.select,
          insert: equipmentBookingTable.insert,
          delete: equipmentBookingTable.delete,
          update: vi.fn(() => {
            const chain: Record<string, any> = {};
            chain.eq = vi.fn(() => chain);
            chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
            return chain;
          }),
        };
      }
      if (table === "equipment_unavailability") {
        return { select: unavailabilityTable.select };
      }
      throw new Error(`unexpected table ${table}`);
    }),
    rpc: rpcMock,
  };

  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("venue-booking-info")) {
      return { ok: true, status: 200, json: async () => ({ events: options.bookingInfoEvents ?? defaultBookingInfoEvents }) };
    }
    if (url.includes("/api/users/names")) {
      return { ok: true, status: 200, json: async () => ({ users: options.userNames ?? [] }) };
    }
    if (url.includes("/api/events/")) {
      const status = options.eventStatus ?? 200;
      if (status === 403 || status === 404) return { ok: false, status, json: async () => ({}) };
      if (!(status < 300)) return { ok: false, status, json: async () => ({}) };
      return { ok: true, status, json: async () => ({ event: options.event === undefined ? eventRow() : options.event }) };
    }
    const status = options.notificationsStatus ?? 201;
    return { ok: status < 300, status, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);

  const publish = vi.fn().mockResolvedValue((options.notificationsStatus ?? 201) < 300);
  setPublisherForTest({ publish });

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? coordinator;

  const app = express();
  app.use(express.json());
  app.use("/api/equipment-requests", equipmentRequestsRouter);
  return {
    app,
    supabase,
    requestInsert,
    itemsInsert,
    deleteQuery,
    rpcMock,
    fetchMock,
    publish,
    requestsTable,
    itemsTable,
    equipmentTable,
    equipmentBookingTable,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("validateEquipmentItems", () => {
  it("accepts a well-formed item list", () => {
    const result = validateEquipmentItems(validItems);
    expect(result).toEqual({
      valid: true,
      fields: {},
      value: [{ equipmentCatalogId: 1, quantity: 2 }],
    });
  });

  it("requires at least one item", () => {
    expect(validateEquipmentItems([])).toEqual({ valid: false, fields: { items: expect.any(String) } });
    expect(validateEquipmentItems("not an array")).toEqual({ valid: false, fields: { items: expect.any(String) } });
  });

  // AC3: a quantity of zero or less blocks submission.
  it.each([0, -1, -5])("rejects a quantity of %i", (quantity) => {
    const result = validateEquipmentItems([{ equipmentCatalogId: 1, quantity }]);
    expect(result.valid).toBe(false);
    expect(result.fields["items[0].quantity"]).toMatch(/greater than zero/);
  });

  it("rejects a non-integer quantity", () => {
    const result = validateEquipmentItems([{ equipmentCatalogId: 1, quantity: 1.5 }]);
    expect(result.valid).toBe(false);
    expect(result.fields["items[0].quantity"]).toMatch(/whole number/);
  });

  it("requires equipmentCatalogId", () => {
    const result = validateEquipmentItems([{ quantity: 1 }]);
    expect(result.valid).toBe(false);
    expect(result.fields["items[0].equipmentCatalogId"]).toBeDefined();
  });

  it("collects every item's errors in one pass", () => {
    const result = validateEquipmentItems([{ quantity: 0 }, { equipmentCatalogId: 1, quantity: -1 }]);
    expect(!result.valid && Object.keys(result.fields).sort()).toEqual([
      "items[0].equipmentCatalogId",
      "items[0].quantity",
      "items[1].quantity",
    ]);
  });
});

describe("POST /api/equipment-requests (E5-1)", () => {
  it("rejects a non-coordinator", async () => {
    const { app } = buildApp({ user: technicalSupport });
    const res = await request(app).post("/api/equipment-requests").send({ eventId: 7, items: validItems });
    expect(res.status).toBe(403);
  });

  it("rejects a missing/invalid eventId", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/equipment-requests").send({ items: validItems });
    expect(res.status).toBe(400);
  });

  it("surfaces item validation errors (AC3: quantity <= 0 blocked)", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post("/api/equipment-requests")
      .send({ eventId: 7, items: [{ equipmentCatalogId: 1, quantity: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.fields["items[0].quantity"]).toBeDefined();
  });

  it("rejects an equipmentCatalogId that doesn't exist in the catalog", async () => {
    const { app } = buildApp({ catalogRows: [] });
    const res = await request(app).post("/api/equipment-requests").send({ eventId: 7, items: validItems });
    expect(res.status).toBe(400);
    expect(res.body.fields["items[0].equipmentCatalogId"]).toBeDefined();
  });

  it("404s when the event doesn't exist", async () => {
    const { app } = buildApp({ eventStatus: 404 });
    const res = await request(app).post("/api/equipment-requests").send({ eventId: 7, items: validItems });
    expect(res.status).toBe(404);
  });

  it("blocks a coordinator who isn't the assigned coordinator", async () => {
    const { app } = buildApp({ event: eventRow({ coordinator_id: "COORD-9999" }) });
    const res = await request(app).post("/api/equipment-requests").send({ eventId: 7, items: validItems });
    expect(res.status).toBe(403);
  });

  // AC1: "Given an event in Planning".
  it("blocks recording requirements outside Planning", async () => {
    const { app } = buildApp({ event: eventRow({ status: "Requested" }) });
    const res = await request(app).post("/api/equipment-requests").send({ eventId: 7, items: validItems });
    expect(res.status).toBe(409);
  });

  it("records the request and items against their catalog entry, and publishes equipment.requested for Technical Support", async () => {
    const { app, requestInsert, itemsInsert, publish } = buildApp();

    const res = await request(app)
      .post("/api/equipment-requests")
      .set("Authorization", "Bearer token123")
      .send({ eventId: 7, items: validItems });

    expect(res.status).toBe(201);
    expect(requestInsert).toHaveBeenCalledWith({ event_id: 7, coordinator_id: "COORD-0001" });
    expect(itemsInsert).toHaveBeenCalledWith([
      { request_id: 55, equipment_catalog_id: 1, equipment_type: "Projector", quantity: 2 },
    ]);
    expect(res.body.equipmentRequest).toMatchObject({
      id: 55,
      eventId: 7,
      status: "Requested",
      items: [{ equipmentType: "Projector", quantity: 2 }],
    });
    expect(res.body.notified).toBe(true);

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "equipment.requested",
        eventId: 7,
        actorId: "COORD-0001",
        recipients: { userIds: [], roles: ["technical_support"] },
        data: expect.objectContaining({ itemCount: 1 }),
      }),
    );
  });

  it("reports notified:false when notification-service fails, without failing the request", async () => {
    const { app } = buildApp({ technicalSupportStaff: [{ id: "TS-0001" }], notificationsStatus: 500 });
    const res = await request(app).post("/api/equipment-requests").send({ eventId: 7, items: validItems });
    expect(res.status).toBe(201);
    expect(res.body.notified).toBe(false);
  });

  it("cleans up the request row if the items insert fails", async () => {
    const { app, deleteQuery } = buildApp({ insertItemsError: true });
    const res = await request(app).post("/api/equipment-requests").send({ eventId: 7, items: validItems });
    expect(res.status).toBe(500);
    expect(deleteQuery.eq).toHaveBeenCalledWith("id", 55);
  });
});

const NO_FLAG = { flagged: false, reason: null };

describe("GET /api/equipment-requests (E5-1 AC1)", () => {
  it("requires eventId for a coordinator", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/equipment-requests");
    expect(res.status).toBe(400);
  });

  it("404s a coordinator when the event isn't theirs to see", async () => {
    const { app } = buildApp({ eventStatus: 404 });
    const res = await request(app).get("/api/equipment-requests?eventId=7");
    expect(res.status).toBe(404);
  });

  it("returns one event's requests with their items for a coordinator", async () => {
    const { app } = buildApp({
      requests: [{ id: 55, event_id: 7, status: "Requested", created_at: "2026-01-01T00:00:00Z" }],
      items: [
        {
          id: 1,
          request_id: 55,
          equipment_type: "Projector",
          quantity: 2,
          quantity_fulfilled: 0,
          equipment_catalog_id: 1,
        },
      ],
    });
    const res = await request(app).get("/api/equipment-requests?eventId=7");
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests).toEqual([
      {
        id: 55,
        eventId: 7,
        status: "Requested",
        fulfillmentNote: null,
        createdAt: "2026-01-01T00:00:00Z",
        items: [{ id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0, reservationFlag: NO_FLAG, reservedUnits: [] }],
      },
    ]);
  });

  // The owning organiser has no form to submit a request, but still needs to
  // see arrangement status (E3-1 AC3's "Outstanding Arrangements" line).
  it("allows the owning organiser to view one event's requests", async () => {
    const { app } = buildApp({
      user: { id: "ORG-0001", role: "organiser" },
      requests: [{ id: 55, event_id: 7, status: "Arranged", created_at: "2026-01-01T00:00:00Z" }],
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 2, equipment_catalog_id: 1 }],
    });
    const res = await request(app).get("/api/equipment-requests?eventId=7");
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests).toEqual([
      {
        id: 55,
        eventId: 7,
        status: "Arranged",
        fulfillmentNote: null,
        createdAt: "2026-01-01T00:00:00Z",
        items: [{ id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 2, reservationFlag: NO_FLAG, reservedUnits: [] }],
      },
    ]);
  });

  it("404s an organiser when the event isn't theirs to see", async () => {
    const { app } = buildApp({ user: { id: "ORG-0001", role: "organiser" }, eventStatus: 404 });
    const res = await request(app).get("/api/equipment-requests?eventId=7");
    expect(res.status).toBe(404);
  });

  // E3-14: the Safety Officer reads an event's equipment to flag what must
  // change; events-service decides which events they may see.
  it("allows the Safety Officer to view one event's requests", async () => {
    const { app } = buildApp({
      user: { id: "SAF-0001", role: "safety_officer" },
      requests: [{ id: 55, event_id: 7, status: "Arranged", created_at: "2026-01-01T00:00:00Z" }],
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 2, equipment_catalog_id: 1 }],
    });
    const res = await request(app).get("/api/equipment-requests?eventId=7");
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests[0].items[0]).toMatchObject({ id: 1, equipmentType: "Projector" });
  });

  it("404s the Safety Officer for an event events-service won't show them", async () => {
    const { app } = buildApp({ user: { id: "SAF-0001", role: "safety_officer" }, eventStatus: 404 });
    expect((await request(app).get("/api/equipment-requests?eventId=7")).status).toBe(404);
  });

  it("rejects a role that is neither coordinator nor technical support", async () => {
    const { app } = buildApp({ user: { id: "VEN-0001", role: "venue_staff" } });
    const res = await request(app).get("/api/equipment-requests");
    expect(res.status).toBe(403);
  });

  it("returns every request with event info for Technical Support", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [{ id: 55, event_id: 7, status: "Requested", created_at: "2026-01-01T00:00:00Z" }],
      items: [
        { id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0, equipment_catalog_id: 1 },
      ],
      bookingInfoEvents: [
        {
          id: 7,
          name: "Alumni Gala",
          proposedDate: "2026-02-01",
          startTime: "18:00",
          endTime: "21:00",
          venue: "Grand Ballroom",
          equipment: "2 projectors",
          technicalSupport: "Wireless mics",
          coordinatorId: "COORD-0001",
          expectedAttendance: 300,
          organiser: { name: "Pat Organiser" },
        },
      ],
    });
    const res = await request(app).get("/api/equipment-requests");
    expect(res.status).toBe(200);
    // E5-1 AC1: only the event's name, date, time and venue reach Technical Support.
    expect(res.body.equipmentRequests).toEqual([
      {
        id: 55,
        eventId: 7,
        status: "Requested",
        fulfillmentNote: null,
        createdAt: "2026-01-01T00:00:00Z",
        items: [{ id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0, reservationFlag: NO_FLAG, reservedUnits: [] }],
        event: {
          id: 7,
          name: "Alumni Gala",
          proposedDate: "2026-02-01",
          startTime: "18:00",
          endTime: "21:00",
          venue: "Grand Ballroom",
        },
      },
    ]);
  });

  // E5-6 AC3: a unit already claimed by this request now overlaps a rival
  // event's claim on the same unit, because one of the two events' schedule
  // changed after both claims were made.
  it("flags an item whose claimed unit now conflicts with another event's claim", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [{ id: 55, event_id: 7, status: "Arranged", created_at: "2026-01-01T00:00:00Z" }],
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 1, equipment_catalog_id: 1 }],
      equipmentBookingRows: [
        { id: 900, equipment_id: 201, event_id: 7, request_item_id: 1 },
        { id: 901, equipment_id: 201, event_id: 20, request_item_id: null },
      ],
      bookingInfoEvents: [
        { id: 7, name: "Alumni Gala", proposedDate: "2026-09-20", startTime: "09:00", endTime: "12:00" },
        { id: 20, name: "Design Showcase", proposedDate: "2026-09-20", startTime: "10:00", endTime: "11:00" },
      ],
    });
    const res = await request(app).get("/api/equipment-requests");
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests[0].items[0].reservationFlag.flagged).toBe(true);
  });

  it("does not flag an item whose claimed unit's rival event no longer overlaps", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [{ id: 55, event_id: 7, status: "Arranged", created_at: "2026-01-01T00:00:00Z" }],
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 1, equipment_catalog_id: 1 }],
      equipmentBookingRows: [
        { id: 900, equipment_id: 201, event_id: 7, request_item_id: 1 },
        { id: 901, equipment_id: 201, event_id: 20, request_item_id: null },
      ],
      bookingInfoEvents: [
        { id: 7, name: "Alumni Gala", proposedDate: "2026-09-20", startTime: "09:00", endTime: "12:00" },
        { id: 20, name: "Design Showcase", proposedDate: "2026-09-22", startTime: "10:00", endTime: "11:00" },
      ],
    });
    const res = await request(app).get("/api/equipment-requests");
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests[0].items[0].reservationFlag).toEqual(NO_FLAG);
  });
});

describe("GET /api/equipment-requests/event/:eventId (E5-1 AC1, AC2)", () => {
  const infoEvent = {
    id: 7,
    name: "Alumni Gala",
    proposedDate: "2026-02-01",
    startTime: "18:00",
    endTime: "21:00",
    venue: "Grand Ballroom",
    equipment: "2 projectors",
    technicalSupport: "  Wireless mics and a lectern mic.  ",
    coordinatorId: "COORD-0001",
    expectedAttendance: 300,
    accessibility: "Step-free entry",
  };
  const requestRow = { id: 55, event_id: 7, status: "Requested", created_at: "2026-01-01T00:00:00Z" };
  const itemRow = { id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0, equipment_catalog_id: 1 };

  it("shows the equipment, quantities, technical requirements and only the event's name, date, time and venue", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [requestRow],
      items: [itemRow],
      bookingInfoEvents: [infoEvent],
    });
    const res = await request(app).get("/api/equipment-requests/event/7");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      event: {
        id: 7,
        name: "Alumni Gala",
        proposedDate: "2026-02-01",
        startTime: "18:00",
        endTime: "21:00",
        venue: "Grand Ballroom",
      },
      technicalRequirements: "Wireless mics and a lectern mic.",
      equipmentRequests: [
        {
          id: 55,
          eventId: 7,
          status: "Requested",
          fulfillmentNote: null,
          createdAt: "2026-01-01T00:00:00Z",
          items: [{ id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0, reservationFlag: NO_FLAG, reservedUnits: [] }],
          requestedBy: null,
        },
      ],
    });
    // Nothing else about the event or its people leaks through — requestedBy is the one deliberate exception,
    // and this request has no coordinator_id of its own, so even that stays null.
    expect(JSON.stringify(res.body)).not.toMatch(/COORD-0001|expectedAttendance|accessibility|Step-free/);
  });

  it("includes which coordinator raised the request, resolving their name via user-service", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [{ ...requestRow, coordinator_id: "COORD-0002" }],
      items: [itemRow],
      bookingInfoEvents: [infoEvent],
      userNames: [{ id: "COORD-0002", name: "Priya Shah" }],
    });
    const res = await request(app).get("/api/equipment-requests/event/7");

    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests[0].requestedBy).toEqual({ id: "COORD-0002", name: "Priya Shah" });
  });

  it("falls back to the coordinator's id, not a 500, when the name lookup fails", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [{ ...requestRow, coordinator_id: "COORD-0002" }],
      items: [itemRow],
      bookingInfoEvents: [infoEvent],
      userNames: [],
    });
    const res = await request(app).get("/api/equipment-requests/event/7");

    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests[0].requestedBy).toEqual({ id: "COORD-0002", name: null });
  });

  it("includes which physical units are currently reserved for an item", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [requestRow],
      items: [itemRow],
      bookingInfoEvents: [infoEvent],
      equipmentRows: [{ id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1, label: "Projector #12" }],
      equipmentBookingRows: [{ equipment_id: 201, event_id: 7, request_item_id: 1 }],
    });
    const res = await request(app).get("/api/equipment-requests/event/7");

    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests[0].items[0].reservedUnits).toEqual([{ id: 201, label: "Projector #12" }]);
  });

  it("has no technical requirements when the organiser wrote none", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [requestRow],
      items: [itemRow],
      bookingInfoEvents: [{ ...infoEvent, technicalSupport: "   " }],
    });
    const res = await request(app).get("/api/equipment-requests/event/7");

    expect(res.status).toBe(200);
    expect(res.body.technicalRequirements).toBeNull();
  });

  it("denies access to an event with no equipment request", async () => {
    const { app } = buildApp({ user: technicalSupport, requests: [], bookingInfoEvents: [infoEvent] });
    const res = await request(app).get("/api/equipment-requests/event/7");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
  });

  it("denies a malformed event id", async () => {
    const { app } = buildApp({ user: technicalSupport });
    const res = await request(app).get("/api/equipment-requests/event/abc");

    expect(res.status).toBe(403);
  });

  it.each([
    ["coordinator", coordinator],
    ["organiser", { id: "ORG-0001", role: "organiser" }],
    ["venue_staff", { id: "VEN-0001", role: "venue_staff" }],
  ])("is for Technical Support only: denies %s", async (_role, user) => {
    const { app } = buildApp({ user, requests: [requestRow], items: [itemRow], bookingInfoEvents: [infoEvent] });
    const res = await request(app).get("/api/equipment-requests/event/7");

    expect(res.status).toBe(403);
  });

  it("502s when events-service can't be reached for the event's timing", async () => {
    const { app, fetchMock } = buildApp({ user: technicalSupport, requests: [requestRow], items: [itemRow] });
    fetchMock.mockImplementation(async () => {
      throw new Error("down");
    });
    const res = await request(app).get("/api/equipment-requests/event/7");

    expect(res.status).toBe(502);
  });
});

describe("GET /api/equipment-requests/items/:itemId/unit-preview", () => {
  const requestRow = { id: 55, event_id: 7, status: "Requested", created_at: "2026-01-01T00:00:00Z" };
  const itemRow = { id: 1, request_id: 55, equipment_type: "Projector", quantity: 3, quantity_fulfilled: 0, equipment_catalog_id: 1 };

  it("picks free units for the quantity asked and reports them with their labels", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [requestRow],
      items: [itemRow],
      equipmentRows: [
        { id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1, label: "Projector #1" },
        { id: 202, type: "Projector", status: "Available", equipment_catalog_id: 1, label: "Projector #2" },
        { id: 203, type: "Projector", status: "Available", equipment_catalog_id: 1, label: null },
      ],
    });
    const res = await request(app).get("/api/equipment-requests/items/1/unit-preview?quantity=2");

    expect(res.status).toBe(200);
    expect(res.body.claimedIds).toEqual([201, 202]);
    expect(res.body.units).toEqual([
      { id: 201, label: "Projector #1" },
      { id: 202, label: "Projector #2" },
    ]);
    expect(res.body.availableCount).toBe(3);
    expect(res.body.shortfall).toBe(0);
  });

  it("reports a shortfall instead of picking units it doesn't have", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [requestRow],
      items: [itemRow],
      equipmentRows: [{ id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 }],
    });
    const res = await request(app).get("/api/equipment-requests/items/1/unit-preview?quantity=3");

    expect(res.status).toBe(200);
    expect(res.body.claimedIds).toEqual([201]);
    expect(res.body.availableCount).toBe(1);
    expect(res.body.shortfall).toBe(2);
  });

  it("only previews units beyond what the item already holds, so its own reservation never blocks itself", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [requestRow],
      items: [{ ...itemRow, quantity_fulfilled: 2 }],
      equipmentRows: [
        { id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 },
        { id: 202, type: "Projector", status: "Available", equipment_catalog_id: 1 },
        { id: 203, type: "Projector", status: "Available", equipment_catalog_id: 1 },
      ],
      // Already held by this very item — must not count as "blocking" a preview for the remaining 1.
      equipmentBookingRows: [
        { equipment_id: 201, event_id: 7, request_item_id: 1 },
        { equipment_id: 202, event_id: 7, request_item_id: 1 },
      ],
    });
    const res = await request(app).get("/api/equipment-requests/items/1/unit-preview?quantity=3");

    expect(res.status).toBe(200);
    expect(res.body.claimedIds).toEqual([203]);
    expect(res.body.availableCount).toBe(1);
    expect(res.body.shortfall).toBe(0);
  });

  it("never claims a unit already reserved for this event by another item", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [requestRow],
      items: [itemRow],
      equipmentRows: [
        { id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 },
        { id: 202, type: "Projector", status: "Available", equipment_catalog_id: 1 },
      ],
      equipmentBookingRows: [{ equipment_id: 201, event_id: 7, request_item_id: 999, window_start_ms: 0, window_end_ms: 1 }],
    });
    const res = await request(app).get("/api/equipment-requests/items/1/unit-preview?quantity=2");

    expect(res.status).toBe(200);
    expect(res.body.claimedIds).toEqual([202]);
    expect(res.body.availableCount).toBe(1);
    expect(res.body.shortfall).toBe(1);
  });

  it("returns immediately for a quantity of 0 without reserving or checking anything", async () => {
    const { app, fetchMock } = buildApp({ user: technicalSupport, requests: [requestRow], items: [itemRow] });
    const res = await request(app).get("/api/equipment-requests/items/1/unit-preview?quantity=0");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claimedIds: [], units: [], availableCount: 0, shortfall: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is for Technical Support only", async () => {
    const { app } = buildApp({ user: coordinator, requests: [requestRow], items: [itemRow] });
    const res = await request(app).get("/api/equipment-requests/items/1/unit-preview?quantity=1");

    expect(res.status).toBe(403);
  });

  it("404s for an item that doesn't exist", async () => {
    const { app } = buildApp({ user: technicalSupport, requests: [requestRow], items: [itemRow] });
    const res = await request(app).get("/api/equipment-requests/items/999/unit-preview?quantity=1");

    expect(res.status).toBe(404);
  });

  it("rejects an item that isn't linked to an equipment catalog item", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      requests: [requestRow],
      items: [{ ...itemRow, equipment_catalog_id: null }],
    });
    const res = await request(app).get("/api/equipment-requests/items/1/unit-preview?quantity=1");

    expect(res.status).toBe(409);
  });

  it("rejects a malformed quantity", async () => {
    const { app } = buildApp({ user: technicalSupport, requests: [requestRow], items: [itemRow] });
    const res = await request(app).get("/api/equipment-requests/items/1/unit-preview?quantity=abc");

    expect(res.status).toBe(400);
  });
});

describe("validateStatusUpdate", () => {
  it("accepts a plain status with no note, outside Partially Fulfilled", () => {
    expect(validateStatusUpdate({ status: "Arranged" }, [])).toEqual({
      valid: true,
      fields: {},
      value: { status: "Arranged", note: null, fulfillments: [] },
    });
  });

  it("rejects a status outside the fixed set", () => {
    const result = validateStatusUpdate({ status: "Done" }, []);
    expect(result.valid).toBe(false);
    expect(result.fields.status).toBeDefined();
  });

  // AC2: a note describing what remains outstanding is required.
  it("requires a note when partially fulfilled", () => {
    const result = validateStatusUpdate({ status: "Partially Fulfilled" }, []);
    expect(result.valid).toBe(false);
    expect(result.fields.note).toBeDefined();
  });

  it("requires a fulfilled quantity per item when partially fulfilled", () => {
    const result = validateStatusUpdate(
      { status: "Partially Fulfilled", note: "2 of 3 mics arrived" },
      [{ id: 1, quantity: 3 }],
    );
    expect(result.valid).toBe(false);
    expect(result.fields["fulfillments[1]"]).toBeDefined();
  });

  it("rejects a fulfilled quantity greater than what was requested", () => {
    const result = validateStatusUpdate(
      { status: "Partially Fulfilled", note: "note", fulfillments: [{ itemId: 1, fulfilledQuantity: 5 }] },
      [{ id: 1, quantity: 3 }],
    );
    expect(result.valid).toBe(false);
    expect(result.fields["fulfillments[1]"]).toBeDefined();
  });

  it("accepts partially fulfilled with a note and a fulfilled quantity per item", () => {
    expect(
      validateStatusUpdate(
        { status: "Partially Fulfilled", note: "2 of 3 mics arrived", fulfillments: [{ itemId: 1, fulfilledQuantity: 2 }] },
        [{ id: 1, quantity: 3 }],
      ),
    ).toEqual({
      valid: true,
      fields: {},
      value: { status: "Partially Fulfilled", note: "2 of 3 mics arrived", fulfillments: [{ itemId: 1, fulfilledQuantity: 2 }] },
    });
  });

  it("clears a stray note for any other status", () => {
    const result = validateStatusUpdate({ status: "Arranged", note: "ignored" }, []);
    expect(result.valid && result.value?.note).toBeNull();
  });
});

/** The arguments of the one reserve_equipment_request call a PATCH makes (migration 0049); undefined if it made none. */
function reserveArgs(rpcMock: { mock: { calls: unknown[][] } }) {
  const call = rpcMock.mock.calls.find(([fn]) => fn === "reserve_equipment_request");
  return call?.[1] as
    | { p_request_id: number; p_status: string; p_note: string | null; p_fulfillments: unknown[]; p_claims: { itemId: number; unitIds: number[] }[] }
    | undefined;
}

describe("PATCH /api/equipment-requests/:id (E5-3)", () => {
  const oneItem = [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0, equipment_catalog_id: 1 }];

  it("rejects a non-technical-support caller", async () => {
    const { app } = buildApp({ user: coordinator });
    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid id", async () => {
    const { app } = buildApp({ user: technicalSupport });
    const res = await request(app).patch("/api/equipment-requests/abc").send({ status: "Arranged" });
    expect(res.status).toBe(400);
  });

  it("404s when the request doesn't exist (no items)", async () => {
    const { app } = buildApp({ user: technicalSupport, items: [] });
    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });
    expect(res.status).toBe(404);
  });

  it("surfaces validation errors (AC2: note required for partial fulfilment)", async () => {
    const { app } = buildApp({ user: technicalSupport, items: oneItem });
    const res = await request(app)
      .patch("/api/equipment-requests/55")
      .send({ status: "Partially Fulfilled" });
    expect(res.status).toBe(400);
    expect(res.body.fields.note).toBeDefined();
  });

  // AC1: saving notifies the assigned coordinator and the new status is returned.
  it("updates the status via the atomic RPC and publishes equipment.status_changed to the assigned coordinator", async () => {
    const { app, rpcMock, publish } = buildApp({
      user: technicalSupport,
      items: oneItem,
      updatedRequest: {
        id: 55,
        event_id: 7,
        coordinator_id: "COORD-0001",
        status: "Arranged",
        fulfillment_note: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    const res = await request(app)
      .patch("/api/equipment-requests/55")
      .set("Authorization", "Bearer token123")
      .send({ status: "Arranged" });

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("reserve_equipment_request", {
      p_request_id: 55,
      p_status: "Arranged",
      p_note: null,
      p_fulfillments: [],
      p_claims: [{ itemId: 1, unitIds: [201, 202] }],
      p_window_start_ms: expect.any(Number),
      p_window_end_ms: expect.any(Number),
    });
    expect(res.body.equipmentRequest).toMatchObject({ id: 55, status: "Arranged", fulfillmentNote: null });
    expect(res.body.notified).toBe(true);

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "equipment.status_changed",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: expect.objectContaining({ status: "Arranged", eventName: "Alumni Gala" }),
      }),
    );
  });

  // E2-12 AC6: after a reassignment the new coordinator owns the event's
  // pending requests, so the update reaches them, not whoever made the request.
  it("notifies the event's current coordinator after a reassignment", async () => {
    const { app, publish } = buildApp({
      user: technicalSupport,
      items: oneItem,
      updatedRequest: {
        id: 55,
        event_id: 7,
        coordinator_id: "COORD-0001",
        status: "Arranged",
        fulfillment_note: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      bookingInfoEvents: [
        { id: 7, name: "Alumni Gala", proposedDate: "2026-09-20", startTime: "09:00", endTime: "12:00", coordinatorId: "COORD-0002" },
      ],
    });

    const res = await request(app)
      .patch("/api/equipment-requests/55")
      .set("Authorization", "Bearer token123")
      .send({ status: "Arranged" });

    expect(res.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: { userIds: ["COORD-0002"], roles: [] } }),
    );
  });

  // AC2: the coordinator is told what remains outstanding, and the RPC gets the exact
  // per-item fulfilled quantities that move stock.
  it("records a partial fulfilment with its note and per-item fulfilled quantities", async () => {
    const { app, rpcMock } = buildApp({
      user: technicalSupport,
      items: oneItem,
      updatedRequest: {
        id: 55,
        event_id: 7,
        coordinator_id: "COORD-0001",
        status: "Partially Fulfilled",
        fulfillment_note: "1 of 2 projectors arrived",
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    const res = await request(app)
      .patch("/api/equipment-requests/55")
      .send({ status: "Partially Fulfilled", note: "1 of 2 projectors arrived", fulfillments: [{ itemId: 1, fulfilledQuantity: 1 }] });

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("reserve_equipment_request", {
      p_request_id: 55,
      p_status: "Partially Fulfilled",
      p_note: "1 of 2 projectors arrived",
      p_fulfillments: [{ itemId: 1, fulfilledQuantity: 1 }],
      p_claims: [{ itemId: 1, unitIds: [201] }],
      p_window_start_ms: expect.any(Number),
      p_window_end_ms: expect.any(Number),
    });
    expect(res.body.equipmentRequest.fulfillmentNote).toBe("1 of 2 projectors arrived");
  });

  // Stock ran out between the stock table loading and Technical Support saving
  // (the RPC's own baseline check — still exercised after this story's
  // per-unit pre-check passes, since there's enough physical units but the
  // flat catalog counter disagrees).
  it("maps the RPC's insufficient-stock error to a 409", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      items: oneItem,
      applyError: { message: "Not enough stock available for item 1" },
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });
    expect(res.status).toBe(409);
  });

  // Picked by the application, then marked unusable (or taken for this event) before the database function ran.
  it.each(["Unit 201 is no longer available", "Unit 201 is already reserved for this event", "Unit 201 is not the requested equipment type",
    "Unit 201 is already booked for overlapping dates",
    "Unit 201 is unavailable during these dates",
  ])(
    "maps a unit that changed since it was picked to a 409 (%s)",
    async (message) => {
      const { app } = buildApp({ user: technicalSupport, items: oneItem, applyError: { message } });

      const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/taken or changed/);
    },
  );

  it("500s on any other failure of the reservation, without a second corrective call", async () => {
    const { app, rpcMock } = buildApp({ user: technicalSupport, items: oneItem, applyError: { message: "connection reset" } });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(500);
    expect(rpcMock.mock.calls.filter(([fn]) => fn === "reserve_equipment_request")).toHaveLength(1);
  });

  it("reports notified:false when notification-service fails, without failing the update", async () => {
    const { app } = buildApp({ user: technicalSupport, items: oneItem, notificationsStatus: 500 });
    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });
    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
  });
});

describe("PATCH /api/equipment-requests/:id (E5-6 reservation)", () => {
  const oneItem = [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0, equipment_catalog_id: 1 }];

  // AC1: saving the reservation deducts that quantity from availability for
  // the period and ties it to the event — specific physical units get claimed.
  it("claims specific units when an item is marked Arranged", async () => {
    const { app, rpcMock } = buildApp({ user: technicalSupport, items: oneItem });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(200);
    // The booking rows themselves are written by reserve_equipment_request (checked in supabase/scripts/test_equipment_stock.sql).
    const claims = reserveArgs(rpcMock)!.p_claims;
    expect(claims).toHaveLength(1);
    expect(claims[0].itemId).toBe(1);
    expect(claims[0].unitIds).toHaveLength(2);
    for (const id of claims[0].unitIds) expect([201, 202, 203]).toContain(id);
    expect(res.body.equipmentRequest.items[0].reservationFlag).toEqual(NO_FLAG);
  });

  // E5-5 AC1: a unit marked unusable for a period overlapping the event is never claimed for it.
  it("doesn't claim a unit that is marked unusable on the event's date, and claims it again outside the period", async () => {
    const unavailable = (end: string) => [
      { id: 1, equipment_id: 201, reason: "Damaged", start_date: "2026-09-19", end_date: end, note: null },
    ];

    const during = buildApp({ user: technicalSupport, items: oneItem, unavailabilityRows: unavailable("2026-09-21") });
    const res = await request(during.app).patch("/api/equipment-requests/55").send({ status: "Arranged" });
    expect(res.status).toBe(200);
    expect([...reserveArgs(during.rpcMock)!.p_claims[0].unitIds].sort()).toEqual([202, 203]);

    const after = buildApp({ user: technicalSupport, items: oneItem, unavailabilityRows: unavailable("2026-09-10") });
    await request(after.app).patch("/api/equipment-requests/55").send({ status: "Arranged" });
    const afterUnits = reserveArgs(after.rpcMock)!.p_claims[0].unitIds;
    expect(afterUnits).toHaveLength(2);
    expect(afterUnits).toContain(201);
  });

  it("rejects with the shortfall when the only free units are out for the event's date", async () => {
    const { app, equipmentBookingTable, rpcMock } = buildApp({
      user: technicalSupport,
      items: oneItem,
      equipmentRows: [
        { id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 },
        { id: 202, type: "Projector", status: "Available", equipment_catalog_id: 1 },
      ],
      unavailabilityRows: [{ id: 1, equipment_id: 202, reason: "Under Maintenance", start_date: "2026-09-01", end_date: null, note: null }],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(409);
    expect(res.body.shortfalls["1"]).toMatchObject({ availableCount: 1, shortfall: 1 });
    expect(equipmentBookingTable.rows).toHaveLength(0);
    expect(reserveArgs(rpcMock)).toBeUndefined();
  });

  // E5-5: a reserved unit that is unusable during its event is flagged for re-arrangement.
  it("flags a reservation whose unit is unusable during the event, with the reason", async () => {
    const { app } = buildApp({
      user: coordinator,
      requests: [{ id: 55, event_id: 7, status: "Arranged", created_at: "2026-01-01T00:00:00Z" }],
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 1, equipment_catalog_id: 1 }],
      equipmentBookingRows: [{ id: 1, equipment_id: 201, event_id: 7, request_item_id: 1 }],
      unavailabilityRows: [{ id: 1, equipment_id: 201, reason: "Damaged", start_date: "2026-09-19", end_date: null, note: null }],
    });

    const res = await request(app).get("/api/equipment-requests?eventId=7");

    expect(res.body.equipmentRequests[0].items[0].reservationFlag).toEqual({
      flagged: true,
      reason: "A reserved unit is unavailable (Damaged) during this event, so it needs a replacement.",
    });
  });

  it("doesn't flag a reservation whose unit is unusable only on other days", async () => {
    const { app } = buildApp({
      user: coordinator,
      requests: [{ id: 55, event_id: 7, status: "Arranged", created_at: "2026-01-01T00:00:00Z" }],
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 1, equipment_catalog_id: 1 }],
      equipmentBookingRows: [{ id: 1, equipment_id: 201, event_id: 7, request_item_id: 1 }],
      unavailabilityRows: [{ id: 1, equipment_id: 201, reason: "Damaged", start_date: "2026-10-01", end_date: "2026-10-05", note: null }],
    });

    const res = await request(app).get("/api/equipment-requests?eventId=7");

    expect(res.body.equipmentRequests[0].items[0].reservationFlag).toEqual(NO_FLAG);
  });

  // AC2: not enough available units — rejected with the shortfall shown,
  // and nothing committed (the RPC is never even called).
  it("rejects with the available count when demand exceeds supply", async () => {
    const { app, rpcMock, equipmentBookingTable } = buildApp({
      user: technicalSupport,
      items: oneItem,
      equipmentRows: [{ id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 }],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(409);
    expect(res.body.shortfalls["1"]).toMatchObject({ equipmentType: "Projector", availableCount: 1, shortfall: 1 });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(equipmentBookingTable.rows).toHaveLength(0);
  });

  // A physical unit already claimed by a DIFFERENT item of the SAME event
  // can't be handed to this item too — one unit can't serve two claims.
  it("does not let a second item of the same event reuse a unit the event already holds", async () => {
    const twoItems = [
      { id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 1, equipment_catalog_id: 1 },
      { id: 2, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 0, equipment_catalog_id: 1 },
    ];
    const { app } = buildApp({
      user: technicalSupport,
      items: twoItems,
      equipmentRows: [{ id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 }],
      equipmentBookingRows: [{ id: 900, equipment_id: 201, event_id: 7, request_item_id: 1 }],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(409);
    expect(res.body.shortfalls["2"]).toMatchObject({ availableCount: 0, shortfall: 1 });
  });

  // Two items of the same request both newly claiming the same equipment
  // type in one PATCH call must get DIFFERENT physical units — nothing is
  // written to equipment_booking until the RPC runs, so without tracking
  // what's provisionally claimed within this one call, both items could
  // independently pick the same still-free-looking unit.
  it("gives two items claiming the same type in one call distinct physical units", async () => {
    const twoNewItems = [
      { id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 0, equipment_catalog_id: 1 },
      { id: 2, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 0, equipment_catalog_id: 1 },
    ];
    const { app, rpcMock } = buildApp({
      user: technicalSupport,
      items: twoNewItems,
      equipmentRows: [{ id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 }, { id: 202, type: "Projector", status: "Available", equipment_catalog_id: 1 }],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(200);
    const claims = reserveArgs(rpcMock)!.p_claims;
    expect(claims.map((c) => c.itemId)).toEqual([1, 2]);
    const claimedUnitIds = claims.flatMap((c) => c.unitIds);
    expect(claimedUnitIds).toHaveLength(2);
    expect(new Set(claimedUnitIds).size).toBe(2);
  });

  // Released bookings stay as history (migration 0052) but no longer hold the unit.
  it("claims a unit whose only booking for an overlapping event was Released", async () => {
    const { app, rpcMock } = buildApp({
      user: technicalSupport,
      items: [{ ...oneItem[0], quantity: 1 }],
      equipmentRows: [{ id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 }],
      equipmentBookingRows: [{ id: 900, equipment_id: 201, event_id: 20, request_item_id: null, status: "Released" }],
      bookingInfoEvents: [
        { id: 7, name: "Alumni Gala", proposedDate: "2026-09-20", startTime: "09:00", endTime: "12:00" },
        { id: 20, name: "Design Showcase", proposedDate: "2026-09-20", startTime: "10:00", endTime: "13:00" },
      ],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(200);
    expect(reserveArgs(rpcMock)!.p_claims[0].unitIds).toEqual([201]);
  });

  // A unit already claimed by a DIFFERENT, non-overlapping event is free to
  // reuse (date-aware, unlike the flat catalog counter).
  it("claims a unit already booked to a non-overlapping event", async () => {
    const { app, rpcMock } = buildApp({
      user: technicalSupport,
      items: oneItem,
      equipmentRows: [
        { id: 201, type: "Projector", status: "Available", equipment_catalog_id: 1 },
        { id: 202, type: "Projector", status: "Available", equipment_catalog_id: 1 },
      ],
      equipmentBookingRows: [{ id: 900, equipment_id: 201, event_id: 20, request_item_id: null }],
      bookingInfoEvents: [
        { id: 7, name: "Alumni Gala", proposedDate: "2026-09-20", startTime: "09:00", endTime: "12:00" },
        { id: 20, name: "Design Showcase", proposedDate: "2026-09-25", startTime: "09:00", endTime: "12:00" },
      ],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(200);
    // Unit 201 is booked to event 20 on another day, so it is still offered for event 7.
    const unitIds = reserveArgs(rpcMock)!.p_claims[0].unitIds;
    expect([...unitIds].sort()).toEqual([201, 202]);
  });

  // 409 when there's no date to check against yet.
  it("rejects claiming when the event has no date set", async () => {
    const { app } = buildApp({
      user: technicalSupport,
      items: oneItem,
      bookingInfoEvents: [{ id: 7, name: "Alumni Gala", proposedDate: null }],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });
    expect(res.status).toBe(409);
  });

  // Reverting a status only releases claimed units — no date check needed.
  it("claims nothing when a status is reverted, leaving the release to the database function", async () => {
    const twoFulfilled = [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 2, equipment_catalog_id: 1 }];
    const { app, rpcMock } = buildApp({
      user: technicalSupport,
      items: twoFulfilled,
      equipmentBookingRows: [
        { id: 900, equipment_id: 201, event_id: 7, request_item_id: 1 },
        { id: 901, equipment_id: 202, event_id: 7, request_item_id: 1 },
      ],
      updatedRequest: {
        id: 55,
        event_id: 7,
        coordinator_id: "COORD-0001",
        status: "Requested",
        fulfillment_note: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Requested" });

    expect(res.status).toBe(200);
    // Releasing the bookings is done inside reserve_equipment_request (checked in supabase/scripts/test_equipment_stock.sql).
    expect(reserveArgs(rpcMock)).toMatchObject({ p_status: "Requested", p_claims: [] });
  });

  // Partially Fulfilled lowering the fulfilled quantity releases only the difference.
  it("claims nothing when a partial fulfilment is lowered, sending the lower quantity", async () => {
    const twoFulfilled = [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 2, equipment_catalog_id: 1 }];
    const { app, rpcMock } = buildApp({
      user: technicalSupport,
      items: twoFulfilled,
      equipmentBookingRows: [
        { id: 900, equipment_id: 201, event_id: 7, request_item_id: 1 },
        { id: 901, equipment_id: 202, event_id: 7, request_item_id: 1 },
      ],
      updatedRequest: {
        id: 55,
        event_id: 7,
        coordinator_id: "COORD-0001",
        status: "Partially Fulfilled",
        fulfillment_note: "note",
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    const res = await request(app)
      .patch("/api/equipment-requests/55")
      .send({ status: "Partially Fulfilled", note: "note", fulfillments: [{ itemId: 1, fulfilledQuantity: 1 }] });

    expect(res.status).toBe(200);
    expect(reserveArgs(rpcMock)).toMatchObject({
      p_status: "Partially Fulfilled",
      p_fulfillments: [{ itemId: 1, fulfilledQuantity: 1 }],
      p_claims: [],
    });
  });
});

describe("POST /api/equipment-requests/events/:eventId/release (E5-6 AC4)", () => {
  // Now a direct-call fallback alongside the event.cancelled consumer
  // (eventCancelledHandler.test.ts) — both share releaseEquipmentForEvent.
  it("rejects a non-organiser", async () => {
    const { app } = buildApp({ user: technicalSupport, event: eventRow({ status: "Cancelled" }) });
    const res = await request(app).post("/api/equipment-requests/events/7/release");
    expect(res.status).toBe(403);
  });

  it("404s when the event doesn't exist", async () => {
    const { app } = buildApp({ user: organiser, eventStatus: 404 });
    const res = await request(app).post("/api/equipment-requests/events/7/release");
    expect(res.status).toBe(404);
  });

  it("409s when the event isn't actually cancelled", async () => {
    const { app } = buildApp({ user: organiser, event: eventRow({ status: "Planning" }) });
    const res = await request(app).post("/api/equipment-requests/events/7/release");
    expect(res.status).toBe(409);
  });

  it("releases the event's reservations once it is cancelled", async () => {
    const { app, rpcMock } = buildApp({ user: organiser, event: eventRow({ status: "Cancelled" }) });
    const res = await request(app).post("/api/equipment-requests/events/7/release");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ released: true });
    expect(rpcMock).toHaveBeenCalledWith("release_equipment_for_event", { p_event_id: 7 });
  });

  it("surfaces a failure from the release RPC", async () => {
    const { app } = buildApp({ user: organiser, event: eventRow({ status: "Cancelled" }), releaseError: { message: "boom" } });
    const res = await request(app).post("/api/equipment-requests/events/7/release");
    expect(res.status).toBe(500);
  });
});

describe("POST /api/equipment-requests/flag-for-event/:eventId (E3-11 AC3)", () => {
  it("rejects a non-assigned coordinator", async () => {
    const { app } = buildApp({ event: eventRow({ coordinator_id: "COORD-0002" }) });
    const res = await request(app)
      .post("/api/equipment-requests/flag-for-event/7")
      .send({ reason: "Equipment requirements changed" });
    expect(res.status).toBe(403);
  });

  it("rejects a missing reason", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/equipment-requests/flag-for-event/7").send({});
    expect(res.status).toBe(400);
  });

  it("404s when the event doesn't exist", async () => {
    const { app } = buildApp({ eventStatus: 404 });
    const res = await request(app)
      .post("/api/equipment-requests/flag-for-event/7")
      .send({ reason: "Equipment requirements changed" });
    expect(res.status).toBe(404);
  });

  it("flags every equipment request for the event and notifies Technical Support", async () => {
    const { app, requestsTable, publish } = buildApp({
      requests: [
        { id: 55, event_id: 7, coordinator_id: "COORD-0001", status: "Arranged", fulfillment_note: null, created_at: "2026-01-01T00:00:00Z" },
        { id: 56, event_id: 7, coordinator_id: "COORD-0001", status: "Requested", fulfillment_note: null, created_at: "2026-01-02T00:00:00Z" },
        { id: 99, event_id: 8, coordinator_id: "COORD-0001", status: "Requested", fulfillment_note: null, created_at: "2026-01-03T00:00:00Z" },
      ],
    });
    const res = await request(app)
      .post("/api/equipment-requests/flag-for-event/7")
      .send({ reason: "Equipment requirements changed" });

    expect(res.status).toBe(200);
    expect(res.body.flaggedRequestIds.sort()).toEqual([55, 56]);
    expect(res.body.notified).toBe(true);
    expect(requestsTable.rows.find((r) => r.id === 55)).toMatchObject({
      flagged_for_reassessment: true,
      flag_reason: "Equipment requirements changed",
    });
    expect(requestsTable.rows.find((r) => r.id === 99)).not.toMatchObject({ flagged_for_reassessment: true });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "equipment.flagged_for_reassessment",
        recipients: { userIds: [], roles: ["technical_support"] },
      }),
    );
  });

  it("doesn't notify when the event has no equipment requests to flag", async () => {
    const { app, publish } = buildApp({ requests: [] });
    const res = await request(app)
      .post("/api/equipment-requests/flag-for-event/7")
      .send({ reason: "Equipment requirements changed" });

    expect(res.status).toBe(200);
    expect(res.body.flaggedRequestIds).toEqual([]);
    expect(res.body.notified).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});

/** E5-2: a request still open to amendment, with one reserved item. */
const editableRequest = {
  id: 55,
  event_id: 7,
  coordinator_id: "COORD-0001",
  status: "Partially Fulfilled",
  fulfillment_note: "2 still to arrange",
  created_at: "2026-01-01T00:00:00Z",
};
const editableItems = [
  { id: 1, request_id: 55, equipment_type: "Projector", quantity: 5, quantity_fulfilled: 3, equipment_catalog_id: 1 },
  { id: 2, request_id: 55, equipment_type: "Screen", quantity: 1, quantity_fulfilled: 0, equipment_catalog_id: 2 },
];
const twoCatalogRows = [
  { id: 1, name: "Projector" },
  { id: 2, name: "Screen" },
  { id: 3, name: "Microphone" },
];

describe("validateAmendedItems", () => {
  it("accepts existing and new rows, keeping the itemId of the ones that amend an existing item", () => {
    const result = validateAmendedItems([
      { itemId: 1, equipmentCatalogId: 1, quantity: 3 },
      { equipmentCatalogId: 3, quantity: 2 },
    ]);
    expect(result).toEqual({
      valid: true,
      fields: {},
      value: [
        { itemId: 1, equipmentCatalogId: 1, quantity: 3 },
        { equipmentCatalogId: 3, quantity: 2 },
      ],
    });
  });

  it("rejects the same existing item twice and a bad itemId, on top of the usual item checks", () => {
    const result = validateAmendedItems([
      { itemId: 1, equipmentCatalogId: 1, quantity: 3 },
      { itemId: 1, equipmentCatalogId: 1, quantity: 2 },
      { itemId: "x", equipmentCatalogId: 1, quantity: 2 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.fields["items[1].itemId"]).toMatch(/more than once/);
    expect(result.fields["items[2].itemId"]).toBeDefined();

    expect(validateAmendedItems([{ itemId: 1, equipmentCatalogId: 1, quantity: 0 }]).fields["items[0].quantity"]).toMatch(
      /greater than zero/,
    );
    expect(validateAmendedItems([]).valid).toBe(false);
  });
});

describe("PUT /api/equipment-requests/:id/items (E5-2 AC1, AC2)", () => {
  const body = {
    items: [
      { itemId: 1, equipmentCatalogId: 1, quantity: 3 },
      { equipmentCatalogId: 3, quantity: 2 },
    ],
  };
  const amendment = {
    status: "Partially Fulfilled",
    changes: [
      { kind: "quantity", equipmentType: "Projector", from: 5, to: 3, released: 0 },
      { kind: "removed", equipmentType: "Screen", quantity: 1, released: 0 },
      { kind: "added", equipmentType: "Microphone", quantity: 2, released: 0 },
    ],
  };

  function amendApp(options: Parameters<typeof buildApp>[0] = {}) {
    return buildApp({ requests: [editableRequest], items: editableItems, catalogRows: twoCatalogRows, ...options });
  }

  it("rejects anyone but a coordinator", async () => {
    const { app } = amendApp({ user: technicalSupport });
    expect((await request(app).put("/api/equipment-requests/55/items").send(body)).status).toBe(403);
  });

  it("rejects a coordinator who isn't the event's assigned one", async () => {
    const { app, rpcMock } = amendApp({ event: eventRow({ coordinator_id: "COORD-0002" }) });
    const res = await request(app).put("/api/equipment-requests/55/items").send(body);
    expect(res.status).toBe(403);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("only allows it while the event is in Planning", async () => {
    const { app, rpcMock } = amendApp({ event: eventRow({ status: "Confirmed" }) });
    const res = await request(app).put("/api/equipment-requests/55/items").send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Planning/);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("refuses a fully arranged request, telling the coordinator to cancel and raise a new one", async () => {
    const { app, rpcMock } = amendApp({ requests: [{ ...editableRequest, status: "Arranged" }] });
    const res = await request(app).put("/api/equipment-requests/55/items").send(body);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Cancel it/);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("refuses a cancelled request", async () => {
    const { app } = amendApp({ requests: [{ ...editableRequest, status: "Cancelled" }] });
    expect((await request(app).put("/api/equipment-requests/55/items").send(body)).status).toBe(409);
  });

  it("404s a request that doesn't exist and 400s a malformed id", async () => {
    expect((await request(amendApp({ requests: [] }).app).put("/api/equipment-requests/55/items").send(body)).status).toBe(404);
    expect((await request(amendApp().app).put("/api/equipment-requests/abc/items").send(body)).status).toBe(400);
  });

  it("surfaces item validation errors and unknown equipment types", async () => {
    const { app, rpcMock } = amendApp();
    const zero = await request(app)
      .put("/api/equipment-requests/55/items")
      .send({ items: [{ itemId: 1, equipmentCatalogId: 1, quantity: 0 }] });
    expect(zero.status).toBe(400);
    expect(zero.body.fields["items[0].quantity"]).toMatch(/greater than zero/);

    const unknown = await request(app)
      .put("/api/equipment-requests/55/items")
      .send({ items: [{ itemId: 1, equipmentCatalogId: 99, quantity: 1 }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.fields["items[0].equipmentCatalogId"]).toBeDefined();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("amends through the database function and tells Technical Support exactly what changed (AC1)", async () => {
    const { app, rpcMock, publish } = amendApp({ amendOutcome: amendment });

    const res = await request(app).put("/api/equipment-requests/55/items").send(body);

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("amend_equipment_request", {
      p_request_id: 55,
      p_items: [
        { itemId: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 3 },
        { itemId: null, equipmentCatalogId: 3, equipmentType: "Microphone", quantity: 2 },
      ],
    });
    expect(publish).toHaveBeenCalledWith({
      type: "equipment.amended",
      eventId: 7,
      actorId: "COORD-0001",
      recipients: { userIds: [], roles: ["technical_support"] },
      data: { eventName: "Alumni Gala", changes: amendment.changes, released: 0 },
    });
    expect(res.body.changes).toEqual(amendment.changes);
    expect(res.body.notified).toBe(true);
    expect(res.body.equipmentRequest.id).toBe(55);
  });

  it("reports how much reserved equipment a reduction released back to inventory (AC2)", async () => {
    const reduced = {
      status: "Arranged",
      changes: [{ kind: "quantity", equipmentType: "Projector", from: 5, to: 2, released: 1 }],
    };
    const { app, publish } = amendApp({ amendOutcome: reduced });

    const res = await request(app)
      .put("/api/equipment-requests/55/items")
      .send({ items: [{ itemId: 1, equipmentCatalogId: 1, quantity: 2 }, { itemId: 2, equipmentCatalogId: 2, quantity: 1 }] });

    expect(res.status).toBe(200);
    expect(res.body.released).toBe(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ released: 1 }) }));
  });

  it("tells nobody when the amendment changed nothing", async () => {
    const { app, publish } = amendApp({ amendOutcome: { status: "Partially Fulfilled", changes: [] } });

    const res = await request(app).put("/api/equipment-requests/55/items").send(body);

    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([]);
    expect(res.body.notified).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("answers 409 when the database says the request can no longer be amended, 500 for anything else", async () => {
    const blocked = amendApp({ amendError: { message: "Equipment request cannot be amended: Arranged" } });
    expect((await request(blocked.app).put("/api/equipment-requests/55/items").send(body)).status).toBe(409);
    expect(blocked.publish).not.toHaveBeenCalled();

    const broken = amendApp({ amendError: { message: "boom" } });
    expect((await request(broken.app).put("/api/equipment-requests/55/items").send(body)).status).toBe(500);
  });
});

describe("POST /api/equipment-requests/:id/cancel (E5-2 AC3)", () => {
  function cancelApp(options: Parameters<typeof buildApp>[0] = {}) {
    return buildApp({ requests: [editableRequest], items: editableItems, ...options });
  }

  it("rejects anyone but the event's assigned coordinator", async () => {
    expect((await request(cancelApp({ user: technicalSupport }).app).post("/api/equipment-requests/55/cancel")).status).toBe(403);
    const other = cancelApp({ event: eventRow({ coordinator_id: "COORD-0002" }) });
    expect((await request(other.app).post("/api/equipment-requests/55/cancel")).status).toBe(403);
    expect(other.rpcMock).not.toHaveBeenCalled();
  });

  it("only allows it while the event is in Planning", async () => {
    const { app, rpcMock } = cancelApp({ event: eventRow({ status: "Safety Review" }) });
    const res = await request(app).post("/api/equipment-requests/55/cancel");
    expect(res.status).toBe(409);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("releases everything reserved against the request and tells Technical Support (AC3)", async () => {
    const released = [{ equipmentType: "Projector", quantity: 3 }];
    const { app, rpcMock, publish } = cancelApp({ cancelOutcome: { released } });

    const res = await request(app).post("/api/equipment-requests/55/cancel");

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("release_equipment_for_request", { p_request_id: 55 });
    expect(publish).toHaveBeenCalledWith({
      type: "equipment.released",
      eventId: 7,
      actorId: "COORD-0001",
      recipients: { userIds: [], roles: ["technical_support"] },
      data: { eventName: "Alumni Gala", reason: "coordinator_cancelled", released },
    });
    expect(res.body.released).toEqual(released);
    expect(res.body.notified).toBe(true);
  });

  it("can cancel a fully arranged request too", async () => {
    const { app, rpcMock } = cancelApp({ requests: [{ ...editableRequest, status: "Arranged" }] });
    expect((await request(app).post("/api/equipment-requests/55/cancel")).status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("release_equipment_for_request", { p_request_id: 55 });
  });

  it("refuses a request that is already cancelled", async () => {
    const { app, rpcMock } = cancelApp({ requests: [{ ...editableRequest, status: "Cancelled" }] });
    expect((await request(app).post("/api/equipment-requests/55/cancel")).status).toBe(409);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("answers 409 on a race with an earlier cancellation and 500 for any other failure", async () => {
    const raced = cancelApp({ cancelError: { message: "Equipment request already cancelled: 55" } });
    expect((await request(raced.app).post("/api/equipment-requests/55/cancel")).status).toBe(409);
    expect(raced.publish).not.toHaveBeenCalled();

    const broken = cancelApp({ cancelError: { message: "boom" } });
    expect((await request(broken.app).post("/api/equipment-requests/55/cancel")).status).toBe(500);
  });
});

describe("cancelled requests are read-only for Technical Support (E5-2)", () => {
  const cancelled = { ...editableRequest, id: 56, status: "Cancelled", fulfillment_note: null };
  const cancelledItem = { id: 9, request_id: 56, equipment_type: "Screen", quantity: 1, quantity_fulfilled: 0, equipment_catalog_id: 2 };

  it("lists them for Technical Support with their status, so the queue can show them under Cancelled / Past, and for the coordinator", async () => {
    const tableOptions = { requests: [editableRequest, cancelled], items: [...editableItems, cancelledItem] };

    const support = await request(buildApp({ ...tableOptions, user: technicalSupport }).app).get("/api/equipment-requests");
    expect(support.body.equipmentRequests.map((r: { id: number; status: string }) => [r.id, r.status])).toEqual([
      [55, "Partially Fulfilled"],
      [56, "Cancelled"],
    ]);

    const coord = await request(buildApp(tableOptions).app).get("/api/equipment-requests?eventId=7");
    expect(coord.body.equipmentRequests.map((r: { id: number; status: string }) => [r.id, r.status])).toEqual([
      [55, "Partially Fulfilled"],
      [56, "Cancelled"],
    ]);
  });

  it("lets Technical Support open an event whose only request was cancelled, to look back at it", async () => {
    const { app } = buildApp({ user: technicalSupport, requests: [cancelled], items: [cancelledItem] });
    const res = await request(app).get("/api/equipment-requests/event/7");
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests.map((r: { id: number; status: string }) => [r.id, r.status])).toEqual([[56, "Cancelled"]]);
  });

  it("refuses a status update on a cancelled request", async () => {
    const { app, rpcMock } = buildApp({ user: technicalSupport, requests: [cancelled], items: [cancelledItem] });
    const res = await request(app).patch("/api/equipment-requests/56").send({ status: "Arranged" });
    expect(res.status).toBe(409);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
