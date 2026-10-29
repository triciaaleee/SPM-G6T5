import { describe, expect, it, vi } from "vitest";
import { isLockBusy, withVenueBookingLock } from "../lib/venueBookingLock.js";
import { createFakeDb } from "./helpers/fakeDb.js";

const LOCKS = "venue_booking_locks";

/**
 * venue_booking_locks on the shared in-memory database, with the table's primary key on
 * venue_id (a second lock for a held venue fails with 23505). integration/venueBookingLock
 * runs the same operations on the real table. `locks` is a view of the stored rows for
 * seeding and inspecting a venue's lock; `insertError` makes every insert fail with it.
 */
function fakeLocksSupabase(initial: Map<number, string> = new Map(), insertError?: { code: string; message: string }) {
  const db = createFakeDb(
    { [LOCKS]: [...initial].map(([venue_id, locked_at]) => ({ venue_id, locked_at })) },
    { unique: { [LOCKS]: ["venue_id"] } },
  );
  if (insertError) db.mapOn(LOCKS, "insert", () => ({ data: null, error: insertError }));
  const rows = () => db.rows(LOCKS);
  const locks = {
    has: (id: number) => rows().some((r) => r.venue_id === id),
    get: (id: number) => rows().find((r) => r.venue_id === id)?.locked_at as string | undefined,
    set: (id: number, at: string) => {
      locks.delete(id);
      rows().push({ venue_id: id, locked_at: at });
    },
    delete: (id: number) => {
      db.tables[LOCKS] = rows().filter((r) => r.venue_id !== id);
    },
  };
  return { locks, from: db.from };
}

describe("withVenueBookingLock (E4-11 AC5)", () => {
  it("runs the task while holding the lock, then releases it", async () => {
    const supabase = fakeLocksSupabase();

    const result = await withVenueBookingLock(supabase, 1, async () => {
      // The lock row exists while the task runs.
      expect(supabase.locks.has(1)).toBe(true);
      return "done";
    });

    expect(result).toBe("done");
    // Released once the task settles.
    expect(supabase.locks.has(1)).toBe(false);
  });

  it("releases the lock even if the task throws", async () => {
    const supabase = fakeLocksSupabase();

    await expect(
      withVenueBookingLock(supabase, 1, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(supabase.locks.has(1)).toBe(false);
  });

  it("a held lock blocks a second acquire for the same venue until it is released", async () => {
    const supabase = fakeLocksSupabase();
    supabase.locks.set(1, new Date().toISOString());

    const attempt = withVenueBookingLock(supabase, 1, async () => "should not run");

    // The venue's lock row is released mid-flight, simulating the first
    // holder (another process) finishing before this task gives up.
    setTimeout(() => supabase.locks.delete(1), 10);

    const result = await attempt;
    expect(result).toBe("should not run");
  });

  it("gives up and reports busy if the lock is never released", async () => {
    vi.useFakeTimers();
    try {
      const supabase = fakeLocksSupabase();
      supabase.locks.set(1, new Date().toISOString());

      const pending = withVenueBookingLock(supabase, 1, async () => "should not run");
      await vi.runAllTimersAsync();

      expect(isLockBusy(await pending)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reclaims a lock abandoned by a crashed process once it is stale", async () => {
    const supabase = fakeLocksSupabase();
    // Locked long enough ago to count as abandoned.
    supabase.locks.set(1, new Date(Date.now() - 60_000).toISOString());

    const result = await withVenueBookingLock(supabase, 1, async () => "reclaimed");

    expect(result).toBe("reclaimed");
  });

  it("different venues never contend for the same lock", async () => {
    const supabase = fakeLocksSupabase();
    supabase.locks.set(2, new Date().toISOString());

    const result = await withVenueBookingLock(supabase, 1, async () => "ran");

    expect(result).toBe("ran");
  });

  it("release only removes the lock this call took, never one a later process reclaimed", async () => {
    const supabase = fakeLocksSupabase();

    await withVenueBookingLock(supabase, 1, async () => {
      // Our lock went stale (a slow decision); another process reclaimed it.
      supabase.locks.set(1, "2999-01-01T00:00:00.000Z");
      return "slow";
    });

    expect(supabase.locks.get(1)).toBe("2999-01-01T00:00:00.000Z");
  });

  it("stamps the lock with the time it was taken", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T05:06:07.089Z"));
    const supabase = fakeLocksSupabase();
    try {
      await withVenueBookingLock(supabase, 1, async () => {
        expect(supabase.locks.get(1)).toBe("2026-03-04T05:06:07.089Z");
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a duplicate-key failure means held (busy); any other database error is raised, not reported as busy", async () => {
    vi.useFakeTimers();
    try {
      const held = withVenueBookingLock(fakeLocksSupabase(new Map(), { code: "23505", message: "duplicate key" }), 1, async () => "x");
      await vi.runAllTimersAsync();
      expect(isLockBusy(await held)).toBe(true);

      const down = withVenueBookingLock(fakeLocksSupabase(new Map(), { code: "08006", message: "connection failure" }), 1, async () => "x");
      const settled = expect(down).rejects.toThrow("Could not take the lock for venue 1: connection failure");
      await vi.runAllTimersAsync();
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries exactly 8 times, waiting 150ms between tries and not after the last, then reports busy", async () => {
    vi.useFakeTimers();
    try {
      const supabase = fakeLocksSupabase(new Map([[1, new Date().toISOString()]]));
      const insert = vi.fn(supabase.from("venue_booking_locks").insert);
      const from = supabase.from;
      supabase.from = (table: string) => ({ ...from(table), insert });
      const sleeps = vi.spyOn(globalThis, "setTimeout");

      const pending = withVenueBookingLock(supabase, 1, async () => "never");
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(isLockBusy(result)).toBe(true);
      expect(insert).toHaveBeenCalledTimes(8);
      expect(sleeps.mock.calls.map((call) => call[1])).toEqual(Array(7).fill(150));
    } finally {
      // Remove the spy first: it wraps the fake setTimeout, so restoring it after useRealTimers()
      // would put the fake back and leave every later real-timer test waiting forever.
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("does not reclaim a lock that is fresh: 29s old stays held, 31s old is taken over", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T05:06:40.000Z"));
    try {
      const fresh = fakeLocksSupabase(new Map([[1, "2026-03-04T05:06:11.000Z"]]));
      const waiting = withVenueBookingLock(fresh, 1, async () => "ran");
      await vi.advanceTimersByTimeAsync(0);
      expect(fresh.locks.get(1)).toBe("2026-03-04T05:06:11.000Z");
      await vi.runAllTimersAsync();
      await waiting;

      const stale = fakeLocksSupabase(new Map([[1, "2026-03-04T05:06:09.000Z"]]));
      expect(await withVenueBookingLock(stale, 1, async () => "ran")).toBe("ran");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isLockBusy", () => {
  it.each([
    [{ busy: true }, true],
    [{ busy: false }, false],
    [{ busy: "true" }, false],
    [{ busy: 1 }, false],
    [{}, false],
    [[], false],
    [null, false],
    [undefined, false],
    ["busy", false],
    [1, false],
    [true, false],
    [{ value: 1, busy: true }, true],
  ])("%j -> %s", (value, expected) => {
    expect(isLockBusy(value as never)).toBe(expected);
  });
});
