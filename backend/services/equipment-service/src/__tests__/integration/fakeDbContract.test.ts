/**
 * Contract test for helpers/fakeDb.ts: the same query is run against the REAL
 * Supabase project and against the in-memory fake, and the two answers must
 * match. The unit suites trust the fake, so wherever it answers differently
 * from Postgres/PostgREST a unit test could pass on a query that misbehaves in
 * production. Only throwaway "ZINT" catalog items and their units are touched,
 * and every query is limited to them.
 *
 * Not compared: equipment_booking and the request tables (their event_id is a
 * foreign key to events-service's table, so a throwaway row would mean writing
 * another service's data). They go through the same filter, order and update
 * code this test does cover.
 */
import "../../lib/env.js"; // first: loads backend/.env before anything reads it
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { createFakeDb } from "../helpers/fakeDb.js";
import { itemName, seedSupportUser, teardown, SUPPORT_ID } from "./helpers.js";

type Row = Record<string, any>;
type Db = { from: (table: string) => any };

let catalogIds: number[] = [];
let unitIds: number[] = [];
let seeded: { equipment_catalog: Row[]; equipment: Row[]; equipment_unavailability: Row[] } = { equipment_catalog: [], equipment: [], equipment_unavailability: [] };
const freshFake = (): Db => createFakeDb(seeded) as unknown as Db;

async function answer(query: PromiseLike<{ data: any; error: any }>) {
  const { data, error } = await query;
  return { error: error ? (error.code ?? "error") : null, data };
}
async function bothAnswer(build: (db: Db) => PromiseLike<{ data: any; error: any }>) {
  // The fake is rebuilt per call so writes in one scenario never leak into the next.
  const real = await answer(build(supabaseAdmin as unknown as Db));
  return { real, fake: await answer(build(freshFake())) };
}

beforeAll(async () => {
  await seedSupportUser();
  const items = ["apple", "Banana", "cherry"].map((s) => ({ name: itemName(s) }));
  const catalog = await supabaseAdmin.from("equipment_catalog").insert(items).select("*");
  if (catalog.error) throw new Error(catalog.error.message);
  catalogIds = catalog.data!.map((c: Row) => c.id).sort((a: number, b: number) => a - b);

  const units = [
    { type: "ZINT a", status: "Available", label: "alpha", equipment_catalog_id: catalogIds[0] },
    { type: "ZINT b", status: "Damaged", label: null, equipment_catalog_id: catalogIds[0] },
    { type: "ZINT c", status: "Under Maintenance", label: "Gamma", equipment_catalog_id: catalogIds[1] },
    { type: "ZINT d", status: "Available", label: "beta", equipment_catalog_id: catalogIds[2] },
  ];
  const inserted = await supabaseAdmin.from("equipment").insert(units).select("*");
  if (inserted.error) throw new Error(inserted.error.message);
  unitIds = inserted.data!.map((u: Row) => u.id).sort((a: number, b: number) => a - b);

  const periods = [
    { equipment_id: unitIds[0], reason: "Damaged", start_date: "2099-01-01", end_date: "2099-01-05", note: null, marked_by: SUPPORT_ID },
    { equipment_id: unitIds[0], reason: "Under Maintenance", start_date: "2099-02-01", end_date: null, note: "open", marked_by: null },
    { equipment_id: unitIds[1], reason: "Damaged", start_date: "2099-01-03", end_date: "2099-01-04", note: null, marked_by: SUPPORT_ID },
  ];
  const ins = await supabaseAdmin.from("equipment_unavailability").insert(periods).select("*");
  if (ins.error) throw new Error(ins.error.message);

  seeded = {
    equipment_catalog: (await supabaseAdmin.from("equipment_catalog").select("*").in("id", catalogIds)).data!,
    equipment: (await supabaseAdmin.from("equipment").select("*").in("id", unitIds)).data!,
    equipment_unavailability: (await supabaseAdmin.from("equipment_unavailability").select("*").in("equipment_id", unitIds)).data!,
  };
}, 30_000);

afterAll(async () => {
  // Units are not all tied to a catalog item that the shared teardown finds by prefix, so remove them by id first.
  if (unitIds.length > 0) await supabaseAdmin.from("equipment").delete().in("id", unitIds);
  await teardown();
}, 30_000);

