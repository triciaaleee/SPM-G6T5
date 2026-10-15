import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { equipmentRequestsRouter } from "../routes/equipmentRequests.js";
import { validateEquipmentItems, validateStatusUpdate } from "../lib/validateEquipmentRequest.js";
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
  { id: 201, type: "Projector", status: "Available" },
  { id: 202, type: "Projector", status: "Available" },
  { id: 203, type: "Projector", status: "Available" },
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
    equipmentRows?: Record<string, unknown>[];
    equipmentBookingRows?: Record<string, unknown>[];
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
  const equipmentBookingTable = recordTable(options.equipmentBookingRows ?? []);

  const rpcMock = vi.fn(async (fn: string) => {
    if (fn === "release_equipment_for_event") return { data: null, error: options.releaseError ?? null };
    return { data: null, error: options.applyError ?? null };
  });

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "equipment_requests") {
        return { insert: requestInsert, select: requestsTable.select, delete: vi.fn(() => deleteQuery) };
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
        return { select: equipmentBookingTable.select, insert: equipmentBookingTable.insert, delete: equipmentBookingTable.delete };
      }
      throw new Error(`unexpected table ${table}`);
    }),
    rpc: rpcMock,
  };

  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("venue-booking-info")) {
      return { ok: true, status: 200, json: async () => ({ events: options.bookingInfoEvents ?? defaultBookingInfoEvents }) };
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
        items: [{ id: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0, reservationFlag: NO_FLAG }],
      },
    ]);
  });

  // The owning organiser has no form to submit a request, but still needs to
  // see arrangement status (E3-1 AC3's "Outstanding Arrangements" line).
  it("allows the owning organiser to view one event's requests", async () => {
    const { app } = buildApp({
      user: { id: "ORG-0001", role: "organiser" },
      requests: [{ id: 55, event_id: 7, status: "Arranged", created_at: "2026-01-01T00:00:00Z" }],
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 2 }],
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
        items: [{ id: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 2, reservationFlag: NO_FLAG }],
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
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 2 }],
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
        { id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0 },
      ],
      bookingInfoEvents: [{ id: 7, name: "Alumni Gala", proposedDate: "2026-02-01", equipment: "2 projectors" }],
    });
    const res = await request(app).get("/api/equipment-requests");
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests).toEqual([
      {
        id: 55,
        eventId: 7,
        status: "Requested",
        fulfillmentNote: null,
        createdAt: "2026-01-01T00:00:00Z",
        items: [{ id: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0, reservationFlag: NO_FLAG }],
        event: { id: 7, name: "Alumni Gala", proposedDate: "2026-02-01", equipment: "2 projectors" },
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
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 1 }],
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
      items: [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 1 }],
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

