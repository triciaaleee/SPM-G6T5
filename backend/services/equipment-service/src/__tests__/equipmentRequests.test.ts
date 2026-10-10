import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { equipmentRequestsRouter } from "../routes/equipmentRequests.js";
import { validateEquipmentItems, validateStatusUpdate } from "../lib/validateEquipmentRequest.js";

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

const validItems = [{ equipmentCatalogId: 1, quantity: 2 }];
const defaultCatalogRows = [{ id: 1, name: "Projector" }];

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    status: "Planning",
    coordinator_id: "COORD-0001",
    submitted_details: { name: "Alumni Gala" },
    ...overrides,
  };
}

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
  const itemsSelect = query({ data: options.items ?? [], error: null });
  const usersSelect = query({ data: options.technicalSupportStaff ?? [], error: null });
  const catalogSelect = query({ data: options.catalogRows ?? defaultCatalogRows, error: null });

  // PATCH re-selects the request row (not an update) once apply_equipment_request_status
  // succeeds; GET's list endpoints select an array instead — tests pick whichever shape
  // they need via `updatedRequest` or `requests`.
  const requestSelectResult =
    options.updatedRequest !== undefined
      ? options.updatedRequest
      : options.requests !== undefined
        ? options.requests
        : { id: 55, event_id: 7, coordinator_id: "COORD-0001", status: "Arranged", fulfillment_note: null, created_at: "2026-01-01T00:00:00Z" };
  const requestsSelect = query({ data: requestSelectResult, error: null });

  const rpcMock = vi.fn(async () => ({ data: null, error: options.applyError ?? null }));

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "equipment_requests") {
        return {
          insert: requestInsert,
          select: requestsSelect.select,
          delete: vi.fn(() => deleteQuery),
        };
      }
      if (table === "equipment_request_items") {
        return { insert: itemsInsert, select: itemsSelect.select };
      }
      if (table === "equipment_catalog") {
        return { select: catalogSelect.select };
      }
      if (table === "users") {
        return { select: usersSelect.select };
      }
      throw new Error(`unexpected table ${table}`);
    }),
    rpc: rpcMock,
  };

  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes("venue-booking-info")) {
      return { ok: true, status: 200, json: async () => ({ events: options.bookingInfoEvents ?? [] }) };
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

  (globalThis as any).__mockSupabase = supabase;
  (globalThis as any).__mockUser = options.user ?? coordinator;

  const app = express();
  app.use(express.json());
  app.use("/api/equipment-requests", equipmentRequestsRouter);
  return { app, supabase, requestInsert, itemsInsert, deleteQuery, rpcMock, fetchMock };
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

  it("records the request and items against their catalog entry, and notifies every Technical Support user", async () => {
    const { app, requestInsert, itemsInsert, fetchMock } = buildApp({
      technicalSupportStaff: [{ id: "TS-0001" }, { id: "TS-0002" }],
    });

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

    const notifyCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/notifications"));
    expect(notifyCall).toBeDefined();
    const sentBody = JSON.parse((notifyCall![1] as RequestInit).body as string);
    expect(sentBody.notifications).toHaveLength(2);
    expect(sentBody.notifications[0]).toMatchObject({ recipientId: "TS-0001", type: "equipment_request_submitted" });
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
        items: [{ id: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0 }],
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
        items: [{ id: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 2 }],
      },
    ]);
  });

  it("404s an organiser when the event isn't theirs to see", async () => {
    const { app } = buildApp({ user: { id: "ORG-0001", role: "organiser" }, eventStatus: 404 });
    const res = await request(app).get("/api/equipment-requests?eventId=7");
    expect(res.status).toBe(404);
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
        items: [{ id: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0 }],
        event: { id: 7, name: "Alumni Gala", proposedDate: "2026-02-01", equipment: "2 projectors" },
      },
    ]);
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
  it("updates the status via the atomic RPC and notifies the assigned coordinator", async () => {
    const { app, rpcMock, fetchMock } = buildApp({
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
      bookingInfoEvents: [{ id: 7, name: "Alumni Gala" }],
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

    const notifyCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/notifications"));
    const sentBody = JSON.parse((notifyCall![1] as RequestInit).body as string);
    expect(sentBody.notifications[0]).toMatchObject({
      recipientId: "COORD-0001",
      type: "equipment_request_status_updated",
    });
    expect(sentBody.notifications[0].body).toContain("Alumni Gala");
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

  // Stock ran out between the stock table loading and Technical Support saving.
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
