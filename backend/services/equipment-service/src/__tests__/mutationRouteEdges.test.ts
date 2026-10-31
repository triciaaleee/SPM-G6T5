/**
 * Edge cases that pin down route behaviour mutation testing showed the other
 * suites left unchecked: exact error bodies, id/date/number boundaries, an
 * error that must win over rows returned with it, and queries that must be
 * skipped when they aren't needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/supabaseAdmin.js", async () => ({ supabaseAdmin: (await import("./helpers/mockDb.js")).supabaseAdminProxy }));

import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";
import { equipmentCatalogRouter } from "../routes/equipmentCatalog.js";
import { equipmentRequestsRouter } from "../routes/equipmentRequests.js";
import { equipmentUnitsRouter } from "../routes/equipmentUnits.js";
import { appWith, bearer } from "./helpers/app.js";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";
import { useDb } from "./helpers/mockDb.js";
import { detailEvent, infoEvent, installWorld, type World } from "./helpers/world.js";

const TS = bearer("TS-0001", "technical_support");
const COORD = bearer("COORD-1", "coordinator");
const catalogApp = () => appWith("/api/equipment-catalog", equipmentCatalogRouter);
const unitsApp = () => appWith("/api/equipment-units", equipmentUnitsRouter);
const requestsApp = () => appWith("/api/equipment-requests", equipmentRequestsRouter);

/** The next matching read returns what it found AND an error: the error has to win. */
const errorWithRows = (db: FakeDb, table: string, op: "select" | "insert" | "update", nth = 1, code?: string) => {
  let seen = 0;
  db.mapOn(table, op, (r) => (++seen === nth ? { data: r.data, error: { message: "boom", ...(code ? { code } : {}) } } : r));
};

