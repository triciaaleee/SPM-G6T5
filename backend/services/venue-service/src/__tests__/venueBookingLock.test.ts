import { describe, expect, it, vi } from "vitest";
import { isLockBusy, withVenueBookingLock } from "../lib/venueBookingLock.js";

/**
 * A minimal fake of venue_booking_locks, independent of staffDecisions.ts's
 * copy, since this module is tested on its own merits: a row's existence is
 * the lock, a second insert for a held venue_id fails, and a stale row can
 * be reclaimed.
 */
function fakeLocksSupabase(initial: Map<number, string> = new Map(), insertError?: { code: string; message: string }) {
  const locks = initial;
  return {
    locks,
    from: (table: string) => {
      if (table !== "venue_booking_locks") throw new Error(`unexpected table ${table}`);
      return {
        delete: () => {
          const filters: Record<string, unknown> = {};
          let before: string | undefined;
          const q: any = {
            eq: (column: string, value: unknown) => {
              filters[column] = value;
              return q;
            },
            lt: (column: string, value: string) => {
              // Only a filter on the lock's age may reclaim it.
              if (column === "locked_at") before = value;
              return q;
            },
          };
          q.then = (resolve: (value: unknown) => unknown) => {
            const venueId = filters.venue_id as number | undefined;
            if (venueId !== undefined) {
              const lockedAt = locks.get(venueId);
              const ownerMatches = filters.locked_at === undefined || filters.locked_at === lockedAt;
              if (lockedAt !== undefined && ownerMatches && (before === undefined || lockedAt < before)) {
                locks.delete(venueId);
              }
            }
            return resolve({ data: null, error: null });
          };
          return q;
        },
        insert: (row: { venue_id: number; locked_at?: string }) => {
          const q: any = {};
          q.then = (resolve: (value: unknown) => unknown) => {
            if (insertError) return resolve({ data: null, error: insertError });
            if (locks.has(row.venue_id)) {
              return resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
            }
            locks.set(row.venue_id, row.locked_at ?? new Date().toISOString());
            return resolve({ data: { venue_id: row.venue_id }, error: null });
          };
          return q;
        },
      };
    },
  };
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
    const supabase = fakeLocksSupabase();
    supabase.locks.set(1, new Date().toISOString());

    const result = await withVenueBookingLock(supabase, 1, async () => "should not run");

    expect(isLockBusy(result)).toBe(true);
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
      vi.useRealTimers();
      vi.restoreAllMocks();
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
