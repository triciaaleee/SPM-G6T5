/**
 * Cross-process serialisation for booking decisions (E4-11 AC5), on top of
 * the in-process queue in lib/venueLock.ts.
 *
 * That queue closes the race for one running instance, but two instances
 * each hold their own queue — a decision on instance A has no way to know
 * instance B is deciding the same venue at the same moment. This module
 * closes that gap with a real, cross-process mutex: a row in
 * venue_booking_locks. Its primary key on venue_id makes two concurrent
 * inserts for the same venue impossible to both succeed, so whichever
 * insert Postgres accepts is the only task that proceeds; the loser
 * retries briefly, then gives up rather than wait forever.
 *
 * A lock is reclaimed if its holder never released it (a crashed process)
 * once it is older than STALE_MS — self-healing without an explicit
 * recovery step.
 */
type Supabase = {
  from: (table: string) => any;
};

const STALE_MS = 30_000;
const RETRY_ATTEMPTS = 8;
const RETRY_DELAY_MS = 150;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAcquire(supabase: Supabase, venueId: number): Promise<boolean> {
  // Clear a lock left behind by a process that crashed mid-decision. Two
  // processes racing this step is harmless: a delete that finds nothing
  // is a no-op, and the insert below is what actually decides the winner.
  await supabase
    .from("venue_booking_locks")
    .delete()
    .eq("venue_id", venueId)
    .lt("locked_at", new Date(Date.now() - STALE_MS).toISOString());

  // Postgres rejects a second row with the same primary key; that failure
  // is "someone else holds this venue's lock", not a real error.
  const { error } = await supabase.from("venue_booking_locks").insert({ venue_id: venueId });
  return !error;
}

async function release(supabase: Supabase, venueId: number): Promise<void> {
  await supabase.from("venue_booking_locks").delete().eq("venue_id", venueId);
}

export interface LockBusy {
  busy: true;
}

/**
 * Runs `task` while holding the cross-process lock for `venueId`, retrying
 * briefly if another process holds it. Returns `{ busy: true }` rather than
 * waiting indefinitely if the lock is still held after every retry — a
 * live rival decision, not a crashed one, since a crashed holder's lock is
 * reclaimed well within that window.
 */
export async function withVenueBookingLock<T>(
  supabase: Supabase,
  venueId: number,
  task: () => Promise<T>,
): Promise<T | LockBusy> {
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    if (await tryAcquire(supabase, venueId)) {
      try {
        return await task();
      } finally {
        await release(supabase, venueId);
      }
    }
    if (attempt < RETRY_ATTEMPTS - 1) await delay(RETRY_DELAY_MS);
  }
  return { busy: true };
}

export function isLockBusy<T>(result: T | LockBusy): result is LockBusy {
  return typeof result === "object" && result !== null && (result as LockBusy).busy === true;
}