let world: World;
beforeEach(() => {
  world = installWorld();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setPublisherForTest(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const requestRow = (id: number, event_id: number, over: Record<string, any> = {}) => ({
  id, event_id, coordinator_id: "COORD-1", status: "Requested", fulfillment_note: null, created_at: "2026-10-01T00:00:00.000Z", ...over,
});
const itemRow = (id: number, request_id: number, over: Record<string, any> = {}) => ({
  id, request_id, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0, equipment_catalog_id: 1, ...over,
});
const units = (catalogId: number, ids: number[]) => ids.map((id) => ({ id, type: "Projector", status: "Available", label: null, equipment_catalog_id: catalogId }));
const requestSeed = (extra: Record<string, any[]> = {}) => ({
  equipment_catalog: [{ id: 1, name: "Projector" }, { id: 2, name: "Microphone" }],
  equipment_requests: [requestRow(1, 7)],
  equipment_request_items: [itemRow(1, 1)],
  equipment: units(1, [10, 11, 12]),
  ...extra,
});

describe("equipment catalog routes", () => {
  it("answers 500 when an error comes back with rows (list, add, history)", async () => {
    const list = useDb(createFakeDb({ equipment_catalog: [{ id: 1, name: "P" }] }));
    errorWithRows(list, "equipment_catalog", "select");
    expect((await request(catalogApp()).get("/api/equipment-catalog").set("Authorization", TS)).status).toBe(500);

    const add = useDb(createFakeDb());
    errorWithRows(add, "equipment_catalog", "insert", 1, "XX000");
    const created = await request(catalogApp()).post("/api/equipment-catalog").set("Authorization", TS).send({ name: "X", totalStock: 1 });
    expect(created.status).toBe(500);
    expect(created.body).toEqual({ error: "Failed to add the equipment item" });

    const history = useDb(createFakeDb({ equipment_stock_changes: [{ id: 1, equipment_catalog_id: 5, change_type: "Added", quantity: 1, total_before: 0, total_after: 1, reason: "r", changed_by: null, created_at: "2026-10-01T00:00:00.000Z" }] }));
    errorWithRows(history, "equipment_stock_changes", "select");
    expect((await request(catalogApp()).get("/api/equipment-catalog/5/stock-history").set("Authorization", TS)).status).toBe(500);
  });

  it("403s a non-Technical-Support user with the message, for stock changes and history", async () => {
    useDb(createFakeDb());
    const stock = await request(catalogApp()).post("/api/equipment-catalog/1/stock").set("Authorization", COORD).send({ direction: "add", quantity: 1, reason: "r" });
    expect(stock.status).toBe(403);
    expect(stock.body).toEqual({ error: "Access denied" });
    const history = await request(catalogApp()).get("/api/equipment-catalog/1/stock-history").set("Authorization", COORD);
    expect(history.status).toBe(403);
    expect(history.body).toEqual({ error: "Access denied" });
  });

  it("accepts multi-digit ids and refuses ids with anything after the digits", async () => {
    const db = useDb(createFakeDb());
    db.onRpc("change_equipment_stock", () => ({ data: { id: 12, name: "P", totalStock: 1 }, error: null }));
    const change = { direction: "add", quantity: 1, reason: "r" };
    for (const path of ["stock", "stock-history"]) {
      const method = path === "stock" ? "post" : "get";
      const ok = await (request(catalogApp()) as any)[method](`/api/equipment-catalog/12/${path}`).set("Authorization", TS).send(change);
      expect(ok.status).toBe(200);
      for (const id of ["12abc", "1x", "1-2"]) {
        const bad = await (request(catalogApp()) as any)[method](`/api/equipment-catalog/${id}/${path}`).set("Authorization", TS).send(change);
        expect(bad.status).toBe(404);
        expect(bad.body).toEqual({ error: "Equipment item not found" });
      }
    }
  });

  it("reads a multi-digit 'only N can be removed'", async () => {
    const db = useDb(createFakeDb());
    db.onRpc("change_equipment_stock", () => ({ data: null, error: { message: "Cannot remove 40: only 12 can be removed" } }));
    const res = await request(catalogApp()).post("/api/equipment-catalog/1/stock").set("Authorization", TS).send({ direction: "remove", quantity: 40, reason: "r" });
    expect(res.status).toBe(409);
    expect(res.body.removable).toBe(12);
    expect(res.body.fields).toEqual({ quantity: "At most 12." });
  });
});

describe("equipment request routes", () => {
  beforeEach(() => {
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7) } });
    world.info = [infoEvent(7)];
    setPublisherForTest(createFakePublisher());
  });

  it("answers 500 when an error comes back with rows", async () => {
    // POST /: the request row, then its items
    const post = { eventId: 7, items: [{ equipmentCatalogId: 1, quantity: 1 }] };
    const req = useDb(createFakeDb(requestSeed({ equipment_requests: [] })));
    errorWithRows(req, "equipment_requests", "insert");
    let res = await request(requestsApp()).post("/api/equipment-requests").set("Authorization", COORD).send(post);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to record the equipment request" });

    const items = useDb(createFakeDb(requestSeed({ equipment_requests: [] })));
    errorWithRows(items, "equipment_request_items", "insert");
    res = await request(requestsApp()).post("/api/equipment-requests").set("Authorization", COORD).send(post);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to record the equipment items" });

    // GET /: coordinator branch, Technical Support branch, and one event's page
    const coord = useDb(createFakeDb(requestSeed()));
    errorWithRows(coord, "equipment_requests", "select");
    expect((await request(requestsApp()).get("/api/equipment-requests").query({ eventId: "7" }).set("Authorization", COORD)).status).toBe(500);

    const support = useDb(createFakeDb(requestSeed()));
    errorWithRows(support, "equipment_requests", "select");
    expect((await request(requestsApp()).get("/api/equipment-requests").set("Authorization", TS)).status).toBe(500);

    const event = useDb(createFakeDb(requestSeed()));
    errorWithRows(event, "equipment_requests", "select");
    expect((await request(requestsApp()).get("/api/equipment-requests/event/7").set("Authorization", TS)).status).toBe(500);
  });

  it("answers 500 when the updated request comes back with an error alongside its row", async () => {
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7) } });
    const amend = useDb(createFakeDb(requestSeed()));
    amend.onRpc("amend_equipment_request", () => ({ data: { changes: [] }, error: null }));
    errorWithRows(amend, "equipment_requests", "select", 2); // 1st read: who may change it; 2nd: the view
    const put = await request(requestsApp()).put("/api/equipment-requests/1/items").set("Authorization", COORD).send({ items: [{ itemId: 1, equipmentCatalogId: 1, quantity: 1 }] });
    expect(put.status).toBe(500);
    expect(put.body).toEqual({ error: "Failed to load the updated equipment request" });
  });

  it("403s Technical Support looking at one event with the message, and an event events-service didn't return", async () => {
    useDb(createFakeDb(requestSeed()));
    const role = await request(requestsApp()).get("/api/equipment-requests/event/7").set("Authorization", COORD);
    expect(role.status).toBe(403);
    expect(role.body).toEqual({ error: "Access denied" });

    world.info = [];
    const missing = await request(requestsApp()).get("/api/equipment-requests/event/7").set("Authorization", TS);
    expect(missing.status).toBe(403);
    expect(missing.body).toEqual({ error: "Access denied" });
  });

  it("refuses a malformed event id without touching the database", async () => {
    for (const id of ["abc", "0", "-1", "1x"]) {
      const db = useDb(createFakeDb(requestSeed()));
      const res = await request(requestsApp()).get(`/api/equipment-requests/event/${id}`).set("Authorization", TS);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Access denied" });
      expect(db.calls).toHaveLength(0);
    }
  });

  it("picks its own event out of whatever events-service returns", async () => {
    world.infoUnfiltered = true;
    world.info = [infoEvent(99, { name: "Other" }), infoEvent(7, { name: "Mine" })];
    useDb(createFakeDb(requestSeed()));
    const res = await request(requestsApp()).get("/api/equipment-requests/event/7").set("Authorization", TS);
    expect(res.status).toBe(200);
    expect(res.body.event.name).toBe("Mine");

    world.info = [infoEvent(99)];
    expect((await request(requestsApp()).get("/api/equipment-requests/event/7").set("Authorization", TS)).status).toBe(403);
  });

  it("doesn't look for reserved units when there are no items, or no bookings", async () => {
    const noItems = useDb(createFakeDb(requestSeed({ equipment_request_items: [] })));
    await request(requestsApp()).get("/api/equipment-requests/event/7").set("Authorization", TS);
    expect(noItems.calls.some((c) => c.table === "equipment_booking")).toBe(false);

    const noBookings = useDb(createFakeDb(requestSeed()));
    await request(requestsApp()).get("/api/equipment-requests/event/7").set("Authorization", TS);
    expect(noBookings.calls.some((c) => c.table === "equipment" && c.columns === "id, label")).toBe(false);
  });

  it("lists requests oldest first on an event's page", async () => {
    useDb(createFakeDb(requestSeed({ equipment_requests: [requestRow(1, 7, { created_at: "2026-10-03T00:00:00.000Z" }), requestRow(2, 7, { created_at: "2026-10-01T00:00:00.000Z" })], equipment_request_items: [itemRow(1, 1), itemRow(2, 2)] })));
    const res = await request(requestsApp()).get("/api/equipment-requests/event/7").set("Authorization", TS);
    expect(res.body.equipmentRequests.map((r: any) => r.id)).toEqual([2, 1]);
  });

  it("reuses the event windows it already fetched when working out flags for the whole queue", async () => {
    world.info = [infoEvent(7), infoEvent(8, { startTime: "11:00", endTime: "13:00" })];
    useDb(createFakeDb(requestSeed({
      equipment_requests: [requestRow(1, 7), requestRow(2, 8)],
      equipment_request_items: [itemRow(1, 1), itemRow(2, 2)],
      equipment_booking: [
        { id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" },
        { id: 2, equipment_id: 10, event_id: 8, request_item_id: 2, status: "Reserved" },
      ],
    })));
    await request(requestsApp()).get("/api/equipment-requests").set("Authorization", TS);
    expect(world.urls.filter((u) => u.includes("venue-booking-info"))).toHaveLength(1);
  });

  it("refuses a malformed event id for a coordinator's list with the message", async () => {
    useDb(createFakeDb(requestSeed()));
    const res = await request(requestsApp()).get("/api/equipment-requests").query({ eventId: "7x" }).set("Authorization", COORD);
    expect(res.status).toBe(400);
  });

  describe("PATCH status: when the event's window is needed", () => {
    const patch = (body: unknown) => request(requestsApp()).patch("/api/equipment-requests/1").set("Authorization", TS).send(body as object);
    const lookups = () => world.urls.filter((u) => u.includes("venue-booking-info"));

    it("asks for it when any one item is growing, even if another isn't", async () => {
      const db = useDb(createFakeDb(requestSeed({
        equipment_request_items: [itemRow(1, 1, { quantity: 2, quantity_fulfilled: 2 }), itemRow(2, 1, { equipment_type: "Microphone", equipment_catalog_id: 2, quantity: 1 })],
        equipment: [...units(1, [10, 11]), ...units(2, [20])],
      })));
      const res = await patch({ status: "Arranged" });
      expect(res.status).toBe(200);
      expect(db.rpcCalls[0].args.p_claims).toEqual([{ itemId: 2, unitIds: [20] }]);
      // The claim is made, and stored, against the event's own window (10:00-12:00 on 2026-12-01).
      expect(db.rpcCalls[0].args.p_window_start_ms).toBe(Date.parse("2026-12-01T10:00:00.000Z"));
      expect(db.rpcCalls[0].args.p_window_end_ms).toBe(Date.parse("2026-12-01T12:00:00.000Z"));
    });

    it("doesn't ask for it when no item is growing, even if one is unchanged", async () => {
      useDb(createFakeDb(requestSeed()));
      const res = await patch({ status: "Requested" }); // item holds 0, stays 0: delta 0
      expect(res.status).toBe(200);
      expect(lookups()).toHaveLength(1); // only the lookup for the notice, after the write
    });

    it("lets an item with no catalog link stay as it is (delta 0)", async () => {
      useDb(createFakeDb(requestSeed({ equipment_request_items: [itemRow(1, 1, { equipment_catalog_id: null, quantity_fulfilled: 0 })] })));
      const res = await patch({ status: "Requested" });
      expect(res.status).toBe(200);
    });
  });

  describe("changing a request: who may", () => {
    it("403s a Technical Support user whose id happens to be the event's coordinator", async () => {
      const db = useDb(createFakeDb(requestSeed()));
      const impostor = bearer("COORD-1", "technical_support"); // same id as the event's coordinator
      const put = await request(requestsApp()).put("/api/equipment-requests/1/items").set("Authorization", impostor).send({ items: [{ itemId: 1, equipmentCatalogId: 1, quantity: 1 }] });
      expect(put.status).toBe(403);
      expect(put.body).toEqual({ error: "Only the assigned coordinator can change an equipment request" });
      const cancel = await request(requestsApp()).post("/api/equipment-requests/1/cancel").set("Authorization", impostor);
      expect(cancel.status).toBe(403);
      expect(db.rpcCalls).toHaveLength(0);
    });
  });

  it("previews with a quantity of exactly zero, and refuses text that merely starts with a number", async () => {
    world.info = [infoEvent(7)];
    useDb(createFakeDb(requestSeed()));
    const get = (q: string) => request(requestsApp()).get("/api/equipment-requests/items/1/unit-preview").query({ quantity: q }).set("Authorization", TS);
    expect((await get("0")).status).toBe(200);
    for (const q of ["1x", "2abc"]) {
      const res = await get(q);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "A valid quantity is required" });
    }
  });
});

