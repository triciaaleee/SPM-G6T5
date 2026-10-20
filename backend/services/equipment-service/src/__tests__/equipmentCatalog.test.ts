import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { equipmentCatalogRouter } from "../routes/equipmentCatalog.js";
import { validateNewCatalogItem } from "../lib/validateCatalogItem.js";
import { validateStockChange } from "../lib/validateStockChange.js";

vi.mock("../middleware/auth.js", async () => {
  return {
    requireAuth: (req: AuthedRequest, _res: unknown, next: () => void) => {
      req.user = (globalThis as any).__mockUser;
      req.supabase = (globalThis as any).__mockSupabase;
      next();
    },
  };
});

const technicalSupport = { id: "TS-0001", role: "technical_support" };
const coordinator = { id: "COORD-0001", role: "coordinator" };

/** A supabase-js style query: every filter returns the query, and awaiting it yields `result`. */
function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "order", "insert", "update"]) q[method] = vi.fn(() => q);
  q.single = vi.fn().mockResolvedValue(result);
  q.maybeSingle = vi.fn().mockResolvedValue(result);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

const projector = { id: 1, name: "Projector", total_stock: 10, available_stock: 6 };

function buildApp(
  options: {
    user?: { id: string; role: string };
    rows?: Record<string, unknown>[];
    current?: Record<string, unknown> | null;
    writeResult?: { data: unknown; error: unknown };
  } = {},
) {
  // select() is used for the list (awaited) and for the PATCH read (maybeSingle).
  const selectQuery = query({ data: options.rows ?? [projector], error: null });
  selectQuery.maybeSingle = vi.fn().mockResolvedValue({
    data: options.current === undefined ? projector : options.current,
    error: null,
  });
  const writeQuery = query(options.writeResult ?? { data: projector, error: null });
  const insertFn = vi.fn(() => writeQuery);
  const updateFn = vi.fn(() => writeQuery);

  (globalThis as any).__mockSupabase = {
    from: vi.fn(() => ({ select: () => selectQuery, insert: insertFn, update: updateFn })),
  };
  (globalThis as any).__mockUser = options.user ?? technicalSupport;

  const app = express();
  app.use(express.json());
  app.use("/api/equipment-catalog", equipmentCatalogRouter);
  return { app, insertFn, updateFn, writeQuery };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateNewCatalogItem", () => {
  it("accepts a name and a stock count, trimming the name", () => {
    expect(validateNewCatalogItem({ name: "  Lectern  ", totalStock: 4 })).toEqual({
      valid: true,
      value: { name: "Lectern", totalStock: 4 },
    });
  });

  it("defaults total stock to 0", () => {
    expect(validateNewCatalogItem({ name: "Lectern" })).toEqual({
      valid: true,
      value: { name: "Lectern", totalStock: 0 },
    });
  });

  it.each([
    [{ name: "", totalStock: 1 }, "name"],
    [{ name: "x".repeat(101), totalStock: 1 }, "name"],
    [{ name: "Lectern", totalStock: -1 }, "totalStock"],
    [{ name: "Lectern", totalStock: 1.5 }, "totalStock"],
    [{ name: "Lectern", totalStock: "abc" }, "totalStock"],
  ])("rejects %j", (input, field) => {
    const result = validateNewCatalogItem(input);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(Object.keys(result.fields)).toContain(field);
  });
});

