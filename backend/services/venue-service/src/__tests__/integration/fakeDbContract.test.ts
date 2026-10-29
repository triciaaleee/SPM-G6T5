/**
 * Contract test for helpers/fakeDb.ts: the same query is run against the REAL
 * Supabase project and against the in-memory fake, and the two answers must
 * match. The unit suites trust the fake, so wherever it answers differently
 * from Postgres/PostgREST a unit test could pass on a query that misbehaves in
 * production. Only throwaway "ZINT" rows are touched, and every query is
 * limited to them, so the shared dev data is never read into the comparison.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../../lib/env.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { createFakeDb } from "../helpers/fakeDb.js";
import { RUN, STAFF_ID, seedUsers, teardown } from "./helpers.js";

type Row = Record<string, any>;
type Db = { from: (table: string) => any };

const name = (suffix: string) => `ZINT-FC ${RUN} ${suffix}`;
let venueIds: number[] = [];

/** What a query answered, reduced to what callers can observe. */
async function answer(query: PromiseLike<{ data: any; error: any }>) {
  const { data, error } = await query;
  return { error: error ? (error.code ?? "error") : null, data };
}

async function bothAnswer(build: (db: Db) => PromiseLike<{ data: any; error: any }>) {
  // The fake is rebuilt per call so writes in one scenario never leak into the next.
  const real = await answer(build(supabaseAdmin as unknown as Db));
  return { real, fake: await answer(build(freshFake())) };
}

let seeded: { venues: Row[]; venue_unavailability: Row[] } = { venues: [], venue_unavailability: [] };
const freshFake = (): Db => createFakeDb(seeded) as unknown as Db;

beforeAll(async () => {
  await seedUsers();
  const venues = [
    { name: name("apple"), location: "North", description: "first", capacity: 10, staff_id: STAFF_ID, setup_minutes: 0 },
    { name: name("Banana"), location: "north", description: null, capacity: 20, staff_id: null, setup_minutes: 5 },
    { name: name("cherry"), location: "South", description: "third", capacity: 30, staff_id: STAFF_ID, setup_minutes: 10 },
    { name: name("Apple 2"), location: "East", description: null, capacity: 40, staff_id: null, setup_minutes: 15 },
    { name: name("9 hall"), location: "West", description: "fifth", capacity: 50, staff_id: STAFF_ID, setup_minutes: 20 },
    { name: name("10 hall"), location: "west", description: "sixth", capacity: 60, staff_id: null, setup_minutes: 25 },
    { name: name("hall-a"), location: "X", description: "seventh", capacity: 70, staff_id: null, setup_minutes: 30 },
    { name: name("hall b"), location: "X", description: "eighth", capacity: 80, staff_id: null, setup_minutes: 35 },
    { name: name("hallc"), location: "X", description: "ninth", capacity: 90, staff_id: null, setup_minutes: 40 },
  ];
  const inserted = await supabaseAdmin.from("venues").insert(venues).select("*");
  if (inserted.error) throw new Error(inserted.error.message);
  venueIds = inserted.data!.map((v: Row) => v.id).sort((a: number, b: number) => a - b);

  const [v1, v2] = venueIds;
  const periods = [
    { venue_id: v1, start_date: "2026-11-01", end_date: "2026-11-03", all_day: true, start_time: null, end_time: null, reason: "all day", created_by: null },
    { venue_id: v1, start_date: "2026-11-10", end_date: "2026-11-10", all_day: false, start_time: "09:00", end_time: "13:00", reason: "morning", created_by: STAFF_ID },
    { venue_id: v2, start_date: "2026-11-05", end_date: "2026-11-06", all_day: false, start_time: "14:00", end_time: "18:00", reason: "afternoon", created_by: STAFF_ID },
  ];
  const ins = await supabaseAdmin.from("venue_unavailability").insert(periods).select("*");
  if (ins.error) throw new Error(ins.error.message);

  seeded = {
    venues: (await supabaseAdmin.from("venues").select("*").in("id", venueIds)).data!,
    venue_unavailability: (await supabaseAdmin.from("venue_unavailability").select("*").in("venue_id", venueIds)).data!,
  };
}, 30_000);

afterAll(async () => {
  // Most of these venues have no staff_id, so the shared teardown (which deletes by staff_id) would miss them.
  // venue_unavailability rows cascade with their venue.
  if (venueIds.length > 0) await supabaseAdmin.from("venues").delete().in("id", venueIds);
  await teardown();
}, 30_000);

const V = (db: Db, cols = "*") => db.from("venues").select(cols).in("id", venueIds);
const P = (db: Db, cols = "*") => db.from("venue_unavailability").select(cols).in("venue_id", venueIds);