describe("equipment unit routes", () => {
  const get = (path: string, query: Record<string, string> = {}) => request(unitsApp()).get(`/api/equipment-units${path}`).query(query).set("Authorization", TS);
  const seed = (extra: Record<string, any[]> = {}) => ({
    equipment_catalog: [{ id: 1, name: "Projector" }],
    equipment: [
      { id: 3, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
      { id: 1, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
      { id: 2, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 },
    ],
    ...extra,
  });

  it("lists units of one type in id order", async () => {
    useDb(createFakeDb(seed()));
    expect((await get("", { type: "Projector" })).body.units.map((u: any) => u.id)).toEqual([1, 2, 3]);
    expect((await get("")).body.units.map((u: any) => u.id)).toEqual([1, 2, 3]);
  });

  it("previews impact with units in id order and no unit read for an unknown type", async () => {
    useDb(createFakeDb(seed()));
    const res = await get("/impact", { type: "Projector", startDate: "2026-12-01" });
    expect(res.body.units.map((u: any) => u.id)).toEqual([1, 2, 3]);

    const db = useDb(createFakeDb(seed()));
    await get("/impact", { type: "Laser", startDate: "2026-12-01" });
    expect(db.calls.some((c) => c.table === "equipment")).toBe(false);
  });

  it("answers 500 when an error comes back with rows (list, impact, mark)", async () => {
    const list = useDb(createFakeDb(seed()));
    errorWithRows(list, "equipment", "select");
    expect((await get("")).status).toBe(500);

    const impact = useDb(createFakeDb(seed()));
    errorWithRows(impact, "equipment", "select");
    expect((await get("/impact", { type: "Projector", startDate: "2026-12-01" })).status).toBe(500);

    const mark = useDb(createFakeDb(seed()));
    errorWithRows(mark, "equipment_unavailability", "insert");
    const res = await request(unitsApp()).post("/api/equipment-units/mark").set("Authorization", TS)
      .send({ type: "Projector", unitIds: [1], reason: "Damaged", startDate: "2026-12-01" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to mark the equipment unusable" });
  });

  it("trims the dates of an impact query, and accepts a quantity of exactly 1", async () => {
    useDb(createFakeDb(seed()));
    const res = await get("/impact", { type: "Projector", startDate: " 2026-12-01 ", endDate: " 2026-12-03 ", quantity: "1" });
    expect(res.status).toBe(200);
    expect(res.body.suggested).toHaveLength(1);
  });

  it("accepts multi-digit ids and refuses ids with anything after the digits", async () => {
    useDb(createFakeDb(seed({ equipment: [{ id: 12, type: "Projector", status: "Available", label: null, equipment_catalog_id: 1 }] })));
    expect((await request(unitsApp()).patch("/api/equipment-units/12").set("Authorization", TS).send({ label: "x" })).status).toBe(200);
    for (const id of ["12abc", "1x"]) {
      const patch = await request(unitsApp()).patch(`/api/equipment-units/${id}`).set("Authorization", TS).send({ label: "x" });
      expect(patch.status).toBe(400);
      expect(patch.body).toEqual({ error: "A valid unit id is required" });
      const del = await request(unitsApp()).delete(`/api/equipment-units/${id}/unavailability/1`).set("Authorization", TS);
      expect(del.status).toBe(400);
      const delPeriod = await request(unitsApp()).delete("/api/equipment-units/1/unavailability/" + id).set("Authorization", TS);
      expect(delPeriod.status).toBe(400);
    }
  });

  it("refuses a list of units or periods when any one of them is invalid", async () => {
    useDb(createFakeDb(seed()));
    const mark = await request(unitsApp()).post("/api/equipment-units/mark").set("Authorization", TS)
      .send({ type: "Projector", unitIds: [1, "x"], reason: "Damaged", startDate: "2026-12-01" });
    expect(mark.status).toBe(400);
    expect(mark.body.fields).toEqual({ unitIds: "Choose at least one unit." });

    const db = useDb(createFakeDb(seed({ equipment_unavailability: [{ id: 1, equipment_id: 1, reason: "Damaged", start_date: "2026-12-01", end_date: null, note: null }] })));
    const clear = await request(unitsApp()).post("/api/equipment-units/unavailability/clear").set("Authorization", TS).send({ periodIds: [1, "x"] });
    expect(clear.status).toBe(400);
    expect(db.rows("equipment_unavailability")).toHaveLength(1);
  });

  it("won't mark a unit that has no catalog link as a unit of an unknown type", async () => {
    const db = useDb(createFakeDb(seed({ equipment: [{ id: 1, type: "Mystery", status: "Available", label: null, equipment_catalog_id: null }] })));
    const res = await request(unitsApp()).post("/api/equipment-units/mark").set("Authorization", TS)
      .send({ type: "Laser", unitIds: [1], reason: "Damaged", startDate: "2026-12-01" });
    expect(res.status).toBe(404);
    expect(db.writes("equipment_unavailability")).toHaveLength(0);
  });

  it("asks only for the period ids when clearing, and for the id when checking a period", async () => {
    const db = useDb(createFakeDb(seed({ equipment_unavailability: [{ id: 1, equipment_id: 1, reason: "Damaged", start_date: "2026-12-01", end_date: null, note: null }] })));
    await request(unitsApp()).post("/api/equipment-units/unavailability/clear").set("Authorization", TS).send({ periodIds: [1] });
    expect(db.calls.find((c) => c.op === "delete")!.columns).toBe("id");

    const lookup = useDb(createFakeDb(seed({ equipment_unavailability: [{ id: 1, equipment_id: 1, reason: "Damaged", start_date: "2026-12-01", end_date: null, note: null }] })));
    await request(unitsApp()).delete("/api/equipment-units/1/unavailability/1").set("Authorization", TS);
    expect(lookup.calls.find((c) => c.op === "select")!.columns).toBe("id");
  });
});