/** The tables the catalog list reads: units, their unusable periods and their reservations (migrations 0025, 0027, 0043). */
function tablesApp(options: {
  user?: { id: string; role: string };
  catalog?: Record<string, unknown>[];
  units?: Record<string, unknown>[];
  periods?: Record<string, unknown>[];
  bookings?: Record<string, unknown>[];
}) {
  function table(rows: Record<string, unknown>[]) {
    return {
      select: vi.fn(() => {
        let filtered = rows;
        const q: Record<string, any> = {};
        q.order = vi.fn(() => q);
        q.neq = vi.fn((field: string, value: unknown) => {
          filtered = filtered.filter((r) => r[field] !== value);
          return q;
        });
        q.in = vi.fn((field: string, values: unknown[]) => {
          filtered = filtered.filter((r) => values.includes(r[field]));
          return q;
        });
        // Only `.not(field, "is", null)`: keep rows where the field is set.
        q.not = vi.fn((field: string) => {
          filtered = filtered.filter((r) => r[field] !== null && r[field] !== undefined);
          return q;
        });
        q.lte = vi.fn((field: string, value: string) => {
          filtered = filtered.filter((r) => String(r[field]) <= value);
          return q;
        });
        // Only the one expression the helper sends: "end_date.is.null,end_date.gte.<date>".
        q.or = vi.fn((expr: string) => {
          const date = /end_date\.gte\.(\d{4}-\d{2}-\d{2})/.exec(expr)![1];
          filtered = filtered.filter((r) => r.end_date === null || String(r.end_date) >= date);
          return q;
        });
        q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: filtered, error: null }).then(resolve);
        return q;
      }),
    };
  }

  const tables: Record<string, ReturnType<typeof table>> = {
    equipment_catalog: table(options.catalog ?? [projector]),
    equipment: table(options.units ?? []),
    equipment_unavailability: table(options.periods ?? []),
    equipment_booking: table(options.bookings ?? []),
  };
  (globalThis as any).__mockSupabase = { from: vi.fn((name: string) => tables[name]) };
  (globalThis as any).__mockUser = options.user ?? coordinator;
  const app = express();
  app.use(express.json());
  app.use("/api/equipment-catalog", equipmentCatalogRouter);
  return app;
}

