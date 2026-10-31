import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/supabaseAdmin.js", async () => ({ supabaseAdmin: (await import("./helpers/mockDb.js")).supabaseAdminProxy }));

import { equipmentCatalogRouter } from "../routes/equipmentCatalog.js";
import { appWith, bearer, callRoute } from "./helpers/app.js";
import { createFakeDb } from "./helpers/fakeDb.js";
import { useDb } from "./helpers/mockDb.js";

const TS = bearer("TS-0001", "technical_support");
const COORD = bearer("COORD-0001", "coordinator");
const app = () => appWith("/api/equipment-catalog", equipmentCatalogRouter);

const stockRows = (...rows: [number, number, number, number][]) => ({
  data: rows.map(([catalog_id, total, unusable_now, available]) => ({ catalog_id, total, unusable_now, available })),
  error: null,
});
const seed = () => ({ equipment_catalog: [{ id: 1, name: "Projector" }, { id: 2, name: "Microphone" }, { id: 3, name: "Adapter" }] });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /", () => {
  it("lists the catalog by name with stock worked out from the units", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("catalog_stock_now", () => stockRows([1, 10, 2, 5], [2, 4, 0, 4]));

    const res = await request(app()).get("/api/equipment-catalog").set("Authorization", COORD);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      date: "2026-10-28",
      equipmentCatalog: [
        { id: 3, name: "Adapter", totalStock: 0, availableStock: 0, unusableNow: 0, bookedCount: 0 },
        { id: 2, name: "Microphone", totalStock: 4, availableStock: 4, unusableNow: 0, bookedCount: 0 },
        { id: 1, name: "Projector", totalStock: 10, availableStock: 5, unusableNow: 2, bookedCount: 3 },
      ],
    });
  });

  it("never reports a negative booked count", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("catalog_stock_now", () => stockRows([1, 2, 2, 2]));
    const res = await request(app()).get("/api/equipment-catalog").set("Authorization", TS);
    expect(res.body.equipmentCatalog.find((i: any) => i.id === 1).bookedCount).toBe(0);
  });

  it("shows another day when asked, trimming the date", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await request(app()).get("/api/equipment-catalog").query({ date: " 2026-12-25 " }).set("Authorization", TS);
    expect(res.body.date).toBe("2026-12-25");
    expect(db.rpcCalls[0].args.p_day).toBe("2026-12-25");
  });

  it("treats a blank date as today", async () => {
    useDb(createFakeDb(seed()));
    const res = await request(app()).get("/api/equipment-catalog").query({ date: "   " }).set("Authorization", TS);
    expect(res.body.date).toBe("2026-10-28");
  });

  it("400s a date that isn't real", async () => {
    useDb(createFakeDb(seed()));
    const res = await request(app()).get("/api/equipment-catalog").query({ date: "2026-02-30" }).set("Authorization", TS);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Enter a valid date.", fields: { date: "Enter a valid date." } });
  });

  it("ignores a repeated date parameter, falling back to today", async () => {
    useDb(createFakeDb(seed()));
    const res = await request(app()).get("/api/equipment-catalog?date=2026-12-25&date=2026-12-26").set("Authorization", TS);
    expect(res.body.date).toBe("2026-10-28");
  });

  it("500s when the catalog can't be read, or comes back empty-handed", async () => {
    const failing = useDb(createFakeDb(seed()));
    failing.failOn("equipment_catalog", "select");
    let res = await request(app()).get("/api/equipment-catalog").set("Authorization", TS);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the equipment catalog" });

    const nothing = useDb(createFakeDb(seed()));
    nothing.nullOn("equipment_catalog", "select");
    res = await request(app()).get("/api/equipment-catalog").set("Authorization", TS);
    expect(res.status).toBe(500);
  });

  it("500s when the stock can't be worked out", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("catalog_stock_now", () => ({ data: null, error: { message: "boom" } }));
    const res = await request(app()).get("/api/equipment-catalog").set("Authorization", TS);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the equipment catalog" });
  });

  it("401s without a database client", async () => {
    const out = await callRoute(equipmentCatalogRouter, "get", "/", {});
    expect(out).toEqual({ status: 401, body: { error: "Unauthenticated" } });
  });
});

