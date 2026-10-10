import { describe, expect, it } from "vitest";
import { isLockBusy, withVenueBookingLock } from "../lib/venueBookingLock.js";

/**
 * A minimal fake of venue_booking_locks, independent of staffDecisions.ts's
 * copy, since this module is tested on its own merits: a row's existence is
 * the lock, a second insert for a held venue_id fails, and a stale row can
 * be reclaimed.
 */
function fakeLocksSupabase(initial: Map<number, string> = new Map()) {
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
            lt: (_column: string, value: string) => {
              before = value;
              return q;
            },
          };
          q.then = (resolve: (value: unknown) => unknown) => {
            const venueId = filters.venue_id as number | undefined;
            if (venueId !== undefined) {
              const lockedAt = locks.get(venueId);
              if (lockedAt !== undefined && (before === undefined || lockedAt < before)) locks.delete(venueId);
            }
            return resolve({ data: null, error: null });
          };
          return q;
        },
        insert: (row: { venue_id: number }) => {
          const q: any = {};
          q.then = (resolve: (value: unknown) => unknown) => {
            if (locks.has(row.venue_id)) {
              return resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
            }
            locks.set(row.venue_id, new Date().toISOString());
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
});
