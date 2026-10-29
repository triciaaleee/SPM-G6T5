/**
 * The cross-process booking lock against the REAL venue_booking_locks table.
 * The unit suites run lib/venueBookingLock.ts on an in-memory table; this file
 * is what shows that table behaves like Postgres: the primary key on venue_id
 * rejects a second lock (23505), and the age / owner filters on delete remove
 * exactly the rows the lock logic expects. Only throwaway ZINT venues are
 * used, and their lock rows are removed before the venues (venue_id is a
 * foreign key).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../../lib/env.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { isLockBusy, withVenueBookingLock } from "../../lib/venueBookingLock.js";
import { createFakeDb } from "../helpers/fakeDb.js";
import { RUN, STAFF_ID, seedUsers, teardown } from "./helpers.js";

const venueIds: number[] = [];
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const lockRow = async (venueId: number) =>
  (await supabaseAdmin.from("venue_booking_locks").select("venue_id, locked_at").eq("venue_id", venueId)).data ?? [];

/** A fresh venue per test, so one test's lock row can never leak into another. */
async function newVenue(suffix: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("venues")
    .insert({ name: `ZINT-LK ${RUN} ${suffix}`, location: "ZINT Test Campus", capacity: 10, staff_id: STAFF_ID })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  venueIds.push(data!.id);
  return data!.id;
}

beforeAll(seedUsers, 30_000);

afterAll(async () => {
  if (venueIds.length > 0) await supabaseAdmin.from("venue_booking_locks").delete().in("venue_id", venueIds);
  await teardown();
}, 30_000);

describe("venue_booking_locks (real table)", () => {
  it("a second lock row for the same venue is rejected with unique_violation 23505", async () => {
    const id = await newVenue("dup");
    const first = await supabaseAdmin.from("venue_booking_locks").insert({ venue_id: id, locked_at: iso(0) });
    const second = await supabaseAdmin.from("venue_booking_locks").insert({ venue_id: id, locked_at: iso(0) });

    expect(first.error).toBeNull();
    expect(second.error?.code).toBe("23505");

    // The in-memory table the unit suites use must answer the same way.
    const fake = createFakeDb({}, { unique: { venue_booking_locks: ["venue_id"] } });
    await fake.from("venue_booking_locks").insert({ venue_id: id, locked_at: iso(0) });
    const fakeSecond = await fake.from("venue_booking_locks").insert({ venue_id: id, locked_at: iso(0) });
    expect(fakeSecond.error?.code).toBe(second.error?.code);
  });

  it("deleting with locked_at < cutoff removes a stale row and keeps a fresh one", async () => {
    const stale = await newVenue("stale");
    const fresh = await newVenue("fresh");
    await supabaseAdmin.from("venue_booking_locks").insert([
      { venue_id: stale, locked_at: iso(31_000) },
      { venue_id: fresh, locked_at: iso(29_000) },
    ]);
    const cutoff = iso(30_000);

    await supabaseAdmin.from("venue_booking_locks").delete().eq("venue_id", stale).lt("locked_at", cutoff);
    await supabaseAdmin.from("venue_booking_locks").delete().eq("venue_id", fresh).lt("locked_at", cutoff);

    expect(await lockRow(stale)).toHaveLength(0);
    expect(await lockRow(fresh)).toHaveLength(1);
  });

  it("deleting with the owner's locked_at removes that row, and a different locked_at removes nothing", async () => {
    const id = await newVenue("owner");
    const stamp = "2026-03-04T05:06:07.089+00:00";
    await supabaseAdmin.from("venue_booking_locks").insert({ venue_id: id, locked_at: stamp });

    await supabaseAdmin.from("venue_booking_locks").delete().eq("venue_id", id).eq("locked_at", "2026-03-04T05:06:07.090Z");
    expect(await lockRow(id)).toHaveLength(1);

    await supabaseAdmin.from("venue_booking_locks").delete().eq("venue_id", id).eq("locked_at", "2026-03-04T05:06:07.089Z");
    expect(await lockRow(id)).toHaveLength(0);
  });
});

describe("withVenueBookingLock on the real table", () => {
  it("holds a lock row while the task runs and removes it afterwards", async () => {
    const id = await newVenue("run");

    const result = await withVenueBookingLock(supabaseAdmin as never, id, async () => (await lockRow(id)).length);

    expect(result).toBe(1);
    expect(await lockRow(id)).toHaveLength(0);
  });

  it("removes the lock row even when the task throws", async () => {
    const id = await newVenue("throw");

    await expect(
      withVenueBookingLock(supabaseAdmin as never, id, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await lockRow(id)).toHaveLength(0);
  });

  it("takes over a lock row 31s old (abandoned) and runs the task", async () => {
    const id = await newVenue("reclaim");
    await supabaseAdmin.from("venue_booking_locks").insert({ venue_id: id, locked_at: iso(31_000) });

    const result = await withVenueBookingLock(supabaseAdmin as never, id, async () => "ran");

    expect(result).toBe("ran");
    expect(await lockRow(id)).toHaveLength(0);
  });

  it("reports busy and leaves the row alone while a lock only 20s old is still held", async () => {
    const id = await newVenue("busy");
    // 20s, not 29s: the 8 tries take a few seconds on a real connection, and a lock that
    // turns 30s old mid-wait is correctly taken over. The exact 29s/31s edge is a unit test.
    const held = iso(20_000);
    await supabaseAdmin.from("venue_booking_locks").insert({ venue_id: id, locked_at: held });

    const result = await withVenueBookingLock(supabaseAdmin as never, id, async () => "never");

    expect(isLockBusy(result)).toBe(true);
    expect(await lockRow(id)).toHaveLength(1);
  }, 15_000);

  it("two simultaneous callers for one venue never run their tasks at the same time", async () => {
    const id = await newVenue("race");
    let running = 0;
    let overlapped = false;
    const task = async () => {
      running += 1;
      overlapped ||= running > 1;
      await new Promise((r) => setTimeout(r, 120));
      running -= 1;
      return "ok";
    };

    const [a, b] = await Promise.all([
      withVenueBookingLock(supabaseAdmin as never, id, task),
      withVenueBookingLock(supabaseAdmin as never, id, task),
    ]);

    expect(overlapped).toBe(false);
    expect([a, b].filter((r) => r === "ok").length).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