describe("PATCH /api/equipment-requests/:id (E5-3)", () => {
  const oneItem = [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0 }];

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
    expect(rpcMock).toHaveBeenCalledWith("apply_equipment_request_status", {
      p_request_id: 55,
      p_status: "Arranged",
      p_note: null,
      p_fulfillments: [],
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
    expect(rpcMock).toHaveBeenCalledWith("apply_equipment_request_status", {
      p_request_id: 55,
      p_status: "Partially Fulfilled",
      p_note: "1 of 2 projectors arrived",
      p_fulfillments: [{ itemId: 1, fulfilledQuantity: 1 }],
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

  it("reports notified:false when notification-service fails, without failing the update", async () => {
    const { app } = buildApp({ user: technicalSupport, items: oneItem, notificationsStatus: 500 });
    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });
    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
  });
});

describe("PATCH /api/equipment-requests/:id (E5-6 reservation)", () => {
  const oneItem = [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0 }];

  // AC1: saving the reservation deducts that quantity from availability for
  // the period and ties it to the event — specific physical units get claimed.
  it("claims specific units when an item is marked Arranged", async () => {
    const { app, equipmentBookingTable } = buildApp({ user: technicalSupport, items: oneItem });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(200);
    expect(equipmentBookingTable.rows).toHaveLength(2);
    for (const row of equipmentBookingTable.rows) {
      expect(row).toMatchObject({ event_id: 7, request_item_id: 1 });
      expect([201, 202, 203]).toContain(row.equipment_id);
    }
    expect(res.body.equipmentRequest.items[0].reservationFlag).toEqual(NO_FLAG);
  });

  // AC2: not enough available units — rejected with the shortfall shown,
  // and nothing committed (the RPC is never even called).
  it("rejects with the available count when demand exceeds supply", async () => {
    const { app, rpcMock, equipmentBookingTable } = buildApp({
      user: technicalSupport,
      items: oneItem,
      equipmentRows: [{ id: 201, type: "Projector", status: "Available" }],
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
      { id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 1 },
      { id: 2, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 0 },
    ];
    const { app } = buildApp({
      user: technicalSupport,
      items: twoItems,
      equipmentRows: [{ id: 201, type: "Projector", status: "Available" }],
      equipmentBookingRows: [{ id: 900, equipment_id: 201, event_id: 7, request_item_id: 1 }],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(409);
    expect(res.body.shortfalls["2"]).toMatchObject({ availableCount: 0, shortfall: 1 });
  });

  // Two items of the same request both newly claiming the same equipment
  // type in one PATCH call must get DIFFERENT physical units — nothing is
  // written to equipment_booking until after the RPC, so without tracking
  // what's provisionally claimed within this one call, both items could
  // independently pick the same still-free-looking unit.
  it("gives two items claiming the same type in one call distinct physical units", async () => {
    const twoNewItems = [
      { id: 1, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 0 },
      { id: 2, request_id: 55, equipment_type: "Projector", quantity: 1, quantity_fulfilled: 0 },
    ];
    const { app, equipmentBookingTable } = buildApp({
      user: technicalSupport,
      items: twoNewItems,
      equipmentRows: [{ id: 201, type: "Projector", status: "Available" }, { id: 202, type: "Projector", status: "Available" }],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(200);
    expect(equipmentBookingTable.rows).toHaveLength(2);
    const claimedUnitIds = equipmentBookingTable.rows.map((r: any) => r.equipment_id);
    expect(new Set(claimedUnitIds).size).toBe(2);
  });

  // A unit already claimed by a DIFFERENT, non-overlapping event is free to
  // reuse (date-aware, unlike the flat catalog counter).
  it("claims a unit already booked to a non-overlapping event", async () => {
    const { app, equipmentBookingTable } = buildApp({
      user: technicalSupport,
      items: oneItem,
      equipmentRows: [
        { id: 201, type: "Projector", status: "Available" },
        { id: 202, type: "Projector", status: "Available" },
      ],
      equipmentBookingRows: [{ id: 900, equipment_id: 201, event_id: 20, request_item_id: null }],
      bookingInfoEvents: [
        { id: 7, name: "Alumni Gala", proposedDate: "2026-09-20", startTime: "09:00", endTime: "12:00" },
        { id: 20, name: "Design Showcase", proposedDate: "2026-09-25", startTime: "09:00", endTime: "12:00" },
      ],
    });

    const res = await request(app).patch("/api/equipment-requests/55").send({ status: "Arranged" });

    expect(res.status).toBe(200);
    // The pre-existing booking (to event 20) plus 2 newly claimed for event 7.
    expect(equipmentBookingTable.rows).toHaveLength(3);
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
  it("releases claimed units when a status is reverted", async () => {
    const twoFulfilled = [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 2 }];
    const { app, equipmentBookingTable } = buildApp({
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
    expect(equipmentBookingTable.rows).toHaveLength(0);
  });

  // Partially Fulfilled lowering the fulfilled quantity releases only the difference.
  it("releases only the difference when a partial fulfilment is lowered", async () => {
    const twoFulfilled = [{ id: 1, request_id: 55, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 2 }];
    const { app, equipmentBookingTable } = buildApp({
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
    expect(equipmentBookingTable.rows).toHaveLength(1);
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
