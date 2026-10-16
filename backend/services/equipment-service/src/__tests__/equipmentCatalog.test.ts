import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { equipmentCatalogRouter } from "../routes/equipmentCatalog.js";
import { validateCatalogChanges, validateNewCatalogItem } from "../lib/validateCatalogItem.js";

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

describe("validateCatalogChanges", () => {
  it("accepts either or both counts", () => {
    expect(validateCatalogChanges({ totalStock: 12 })).toEqual({ valid: true, value: { totalStock: 12 } });
    expect(validateCatalogChanges({ availableStock: "3" })).toEqual({ valid: true, value: { availableStock: 3 } });
  });

  it("needs at least one count", () => {
    expect(validateCatalogChanges({}).valid).toBe(false);
  });

  it("rejects negative and fractional counts", () => {
    expect(validateCatalogChanges({ availableStock: -1 }).valid).toBe(false);
    expect(validateCatalogChanges({ totalStock: 2.5 }).valid).toBe(false);
  });
});

describe("GET /api/equipment-catalog", () => {
  it("returns the catalog to any authenticated role", async () => {
    const { app } = buildApp({ user: coordinator });
    const res = await request(app).get("/api/equipment-catalog");

    expect(res.status).toBe(200);
    expect(res.body.equipmentCatalog).toEqual([{ id: 1, name: "Projector", totalStock: 10, availableStock: 6 }]);
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
    expect(res.body.equipment).toEqual({ id: 2, name: "Lectern", totalStock: 4, availableStock: 4 });
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

describe("PATCH /api/equipment-catalog/:id (E5-1 AC3)", () => {
  it("updates total and available stock", async () => {
    const { app, updateFn } = buildApp({
      writeResult: { data: { ...projector, total_stock: 12, available_stock: 9 }, error: null },
    });
    const res = await request(app).patch("/api/equipment-catalog/1").send({ totalStock: 12, availableStock: 9 });

    expect(res.status).toBe(200);
    expect(updateFn).toHaveBeenCalledWith({ total_stock: 12, available_stock: 9 });
    expect(res.body.equipment).toEqual({ id: 1, name: "Projector", totalStock: 12, availableStock: 9 });
  });

  it("keeps the other count when only one is sent", async () => {
    const { app, updateFn } = buildApp();
    await request(app).patch("/api/equipment-catalog/1").send({ availableStock: 2 });

    expect(updateFn).toHaveBeenCalledWith({ total_stock: 10, available_stock: 2 });
  });

  it("refuses available stock above total stock, including against the current total", async () => {
    const { app, updateFn } = buildApp();

    const both = await request(app).patch("/api/equipment-catalog/1").send({ totalStock: 3, availableStock: 5 });
    expect(both.status).toBe(400);
    expect(both.body.fields.availableStock).toBeDefined();

    // Lowering the total below what is currently available (6) is refused too.
    const lowered = await request(app).patch("/api/equipment-catalog/1").send({ totalStock: 4 });
    expect(lowered.status).toBe(400);

    expect(updateFn).not.toHaveBeenCalled();
  });

  it("400s negative numbers", async () => {
    const { app } = buildApp();
    const res = await request(app).patch("/api/equipment-catalog/1").send({ availableStock: -1 });

    expect(res.status).toBe(400);
  });

  it("404s an unknown or malformed item", async () => {
    const missing = buildApp({ current: null });
    expect((await request(missing.app).patch("/api/equipment-catalog/99").send({ totalStock: 1 })).status).toBe(404);

    const malformed = buildApp();
    expect((await request(malformed.app).patch("/api/equipment-catalog/abc").send({ totalStock: 1 })).status).toBe(404);
  });

  it("denies other roles", async () => {
    const { app, updateFn } = buildApp({ user: coordinator });
    const res = await request(app).patch("/api/equipment-catalog/1").send({ totalStock: 12 });

    expect(res.status).toBe(403);
    expect(updateFn).not.toHaveBeenCalled();
  });
});