/** The server reads "today" in Singapore, so build dates relative to that. */
function sgDate(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

describe("GET /api/equipment-catalog", () => {
  it("returns the catalog to any authenticated role", async () => {
    const res = await request(tablesApp({ user: coordinator })).get("/api/equipment-catalog");

    expect(res.status).toBe(200);
    expect(res.body.equipmentCatalog).toEqual([{ id: 1, name: "Projector", totalStock: 10, availableStock: 6, unusableNow: 0 }]);
  });
});

describe("GET /api/equipment-catalog — available stock takes units out of use off (E5-5)", () => {
  const unit = (id: number, status = "Available", type = "Projector") => ({ id, type, status });
  const period = (equipmentId: number, startOffset: number, endOffset: number | null, id = equipmentId) => ({
    id,
    equipment_id: equipmentId,
    start_date: sgDate(startOffset),
    end_date: endOffset === null ? null : sgDate(endOffset),
  });
  const availableOf = async (options: Parameters<typeof tablesApp>[0]) => {
    const res = await request(tablesApp(options)).get("/api/equipment-catalog");
    return res.body.equipmentCatalog[0] as { availableStock: number; unusableNow: number };
  };

  it("subtracts a unit marked unusable for a period running today, and says how many", async () => {
    const item = await availableOf({ units: [unit(1), unit(2)], periods: [period(1, -1, 3)] });
    expect(item).toMatchObject({ availableStock: 5, unusableNow: 1 });
  });

  it("counts the first and the last day of the period", async () => {
    expect((await availableOf({ units: [unit(1)], periods: [period(1, 0, 4)] })).unusableNow).toBe(1);
    expect((await availableOf({ units: [unit(1)], periods: [period(1, -4, 0)] })).unusableNow).toBe(1);
  });

  it("adds the unit back once its end date has passed", async () => {
    const item = await availableOf({ units: [unit(1)], periods: [period(1, -5, -1)] });
    expect(item).toMatchObject({ availableStock: 6, unusableNow: 0 });
  });

  it("doesn't subtract a period that hasn't started yet", async () => {
    expect((await availableOf({ units: [unit(1)], periods: [period(1, 1, 5)] })).availableStock).toBe(6);
  });

  it("keeps subtracting a unit with no end date until it is marked usable again", async () => {
    expect((await availableOf({ units: [unit(1)], periods: [period(1, -30, null)] })).availableStock).toBe(5);
  });

  it("also subtracts a unit that is Damaged or Under Maintenance by status", async () => {
    const item = await availableOf({ units: [unit(1, "Damaged"), unit(2, "Under Maintenance"), unit(3)] });
    expect(item).toMatchObject({ availableStock: 4, unusableNow: 2 });
  });

  it("doesn't subtract a unit twice when a period and its status both say unusable", async () => {
    const item = await availableOf({ units: [unit(1, "Damaged")], periods: [period(1, -1, 3)] });
    expect(item.unusableNow).toBe(1);
  });

  it("doesn't subtract a unit a request already holds: reserving it already took it out of the count", async () => {
    const item = await availableOf({
      units: [unit(1), unit(2)],
      periods: [period(1, -1, 3), period(2, -1, 3)],
      bookings: [{ equipment_id: 1, event_id: 7, request_item_id: 100 }],
    });
    expect(item).toMatchObject({ availableStock: 5, unusableNow: 1 });
  });

  it("does count a unit whose only booking is an old one with no request item, since that never took it out of the count", async () => {
    const item = await availableOf({
      units: [unit(1)],
      periods: [period(1, -1, 3)],
      bookings: [{ equipment_id: 1, event_id: 5, request_item_id: null }],
    });
    expect(item).toMatchObject({ availableStock: 5, unusableNow: 1 });
  });

  it("only takes units off their own type, and never goes below zero", async () => {
    const res = await request(
      tablesApp({
        catalog: [{ id: 1, name: "Projector", total_stock: 3, available_stock: 1 }, { id: 2, name: "Screen", total_stock: 4, available_stock: 4 }],
        units: [unit(1), unit(2), unit(3), unit(10, "Available", "Screen")],
        periods: [period(1, -1, 3), period(2, -1, 3), period(3, -1, 3)],
      }),
    ).get("/api/equipment-catalog");

    expect(res.body.equipmentCatalog).toEqual([
      { id: 1, name: "Projector", totalStock: 3, availableStock: 0, unusableNow: 3 },
      { id: 2, name: "Screen", totalStock: 4, availableStock: 4, unusableNow: 0 },
    ]);
  });
});

describe("POST /api/equipment-catalog (E5-1 AC3)", () => {
  it("adds an item with all of its stock available", async () => {
    const { app, insertFn } = buildApp({
      writeResult: { data: { id: 2, name: "Lectern", total_stock: 4, available_stock: 4 }, error: null },
    });
    const res = await request(app).post("/api/equipment-catalog").send({ name: "Lectern", totalStock: 4 });

    expect(res.status).toBe(201);
    expect(insertFn).toHaveBeenCalledWith({ name: "Lectern", total_stock: 4, available_stock: 4 });
    expect(res.body.equipment).toEqual({ id: 2, name: "Lectern", totalStock: 4, availableStock: 4, unusableNow: 0 });
  });

  // E5-5: stock is also tracked per physical unit, so each can be marked damaged or under maintenance.
  it("creates one Available unit per item in stock, so each can be marked unusable on its own", async () => {
    const { app, insertFn } = buildApp({
      writeResult: { data: { id: 2, name: "Lectern", total_stock: 3, available_stock: 3 }, error: null },
    });

    const res = await request(app).post("/api/equipment-catalog").send({ name: "Lectern", totalStock: 3 });

    expect(res.status).toBe(201);
    expect(insertFn).toHaveBeenCalledTimes(2);
    expect(insertFn).toHaveBeenLastCalledWith([
      { type: "Lectern", status: "Available" },
      { type: "Lectern", status: "Available" },
      { type: "Lectern", status: "Available" },
    ]);
  });

  it("creates no units for an item with no stock", async () => {
    const { app, insertFn } = buildApp({
      writeResult: { data: { id: 2, name: "Lectern", total_stock: 0, available_stock: 0 }, error: null },
    });

    await request(app).post("/api/equipment-catalog").send({ name: "Lectern", totalStock: 0 });

    expect(insertFn).toHaveBeenCalledTimes(1);
  });

  it("takes the catalog entry back out, and answers 500, if its units can't be created", async () => {
    const catalogDelete = vi.fn(() => ({ eq: vi.fn().mockResolvedValue({ error: null }) }));
    const catalogInsert = vi.fn(() => query({ data: { id: 2, name: "Lectern", total_stock: 3, available_stock: 3 }, error: null }));
    const unitInsert = vi.fn(() => query({ data: null, error: { message: "boom" } }));
    const { app } = buildApp();
    (globalThis as any).__mockSupabase = {
      from: vi.fn((table: string) =>
        table === "equipment_catalog"
          ? { select: () => query({ data: [], error: null }), insert: catalogInsert, delete: catalogDelete }
          : { insert: unitInsert },
      ),
    };

    const res = await request(app).post("/api/equipment-catalog").send({ name: "Lectern", totalStock: 3 });

    expect(res.status).toBe(500);
    expect(catalogDelete).toHaveBeenCalled();
  });

  it("denies other roles", async () => {
    const { app, insertFn } = buildApp({ user: coordinator });
    const res = await request(app).post("/api/equipment-catalog").send({ name: "Lectern", totalStock: 4 });

    expect(res.status).toBe(403);
    expect(insertFn).not.toHaveBeenCalled();
  });

  it("400s invalid input with the offending fields", async () => {
    const { app } = buildApp();
    const res = await request(app).post("/api/equipment-catalog").send({ name: "", totalStock: -2 });

    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields)).toEqual(expect.arrayContaining(["name", "totalStock"]));
  });

  it("409s a duplicate name", async () => {
    const { app } = buildApp({ writeResult: { data: null, error: { code: "23505", message: "dup" } } });
    const res = await request(app).post("/api/equipment-catalog").send({ name: "Projector", totalStock: 1 });

    expect(res.status).toBe(409);
    expect(res.body.fields.name).toBeDefined();
  });
});