const C = (db: Db, cols = "*") => db.from("equipment_catalog").select(cols).in("id", catalogIds);
const E = (db: Db, cols = "*") => db.from("equipment").select(cols).in("id", unitIds);
const U = (db: Db, cols = "*") => db.from("equipment_unavailability").select(cols).in("equipment_id", unitIds);

const PGRST116 = "PGRST116";
const scenarios: [string, (db: Db) => PromiseLike<{ data: any; error: any }>, string?][] = [
  ["eq on text", (db) => E(db).eq("label", "alpha").order("id")],
  ["eq on a foreign key", (db) => E(db).eq("equipment_catalog_id", catalogIds[0]).order("id")],
  ["eq with the id as a string (PostgREST casts it)", (db) => E(db).eq("id", String(unitIds[1])).order("id")],
  ["eq on an enum column", (db) => E(db).eq("status", "Damaged").order("id")],
  ["in on ids", (db) => E(db).in("id", unitIds.slice(0, 2)).order("id")],
  ["in with no ids matches nothing", (db) => E(db).in("id", []).order("id")],
  ["neq leaves NULLs out, as SQL does", (db) => E(db).neq("label", "alpha").order("id")],
  ["neq on a non-null column", (db) => E(db).neq("status", "Available").order("id")],
  ["eq(column, null) matches nothing in SQL", (db) => E(db).eq("label", null).order("id")],
  ["is(column, null) matches the NULL rows", (db) => E(db).is("label", null).order("id")],
  ["is(column, null) on a nullable date", (db) => U(db).is("end_date", null).order("id")],
  ["gte on a date column", (db) => U(db).gte("start_date", "2099-01-03").order("id")],
  ["lte on a date column leaves NULLs out", (db) => U(db).lte("end_date", "2099-01-04").order("id")],
  ["order by text ascending (collation: case)", (db) => E(db, "id, label").order("label").order("id")],
  ["order by text descending", (db) => C(db, "id, name").order("name", { ascending: false })],
  ["order by a nullable column ascending (NULLs last)", (db) => E(db, "id, label").order("label").order("id")],
  ["order by a nullable column descending (NULLs first)", (db) => E(db, "id, label").order("label", { ascending: false }).order("id")],
  ["order by two columns", (db) => E(db, "id, type, status").order("status").order("type", { ascending: false })],
  ["limit keeps the first rows of the order", (db) => E(db).order("id", { ascending: false }).limit(2)],
  ["projection of a column list", (db) => E(db, "id, type").order("id")],
  ["single with exactly one row", (db) => E(db).eq("id", unitIds[0]).single()],
  ["single with no row", (db) => E(db).eq("label", "no such label").single(), PGRST116],
  ["single with several rows", (db) => E(db).single(), PGRST116],
  ["maybeSingle with no row", (db) => E(db).eq("label", "no such label").maybeSingle()],
  ["maybeSingle with one row", (db) => E(db).eq("id", unitIds[1]).maybeSingle()],
  ["maybeSingle with several rows", (db) => E(db).maybeSingle(), PGRST116],
  ["update returns the changed rows", (db) => db.from("equipment").update({ label: "changed" }).in("id", unitIds.slice(0, 2)).select("id, label").order("id")],
  ["update that matches nothing returns an empty list", (db) => db.from("equipment").update({ label: "x" }).eq("id", -1).select("id")],
  ["update without select returns no data", (db) => db.from("equipment").update({ label: "quiet" }).in("id", unitIds.slice(0, 1))],
  ["delete returns the removed rows", (db) => db.from("equipment_unavailability").delete().eq("note", "open").in("equipment_id", unitIds).select("id, note")],
  ["delete that matches nothing returns an empty list", (db) => db.from("equipment_unavailability").delete().eq("note", "no such note").in("equipment_id", unitIds).select("id")],
];

describe("the in-memory fake answers like the real database", () => {
  it.each(scenarios)("%s", async (_title, build, expectedError) => {
    const { real, fake } = await bothAnswer(build);
    expect(real.error).toBe(expectedError ?? null);
    expect(fake.error).toBe(real.error);
    // ids differ between the real table and the seeded copy only if the fake invented some, so compare the rows as they are.
    expect(fake.data).toEqual(real.data);
  });
});