describe("POST /", () => {
  const post = (body: unknown, token = TS) => request(app()).post("/api/equipment-catalog").set("Authorization", token).send(body as object);

  it("adds the item and one Available unit per stock count", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post({ name: " Laser Pointer ", totalStock: 3 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      equipment: { id: 4, name: "Laser Pointer", totalStock: 3, availableStock: 3, unusableNow: 0, bookedCount: 0 },
    });
    expect(db.rows("equipment_catalog").find((r) => r.id === 4)).toEqual({ id: 4, name: "Laser Pointer" });
    expect(db.rows("equipment")).toHaveLength(3);
    for (const unit of db.rows("equipment")) {
      expect(unit).toMatchObject({ type: "Laser Pointer", status: "Available", equipment_catalog_id: 4 });
    }
  });

  it("adds an item with no stock and no units", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post({ name: "Cable" });
    expect(res.status).toBe(201);
    expect(res.body.equipment.totalStock).toBe(0);
    expect(db.rows("equipment")).toHaveLength(0);
    expect(db.writes("equipment")).toHaveLength(0);
  });

  it("creates units in batches of 1000", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post({ name: "Chair", totalStock: 2500 });
    expect(res.status).toBe(201);
    expect(db.writes("equipment").map((c) => c.payload.length)).toEqual([1000, 1000, 500]);
    expect(db.rows("equipment")).toHaveLength(2500);
  });

  it("creates exactly 1000 units in one batch", async () => {
    const db = useDb(createFakeDb(seed()));
    await post({ name: "Chair", totalStock: 1000 });
    expect(db.writes("equipment").map((c) => c.payload.length)).toEqual([1000]);
  });

  it("403s anyone but Technical Support, without writing", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post({ name: "X" }, COORD);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
    expect(db.writes("equipment_catalog")).toHaveLength(0);
  });

  it("400s an invalid item", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post({ name: "", totalStock: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Invalid equipment item",
      fields: { name: "Enter an equipment name.", totalStock: "Total stock must be a whole number, 0 or more." },
    });
    expect(db.writes("equipment_catalog")).toHaveLength(0);
  });

  it("409s a name that already exists", async () => {
    const db = useDb(createFakeDb(seed(), { unique: { equipment_catalog: ["name"] } }));
    const res = await post({ name: "Projector", totalStock: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "An equipment item with that name already exists.", fields: { name: "Already in use." } });
    expect(db.rows("equipment")).toHaveLength(0);
  });

  it("500s when the item can't be saved", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment_catalog", "insert");
    const res = await post({ name: "X", totalStock: 1 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to add the equipment item" });
  });

  it("500s when the save returns no row", async () => {
    const db = useDb(createFakeDb(seed()));
    db.nullOn("equipment_catalog", "insert");
    expect((await post({ name: "X" })).status).toBe(500);
  });

  it("rolls the catalog entry back when its units can't be created", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment", "insert");
    const res = await post({ name: "X", totalStock: 3 });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to add the equipment item" });
    expect(db.rows("equipment_catalog").map((r) => r.name)).not.toContain("X");
    expect(db.rows("equipment")).toHaveLength(0);
  });

  it("rolls back units already created when a later batch fails", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment", "insert", -1, (c) => c.payload.length === 1);
    const res = await post({ name: "X", totalStock: 1001 });
    expect(res.status).toBe(500);
    expect(db.rows("equipment")).toHaveLength(0);
    expect(db.rows("equipment_catalog").map((r) => r.name)).not.toContain("X");
  });

  it("still answers 201 when the driver hands back no unit rows", async () => {
    const db = useDb(createFakeDb(seed()));
    db.nullOn("equipment", "insert");
    expect((await post({ name: "X", totalStock: 2 })).status).toBe(201);
  });

  it("401s without a client or user", async () => {
    expect(await callRoute(equipmentCatalogRouter, "post", "/", {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
    expect((await callRoute(equipmentCatalogRouter, "post", "/", { supabase: {} })).status).toBe(401);
    expect((await callRoute(equipmentCatalogRouter, "post", "/", { user: { id: "u", role: "technical_support" } })).status).toBe(401);
  });
});

describe("POST /:id/stock", () => {
  const post = (id: string, body: unknown, token = TS) =>
    request(app()).post(`/api/equipment-catalog/${id}/stock`).set("Authorization", token).send(body as object);
  const change = { direction: "add", quantity: 5, reason: "Bought" };

  it("adds stock through the database function and answers with the new numbers", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("change_equipment_stock", () => ({ data: { id: 1, name: "Projector", totalStock: 15 }, error: null }));
    db.onRpc("catalog_stock_now", () => stockRows([1, 15, 3, 9]));

    const res = await post("1", change);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ equipment: { id: 1, name: "Projector", totalStock: 15, availableStock: 9, unusableNow: 3, bookedCount: 3 } });
    expect(db.rpcCalls[0]).toEqual({
      fn: "change_equipment_stock",
      args: { p_catalog_id: 1, p_delta: 5, p_reason: "Bought", p_user: "TS-0001" },
    });
  });

  it("falls back to the saved total when today's stock can't be read", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("change_equipment_stock", () => ({ data: { id: 1, name: "Projector", totalStock: 15 }, error: null }));
    db.onRpc("catalog_stock_now", () => ({ data: null, error: { message: "boom" } }));
    const res = await post("1", change);
    expect(res.status).toBe(200);
    expect(res.body.equipment).toEqual({ id: 1, name: "Projector", totalStock: 15, availableStock: 15, unusableNow: 0, bookedCount: 0 });
  });

  it("403s anyone but Technical Support", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post("1", change, COORD);
    expect(res.status).toBe(403);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it.each(["0", "abc", "-1", "01", "1.5"])("404s the id %s", async (id) => {
    const db = useDb(createFakeDb(seed()));
    const res = await post(id, change);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Equipment item not found" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("400s an invalid change before calling the database", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post("1", { direction: "add", quantity: 0, reason: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid stock change");
    expect(Object.keys(res.body.fields).sort()).toEqual(["quantity", "reason"]);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("409s a removal larger than what is free, saying how many can go", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("change_equipment_stock", () => ({ data: null, error: { message: "only 3 can be removed" } }));
    const res = await post("1", { direction: "remove", quantity: 9, reason: "Sold" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Only 3 can be removed: the rest is reserved, out of use or held by requests.",
      fields: { quantity: "At most 3." },
      removable: 3,
    });
  });

  it("409s with a different message when nothing can be removed", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("change_equipment_stock", () => ({ data: null, error: { message: "only 0 can be removed" } }));
    const res = await post("1", { direction: "remove", quantity: 1, reason: "Sold" });
    expect(res.status).toBe(409);
    expect(res.body.removable).toBe(0);
    expect(res.body.error).toBe("None of this item's stock can be removed right now: it is all reserved, out of use or held by requests.");
    expect(res.body.fields).toEqual({ quantity: "At most 0." });
  });

  it("404s an item the database can't find", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("change_equipment_stock", () => ({ data: null, error: { message: "equipment item 9 not found" } }));
    const res = await post("9", change);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Equipment item not found" });
  });

  it("500s any other database error, including one with no message", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("change_equipment_stock", () => ({ data: null, error: { message: "deadlock" } }));
    let res = await post("1", change);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to change the stock" });

    db.onRpc("change_equipment_stock", () => ({ data: null, error: {} }));
    res = await post("1", change);
    expect(res.status).toBe(500);
  });

  it("reads an array id param by its first element, and 401s without a user", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("change_equipment_stock", () => ({ data: { id: 2, name: "Microphone", totalStock: 1 }, error: null }));
    const out = await callRoute(equipmentCatalogRouter, "post", "/:id/stock", {
      supabase: db, user: { id: "TS-0001", role: "technical_support" }, params: { id: ["2", "3"] }, body: change,
    });
    expect(out.status).toBe(200);
    expect(db.rpcCalls[0].args.p_catalog_id).toBe(2);

    expect(await callRoute(equipmentCatalogRouter, "post", "/:id/stock", { params: { id: "1" } })).toEqual({
      status: 401, body: { error: "Unauthenticated" },
    });
  });
});

