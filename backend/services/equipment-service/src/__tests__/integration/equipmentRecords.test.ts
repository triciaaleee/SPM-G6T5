/**
 * The catalog, unit and unavailability routes run against the REAL database
 * (real routers, real auth middleware, real Postgres): the constraints, enum,
 * cascades and stored functions the unit suites can only imitate. Only
 * throwaway "ZINT" rows are touched.
 */
import "../../lib/env.js"; // first: loads backend/.env before anything reads it
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { equipmentCatalogRouter } from "../../routes/equipmentCatalog.js";
import { equipmentUnitsRouter } from "../../routes/equipmentUnits.js";
import { appWith, bearer } from "../helpers/app.js";
import { RUN, SUPPORT_ID, itemName, seedSupportUser, teardown } from "./helpers.js";

const TS = bearer(SUPPORT_ID, "technical_support");
const catalogApp = () => appWith("/api/equipment-catalog", equipmentCatalogRouter);
const unitsApp = () => appWith("/api/equipment-units", equipmentUnitsRouter);

const NAME = itemName("Projector");
let catalogId: number;
let unitIds: number[] = [];

beforeAll(seedSupportUser, 30_000);
afterAll(teardown, 30_000);

const unitRows = async () => {
  const { data, error } = await supabaseAdmin.from("equipment").select("id, type, status, label, equipment_catalog_id").eq("equipment_catalog_id", catalogId).order("id");
  if (error) throw new Error(error.message);
  return data!;
};

describe("catalog", () => {
  it("adds an item and one Available unit per stock count", async () => {
    const res = await request(catalogApp()).post("/api/equipment-catalog").set("Authorization", TS).send({ name: NAME, totalStock: 3 });
    expect(res.status).toBe(201);
    catalogId = res.body.equipment.id;
    expect(res.body.equipment).toMatchObject({ name: NAME, totalStock: 3, availableStock: 3 });

    const units = await unitRows();
    expect(units).toHaveLength(3);
    for (const unit of units) expect(unit).toMatchObject({ type: NAME, status: "Available", label: null });
    unitIds = units.map((u: any) => u.id);
  });

  it("refuses a second item with the same name (real unique constraint)", async () => {
    const res = await request(catalogApp()).post("/api/equipment-catalog").set("Authorization", TS).send({ name: NAME, totalStock: 1 });
    expect(res.status).toBe(409);
    expect(res.body.fields).toEqual({ name: "Already in use." });
    expect(await unitRows()).toHaveLength(3);
  });

  it("shows the stock worked out from the units, for today and for another day", async () => {
    for (const query of [{}, { date: "2030-01-01" }]) {
      const res = await request(catalogApp()).get("/api/equipment-catalog").query(query).set("Authorization", TS);
      expect(res.status).toBe(200);
      const item = res.body.equipmentCatalog.find((i: any) => i.id === catalogId);
      expect(item).toEqual({ id: catalogId, name: NAME, totalStock: 3, availableStock: 3, unusableNow: 0, bookedCount: 0 });
    }
  });

  it("adds stock through change_equipment_stock and records who and why", async () => {
    const res = await request(catalogApp()).post(`/api/equipment-catalog/${catalogId}/stock`).set("Authorization", TS).send({ direction: "add", quantity: 2, reason: "ZINT bought more" });
    expect(res.status).toBe(200);
    expect(res.body.equipment).toMatchObject({ id: catalogId, totalStock: 5, availableStock: 5 });
    expect(await unitRows()).toHaveLength(5);

    const history = await request(catalogApp()).get(`/api/equipment-catalog/${catalogId}/stock-history`).set("Authorization", TS);
    expect(history.status).toBe(200);
    expect(history.body.changes).toEqual([
      expect.objectContaining({ changeType: "Added", quantity: 2, totalBefore: 3, totalAfter: 5, reason: "ZINT bought more", changedBy: SUPPORT_ID }),
    ]);
  });

  it("refuses to remove more than is free, saying how many can go, and changes nothing", async () => {
    const res = await request(catalogApp()).post(`/api/equipment-catalog/${catalogId}/stock`).set("Authorization", TS).send({ direction: "remove", quantity: 9, reason: "ZINT too many" });
    expect(res.status).toBe(409);
    expect(res.body.removable).toBe(5);
    expect(await unitRows()).toHaveLength(5);
  });

  it("removes free units, newest first", async () => {
    const before = await unitRows();
    const res = await request(catalogApp()).post(`/api/equipment-catalog/${catalogId}/stock`).set("Authorization", TS).send({ direction: "remove", quantity: 2, reason: "ZINT sold" });
    expect(res.status).toBe(200);
    expect(res.body.equipment.totalStock).toBe(3);
    const after = await unitRows();
    expect(after.map((u: any) => u.id)).toEqual(before.slice(0, 3).map((u: any) => u.id));
  });

  it("404s stock changes for an item that doesn't exist", async () => {
    const res = await request(catalogApp()).post("/api/equipment-catalog/2147483647/stock").set("Authorization", TS).send({ direction: "add", quantity: 1, reason: "ZINT nothing" });
    expect(res.status).toBe(404);
  });
});