describe("validateStockChange", () => {
  it("accepts a direction, a whole quantity and a reason, trimming the reason", () => {
    expect(validateStockChange({ direction: "add", quantity: 5, reason: "  New delivery " })).toEqual({
      valid: true,
      value: { direction: "add", quantity: 5, reason: "New delivery" },
    });
    expect(validateStockChange({ direction: "remove", quantity: "3", reason: "Sold" })).toEqual({
      valid: true,
      value: { direction: "remove", quantity: 3, reason: "Sold" },
    });
  });

  it("always needs a reason, a direction and a quantity of at least 1", () => {
    const result = validateStockChange({ direction: "overwrite", quantity: 0, reason: "  " });
    expect(!result.valid && Object.keys(result.fields).sort()).toEqual(["direction", "quantity", "reason"]);
    expect(validateStockChange({ direction: "add", quantity: 1.5, reason: "x" }).valid).toBe(false);
    expect(validateStockChange({ direction: "add", quantity: -2, reason: "x" }).valid).toBe(false);
    expect(validateStockChange({ direction: "add", quantity: 1, reason: "x".repeat(501) }).valid).toBe(false);
  });
});

describe("POST /api/equipment-catalog/:id/stock (stock changes need a reason)", () => {
  function stockApp(options: { user?: { id: string; role: string }; rpcResult?: { data: unknown; error: unknown } } = {}) {
    const rpc = vi.fn().mockResolvedValue(
      options.rpcResult ?? { data: { id: 1, name: "Projector", totalStock: 12, availableStock: 8 }, error: null },
    );
    (globalThis as any).__mockSupabase = { rpc, from: vi.fn() };
    (globalThis as any).__mockUser = options.user ?? technicalSupport;
    const app = express();
    app.use(express.json());
    app.use("/api/equipment-catalog", equipmentCatalogRouter);
    return { app, rpc };
  }

  it("adds stock through the database function, recording who and why, and returns the new counts", async () => {
    const { app, rpc } = stockApp();

    const res = await request(app).post("/api/equipment-catalog/1/stock").send({ direction: "add", quantity: 2, reason: "New delivery" });

    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("change_equipment_stock", {
      p_catalog_id: 1,
      p_delta: 2,
      p_reason: "New delivery",
      p_user: "TS-0001",
    });
    expect(res.body.equipment).toEqual({ id: 1, name: "Projector", totalStock: 12, availableStock: 8, unusableNow: 0 });
  });

  it("returns available stock with the units out of use taken off, like the list does", async () => {
    const { app } = stockApp();
    const tables: Record<string, any> = {
      equipment: { select: () => ({ neq: () => Promise.resolve({ data: [{ id: 5, type: "Projector" }], error: null }) }) },
      equipment_unavailability: {
        select: () => ({ lte: () => ({ or: () => Promise.resolve({ data: [], error: null }) }) }),
      },
      equipment_booking: { select: () => ({ in: () => ({ not: () => Promise.resolve({ data: [], error: null }) }) }) },
    };
    (globalThis as any).__mockSupabase.from = vi.fn((name: string) => tables[name]);

    const res = await request(app).post("/api/equipment-catalog/1/stock").send({ direction: "add", quantity: 2, reason: "New delivery" });

    expect(res.body.equipment).toEqual({ id: 1, name: "Projector", totalStock: 12, availableStock: 7, unusableNow: 1 });
  });

  it("removes stock as a negative change", async () => {
    const { app, rpc } = stockApp();

    await request(app).post("/api/equipment-catalog/1/stock").send({ direction: "remove", quantity: 3, reason: "Sold off" });

    expect(rpc).toHaveBeenCalledWith("change_equipment_stock", expect.objectContaining({ p_delta: -3 }));
  });

  it("refuses a change with no reason, and never calls the database", async () => {
    const { app, rpc } = stockApp();

    const res = await request(app).post("/api/equipment-catalog/1/stock").send({ direction: "add", quantity: 2 });

    expect(res.status).toBe(400);
    expect(res.body.fields.reason).toBe("A reason is required.");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("says how many can be removed when too many were asked for", async () => {
    const { app } = stockApp({ rpcResult: { data: null, error: { message: "Cannot remove 5: only 2 can be removed" } } });

    const res = await request(app).post("/api/equipment-catalog/1/stock").send({ direction: "remove", quantity: 5, reason: "Sold" });

    expect(res.status).toBe(409);
    expect(res.body.removable).toBe(2);
    expect(res.body.error).toBe("Only 2 can be removed: the rest is reserved, out of use or held by requests.");
    expect(res.body.fields.quantity).toBe("At most 2.");
  });

  it("says so plainly when none of it can be removed", async () => {
    const { app } = stockApp({ rpcResult: { data: null, error: { message: "Cannot remove 1: only 0 can be removed" } } });

    const res = await request(app).post("/api/equipment-catalog/1/stock").send({ direction: "remove", quantity: 1, reason: "Sold" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/None of this item's stock can be removed/);
  });

  it("404s an unknown or malformed item, and 500s any other database failure", async () => {
    const missing = stockApp({ rpcResult: { data: null, error: { message: "Equipment item not found: 9" } } });
    expect((await request(missing.app).post("/api/equipment-catalog/9/stock").send({ direction: "add", quantity: 1, reason: "x" })).status).toBe(404);

    const bad = stockApp();
    expect((await request(bad.app).post("/api/equipment-catalog/abc/stock").send({ direction: "add", quantity: 1, reason: "x" })).status).toBe(404);
    expect(bad.rpc).not.toHaveBeenCalled();

    const broken = stockApp({ rpcResult: { data: null, error: { message: "boom" } } });
    expect((await request(broken.app).post("/api/equipment-catalog/1/stock").send({ direction: "add", quantity: 1, reason: "x" })).status).toBe(500);
  });

  it("is for Technical Support only", async () => {
    const { app, rpc } = stockApp({ user: coordinator });
    const res = await request(app).post("/api/equipment-catalog/1/stock").send({ direction: "add", quantity: 1, reason: "x" });
    expect(res.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("no longer lets either stock number be overwritten", async () => {
    const { app, rpc } = stockApp();
    const res = await request(app).patch("/api/equipment-catalog/1").send({ totalStock: 5, availableStock: 5 });
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("GET /api/equipment-catalog/:id/stock-history", () => {
  const rows = [
    { id: 2, change_type: "Removed", quantity: 3, total_before: 12, total_after: 9, reason: "Sold off", changed_by: "TS-0001", created_at: "2026-10-19T03:00:00Z" },
    { id: 1, change_type: "Added", quantity: 2, total_before: 10, total_after: 12, reason: "New delivery", changed_by: "TS-0002", created_at: "2026-10-18T03:00:00Z" },
  ];

  function historyApp(user = technicalSupport) {
    const q: Record<string, any> = {};
    for (const method of ["select", "eq", "order", "limit"]) q[method] = vi.fn(() => q);
    q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve);
    (globalThis as any).__mockSupabase = { from: vi.fn(() => q) };
    (globalThis as any).__mockUser = user;
    const app = express();
    app.use(express.json());
    app.use("/api/equipment-catalog", equipmentCatalogRouter);
    return { app, q };
  }

  it("lists who changed the stock, when, by how much and why, newest first", async () => {
    const { app, q } = historyApp();

    const res = await request(app).get("/api/equipment-catalog/1/stock-history");

    expect(res.status).toBe(200);
    expect(q.eq).toHaveBeenCalledWith("equipment_catalog_id", 1);
    expect(q.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(res.body.changes).toEqual([
      { id: 2, changeType: "Removed", quantity: 3, totalBefore: 12, totalAfter: 9, reason: "Sold off", changedBy: "TS-0001", createdAt: "2026-10-19T03:00:00Z" },
      { id: 1, changeType: "Added", quantity: 2, totalBefore: 10, totalAfter: 12, reason: "New delivery", changedBy: "TS-0002", createdAt: "2026-10-18T03:00:00Z" },
    ]);
  });

  it("is for Technical Support only", async () => {
    expect((await request(historyApp(coordinator).app).get("/api/equipment-catalog/1/stock-history")).status).toBe(403);
  });
});