describe("GET /:id/stock-history", () => {
  const get = (id: string, token = TS) => request(app()).get(`/api/equipment-catalog/${id}/stock-history`).set("Authorization", token);
  const change = (id: number, catalog: number, created_at: string, over: Record<string, unknown> = {}) => ({
    id, equipment_catalog_id: catalog, change_type: "Added", quantity: 2, total_before: 1, total_after: 3,
    reason: "Bought", changed_by: "TS-0001", created_at, ...over,
  });

  it("returns this item's changes, newest first, in the API's field names", async () => {
    useDb(createFakeDb({
      equipment_stock_changes: [
        change(1, 5, "2026-10-01T00:00:00.000Z"),
        change(2, 5, "2026-10-03T00:00:00.000Z", { change_type: "Removed", changed_by: null }),
        change(3, 6, "2026-10-02T00:00:00.000Z"),
      ],
    }));
    const res = await get("5");
    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([
      { id: 2, changeType: "Removed", quantity: 2, totalBefore: 1, totalAfter: 3, reason: "Bought", changedBy: null, createdAt: "2026-10-03T00:00:00.000Z" },
      { id: 1, changeType: "Added", quantity: 2, totalBefore: 1, totalAfter: 3, reason: "Bought", changedBy: "TS-0001", createdAt: "2026-10-01T00:00:00.000Z" },
    ]);
  });

  it("returns at most the 50 latest", async () => {
    useDb(createFakeDb({
      equipment_stock_changes: Array.from({ length: 60 }, (_, i) => change(i + 1, 5, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString())),
    }));
    const res = await get("5");
    expect(res.body.changes).toHaveLength(50);
    expect(res.body.changes[0].id).toBe(60);
    expect(res.body.changes[49].id).toBe(11);
  });

  it("403s anyone but Technical Support", async () => {
    useDb(createFakeDb());
    expect((await get("5", COORD)).status).toBe(403);
  });

  it.each(["0", "x", "-3"])("404s the id %s", async (id) => {
    useDb(createFakeDb());
    const res = await get(id);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Equipment item not found" });
  });

  it("500s when the history can't be read", async () => {
    const db = useDb(createFakeDb());
    db.failOn("equipment_stock_changes", "select");
    let res = await get("5");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the stock history" });

    const none = useDb(createFakeDb());
    none.nullOn("equipment_stock_changes", "select");
    res = await get("5");
    expect(res.status).toBe(500);
  });

  it("reads an array id param by its first element, and 401s without a user", async () => {
    const db = useDb(createFakeDb({ equipment_stock_changes: [change(1, 7, "2026-10-01T00:00:00.000Z")] }));
    const out = await callRoute(equipmentCatalogRouter, "get", "/:id/stock-history", {
      supabase: db, user: { id: "TS-0001", role: "technical_support" }, params: { id: ["7", "8"] },
    });
    expect(out.status).toBe(200);
    expect((out.body as any).changes).toHaveLength(1);

    expect(await callRoute(equipmentCatalogRouter, "get", "/:id/stock-history", { params: { id: "1" } })).toEqual({
      status: 401, body: { error: "Unauthenticated" },
    });
  });
});