/** Scenarios: [title, query builder]. Every query ends in a stable order (or a single row) so a tie cannot reorder. */
const PGRST116 = "PGRST116"; // "expected one row": what single()/maybeSingle() return for 0 or several rows
const scenarios: [string, (db: Db) => PromiseLike<{ data: any; error: any }>, string?][] = [
  ["eq on text", (db) => V(db).eq("location", "North").order("id")],
  ["eq on an integer column", (db) => V(db).eq("capacity", 30).order("id")],
  ["eq with the id as a string (PostgREST casts it)", (db) => V(db).eq("id", String(venueIds[2])).order("id")],
  ["in with ids as strings", (db) => V(db).in("id", venueIds.slice(0, 3).map(String)).order("id")],
  ["in with no ids matches nothing", (db) => V(db).in("capacity", []).order("id")],
  ["eq(column, null) matches nothing in SQL", (db) => V(db).eq("staff_id", null).order("id")],
  ["is(column, null) matches the NULL rows", (db) => V(db).is("staff_id", null).order("id")],
  ["is(column, null) on a text column", (db) => V(db).is("description", null).order("id")],
  ["is(column, true)", (db) => V(db).is("active", true).order("id")],
  ["lt", (db) => V(db).lt("capacity", 30).order("id")],
  ["lte", (db) => V(db).lte("capacity", 30).order("id")],
  ["gt", (db) => V(db).gt("capacity", 30).order("id")],
  ["gte", (db) => V(db).gte("capacity", 30).order("id")],
  ["gt on a nullable time column leaves NULLs out", (db) => P(db).gt("start_time", "09:00").order("id")],
  ["lt on a nullable time column leaves NULLs out", (db) => P(db).lt("start_time", "14:00").order("id")],
  ["lte on a nullable time column", (db) => P(db).lte("end_time", "13:00").order("id")],
  ["gte on a date column", (db) => P(db).gte("start_date", "2026-11-05").order("id")],
  ["lte on a date column", (db) => P(db).lte("end_date", "2026-11-03").order("id")],
  ["order by text ascending (collation: case, digits, punctuation)", (db) => V(db, "id, name").order("name")],
  ["order by text descending", (db) => V(db, "id, name").order("name", { ascending: false })],
  ["order by a nullable column ascending (NULLs last)", (db) => V(db, "id, staff_id").order("staff_id").order("id")],
  ["order by a nullable column descending (NULLs first)", (db) => V(db, "id, staff_id").order("staff_id", { ascending: false }).order("id")],
  ["order with nullsFirst on an ascending sort", (db) => V(db, "id, staff_id").order("staff_id", { nullsFirst: true }).order("id")],
  ["order with nullsFirst false on a descending sort", (db) => V(db, "id, staff_id").order("staff_id", { ascending: false, nullsFirst: false }).order("id")],
  ["order by an integer column descending", (db) => V(db, "id, capacity").order("capacity", { ascending: false })],
  ["order by two columns", (db) => V(db, "id, location, capacity").order("location").order("capacity", { ascending: false })],
  ["projection of a column list", (db) => V(db, "id, name").order("id")],
  ["projection with extra spaces", (db) => V(db, "id,  capacity ,name").order("id")],
  ["single with exactly one row", (db) => V(db).eq("id", venueIds[0]).single()],
  ["single with no row", (db) => V(db).eq("capacity", 12345).single(), PGRST116],
  ["single with several rows", (db) => V(db).single(), PGRST116],
  ["maybeSingle with no row", (db) => V(db).eq("capacity", 12345).maybeSingle()],
  ["maybeSingle with one row", (db) => V(db).eq("id", venueIds[1]).maybeSingle()],
  ["maybeSingle with several rows", (db) => V(db).maybeSingle(), PGRST116],
  ["update returns the changed rows", (db) => db.from("venues").update({ setup_minutes: 99 }).in("id", venueIds.slice(0, 2)).select("id, setup_minutes").order("id")],
  ["update that matches nothing returns an empty list", (db) => db.from("venues").update({ setup_minutes: 1 }).eq("id", -1).select("id")],
  ["update without select returns no data", (db) => db.from("venues").update({ setup_minutes: 7 }).in("id", venueIds.slice(0, 1))],
  ["delete returns the removed rows", (db) => db.from("venue_unavailability").delete().eq("reason", "morning").in("venue_id", venueIds).select("id, reason")],
  ["delete that matches nothing returns an empty list", (db) => db.from("venue_unavailability").delete().eq("reason", "no such reason").in("venue_id", venueIds).select("id")],
];

describe("fakeDb answers like the real database", () => {
  it.each(scenarios)("%s", async (_title, build, expectedError) => {
    const { real, fake: mine } = await bothAnswer(build);
    expect(real.error, "the real database's own answer").toBe(expectedError ?? null);
    expect(mine.error).toBe(real.error);
    expect(mine.data).toEqual(real.data);
  });

  /** A single ZINT row each: constraint failures the unit suites rely on, which the fake does not model. */
  it.each([
    ["a missing NOT NULL value", { location: "x", capacity: 5 }],
    ["a CHECK violation (capacity must be positive)", { name: name("bad"), location: "x", capacity: 0 }],
  ])("the real database rejects %s", async (_title, row) => {
    const { error } = await supabaseAdmin.from("venues").insert(row as never);
    expect(error).toBeTruthy();
  });
});