describe("units and unavailability", () => {
  it("sets and clears a unit's label", async () => {
    unitIds = (await unitRows()).map((u: any) => u.id);
    let res = await request(unitsApp()).patch(`/api/equipment-units/${unitIds[0]}`).set("Authorization", TS).send({ label: ` ZINT-${RUN} ` });
    expect(res.status).toBe(200);
    expect(res.body.unit).toEqual({ id: unitIds[0], label: `ZINT-${RUN}` });

    res = await request(unitsApp()).patch(`/api/equipment-units/${unitIds[0]}`).set("Authorization", TS).send({ label: "" });
    expect(res.body.unit.label).toBeNull();
  });

  it("marks units unusable, recording who did it, and lists the period", async () => {
    const res = await request(unitsApp()).post("/api/equipment-units/mark").set("Authorization", TS)
      .send({ type: NAME, unitIds: unitIds.slice(0, 2), reason: "Damaged", startDate: "2099-01-01", endDate: "2099-01-05", note: "ZINT cracked" });
    expect(res.status).toBe(201);
    expect(res.body.periods).toHaveLength(2);
    expect(res.body.affectedEvents).toEqual([]);

    const { data } = await supabaseAdmin.from("equipment_unavailability").select("equipment_id, marked_by, reason").in("equipment_id", unitIds);
    expect(data).toHaveLength(2);
    for (const row of data!) expect(row).toMatchObject({ marked_by: SUPPORT_ID, reason: "Damaged" });

    const list = await request(unitsApp()).get("/api/equipment-units").query({ type: NAME }).set("Authorization", TS);
    expect(list.body.units.find((u: any) => u.id === unitIds[0]).periods).toHaveLength(1);
  });

  it("refuses to mark a unit that is already out of use for those dates", async () => {
    const res = await request(unitsApp()).post("/api/equipment-units/mark").set("Authorization", TS)
      .send({ type: NAME, unitIds: [unitIds[0]], reason: "Under Maintenance", startDate: "2099-01-03", endDate: "2099-01-04" });
    expect(res.status).toBe(409);
    expect(res.body.unitIds).toEqual([unitIds[0]]);
  });

  it("the database itself rejects a period that ends before it starts, or an unknown reason", async () => {
    const backwards = await supabaseAdmin.from("equipment_unavailability").insert({ equipment_id: unitIds[2], reason: "Damaged", start_date: "2099-02-05", end_date: "2099-02-01" });
    expect(backwards.error?.code).toBe("23514");
    const unknown = await supabaseAdmin.from("equipment_unavailability").insert({ equipment_id: unitIds[2], reason: "Lost", start_date: "2099-02-01" });
    expect(unknown.error?.code).toBe("23514");
  });

  it("removes one unit's period, only when it belongs to that unit", async () => {
    const { data } = await supabaseAdmin.from("equipment_unavailability").select("id, equipment_id").in("equipment_id", unitIds).order("id");
    const [first, second] = data!;
    let res = await request(unitsApp()).delete(`/api/equipment-units/${second.equipment_id}/unavailability/${first.id}`).set("Authorization", TS);
    expect(res.status).toBe(404);
    res = await request(unitsApp()).delete(`/api/equipment-units/${first.equipment_id}/unavailability/${first.id}`).set("Authorization", TS);
    expect(res.status).toBe(200);
    const left = await supabaseAdmin.from("equipment_unavailability").select("id").in("equipment_id", unitIds);
    expect(left.data!.map((r: any) => r.id)).toEqual([second.id]);
  });

  it("marks units usable again in bulk", async () => {
    const { data } = await supabaseAdmin.from("equipment_unavailability").select("id").in("equipment_id", unitIds);
    const res = await request(unitsApp()).post("/api/equipment-units/unavailability/clear").set("Authorization", TS).send({ periodIds: data!.map((r: any) => r.id) });
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
  });

  it("deleting a unit takes its periods with it (cascade)", async () => {
    await request(unitsApp()).post("/api/equipment-units/mark").set("Authorization", TS)
      .send({ type: NAME, unitIds: [unitIds[1]], reason: "Under Maintenance", startDate: "2099-03-01" });
    const before = await supabaseAdmin.from("equipment_unavailability").select("id").eq("equipment_id", unitIds[1]);
    expect(before.data).toHaveLength(1);

    const removed = await supabaseAdmin.from("equipment").delete().eq("id", unitIds[1]);
    expect(removed.error).toBeNull();
    const after = await supabaseAdmin.from("equipment_unavailability").select("id").eq("equipment_id", unitIds[1]);
    expect(after.data).toEqual([]);
  });

  it("the unit status is a real enum: an unknown value is refused", async () => {
    const res = await supabaseAdmin.from("equipment").update({ status: "Lost" }).eq("id", unitIds[0]);
    expect(res.error?.code).toBe("22P02");
  });
});
