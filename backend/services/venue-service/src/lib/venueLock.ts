/**
 * Per-venue serialisation for booking decisions (E4-11 AC5: "when Venue
 * Staff approve or hold both, then only the first succeeds").
 *
 * A decision reads what currently blocks the venue and then writes a status
 * based on that read. Two staff acting on two *different* overlapping
 * bookings at the same instant would each read a free venue and each write
 * a blocking status — the compare-and-swap on the update only protects a
 * single booking row, not the venue. Running the read and the write inside
 * a lock keyed on the venue makes those decisions take turns, so the second
 * one sees the first one's booking and is refused.
 *
 * The key is the venue, never a global lock: bookings at different venues
 * are independent (AC7) and must stay fully parallel.
 *
 * Scope: one service process. This closes the race for the project's
 * single-process deployment; across several venue-service instances the
 * post-write re-check in lib/bookingDecisions.ts is what catches a lost
 * race and rolls the losing decision back. See AGENTS.md §3a.
 */

/** The tail of each venue's queue — the promise a new task waits behind. */
const chains = new Map<number, Promise<unknown>>();

/**
 * Runs `task` once every decision already queued for `venueId` has
 * settled. The caller sees `task`'s own result or rejection; a task that
 * throws does not stop the ones behind it.
 */
export function withVenueLock<T>(venueId: number, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(venueId) ?? Promise.resolve();

  // `previous` is always a link that cannot reject (see below), so the
  // task runs whether or not the one before it failed.
  const result = previous.then(task);
  // The link swallows failures so one rejected task cannot poison the
  // queue; the caller still gets the real rejection, from `result`.
  const link = result.then(
    () => undefined,
    () => undefined,
  );

  chains.set(venueId, link);
  void link.then(() => {
    // Only the last task in the queue clears it, so the map does not grow
    // one entry per venue forever.
    if (chains.get(venueId) === link) chains.delete(venueId);
  });

  return result;
}

/** Test seam: how many venues currently have a queue. */
export function pendingVenueLocks(): number {
  return chains.size;
}
