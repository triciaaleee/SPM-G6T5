/**
 * E4-13 AC2/AC3: the persisted, queryable review list of flagged
 * setup/turnaround overlap pairs (`venue_buffer_overlaps`, migration 0039).
 *
 * The overlap math itself lives in lib/venueChanges.ts
 * (`findAllBufferOverlaps`) — this file only reconciles that computed set
 * against what's stored: insert newly-overlapping pairs, delete stored rows
 * that no longer overlap, and leave unchanged ones alone so a still-valid
 * pair never flickers out of the list and back in (AC3).
 *
 * There is deliberately no "dismissed" flag: a row exists if and only if
 * `findAllBufferOverlaps` would currently report it. Nothing but
 * reconciliation ever inserts or deletes a row here.
 *
 * Called from every write path that can change the overlap set (a venue's
 * setup/turnaround changing, a booking being withdrawn/rejected/replaced or
 * newly Approved/On-Hold — see routes/staff.ts, lib/bookingWithdrawal.ts,
 * lib/bookingDecisions.ts, lib/eventCancellation.ts and
 * routes/unavailability.ts). Every caller treats this as best-effort and
 * non-blocking: a reconciliation failure is logged and swallowed, never
 * thrown in a way that could affect the caller's own primary write — the
 * same stance this codebase already takes with notification publishing
 * (e.g. bookingWithdrawal.ts's `withdrawalMessage`/publish call).
 */
import type { AuthedRequest } from "../middleware/auth.js";
import {
  bufferOverlapNotifications,
  findAllBufferOverlaps,
  loadLiveBookings,
  localDateKey,
  normalizePair,
  type BufferOverlap,
} from "./venueChanges.js";
import { getPublisher } from "./rabbitPublisher.js";

type Supabase = NonNullable<AuthedRequest["supabase"]>;

interface StoredOverlapRow {
  id: number;
  booking_id_a: number;
  booking_id_b: number;
}

/** A row as it's written to venue_buffer_overlaps. */
interface OverlapInsert {
  venue_id: number;
  booking_id_a: number;
  booking_id_b: number;
  window_a: string;
  window_b: string;
}

function pairKey(a: number, b: number): string {
  const [lo, hi] = normalizePair(a, b);
  return `${lo}:${hi}`;
}

/** The pair's two booking ids and cached window strings, in `(a, b)` order (lower id first). */
function toInsert(venueId: number, overlap: BufferOverlap): OverlapInsert {
  const [idA, idB] = normalizePair(overlap.first.bookingId, overlap.second.bookingId);
  const windowA = overlap.first.bookingId === idA ? overlap.first.window : overlap.second.window;
  const windowB = overlap.first.bookingId === idB ? overlap.first.window : overlap.second.window;
  return { venue_id: venueId, booking_id_a: idA, booking_id_b: idB, window_a: windowA, window_b: windowB };
}

export interface ReconcileResult {
  /** Pairs newly inserted this run — the only ones that should trigger a fresh notification. */
  inserted: BufferOverlap[];
}

/**
 * Recomputes the venue's current overlap set and reconciles it against
 * what's stored, returning only the pairs newly inserted (so a caller can
 * notify for genuinely new pairs without re-notifying for ones already
 * flagged — AC4).
 *
 * Resolves `null` when something failed (a DB error, or events-service
 * being unreachable) — callers must treat that as "couldn't reconcile this
 * time" and swallow it, not as a reason to fail their own request.
 */
export async function reconcileBufferOverlaps(
  supabase: Supabase,
  venueId: number,
  authorization: string | null,
  now: Date = new Date(),
): Promise<ReconcileResult | null> {
  const { data: venueRow, error: venueError } = await supabase
    .from("venues")
    .select("id, setup_minutes, turnaround_minutes")
    .eq("id", venueId)
    .maybeSingle();
  if (venueError || !venueRow) return null;
  const venue = venueRow as { id: number; setup_minutes: number | null; turnaround_minutes: number | null };

  const bookings = await loadLiveBookings(supabase, venueId, authorization, now);
  if (!bookings) return null;

  const today = localDateKey(now);
  const current = findAllBufferOverlaps(
    bookings,
    { setup_minutes: venue.setup_minutes, turnaround_minutes: venue.turnaround_minutes },
    today,
  );

  const { data: storedData, error: storedError } = await supabase
    .from("venue_buffer_overlaps")
    .select("id, booking_id_a, booking_id_b")
    .eq("venue_id", venueId);
  if (storedError) return null;
  const stored = (storedData ?? []) as StoredOverlapRow[];
  const storedByKey = new Map(stored.map((row) => [pairKey(row.booking_id_a, row.booking_id_b), row]));

  const currentByKey = new Map(current.map((overlap) => [pairKey(overlap.first.bookingId, overlap.second.bookingId), overlap]));

  const toInsertRows: OverlapInsert[] = [];
  const inserted: BufferOverlap[] = [];
  for (const [key, overlap] of currentByKey) {
    if (storedByKey.has(key)) continue; // Still overlapping and already flagged — left untouched (AC3).
    toInsertRows.push(toInsert(venueId, overlap));
    inserted.push(overlap);
  }

  const idsToDelete = stored
    .filter((row) => !currentByKey.has(pairKey(row.booking_id_a, row.booking_id_b)))
    .map((row) => row.id);

  if (toInsertRows.length > 0) {
    const { error } = await supabase.from("venue_buffer_overlaps").insert(toInsertRows);
    if (error) return null;
  }

  if (idsToDelete.length > 0) {
    const { error } = await supabase.from("venue_buffer_overlaps").delete().in("id", idsToDelete);
    if (error) return null;
  }

  return { inserted };
}

/**
 * Best-effort wrapper every write path calls: reconciliation, and the
 * notifications it triggers for genuinely new pairs (AC4), must never throw
 * into the caller's response path, and a failure here must never be
 * mistaken for a failure of the primary write that already committed —
 * which has, by the time this runs, already landed. Mirrors the stance
 * `withdrawBooking` already takes with its own best-effort publish.
 *
 * `venueName`/`venueStaffId` are optional: most call sites (bookingDecisions,
 * bookingWithdrawal, eventCancellation, unavailability) only have the
 * booking/venue id on hand and would need an extra lookup just to notify:
 * reconciliation itself (keeping the persisted list correct) is the part
 * AC2/AC3 require everywhere; the AC4 notification on top of it is a bonus
 * these call sites include when the venue's name/staff id is already loaded
 * for something else, and skip rather than pay for an extra round trip
 * otherwise. staff.ts's PATCH route already sends its own
 * `booking.setup_conflict` messages via `impactNotifications`, so it skips
 * this helper's notification and only reconciles.
 */
export async function reconcileBufferOverlapsSafely(
  supabase: Supabase,
  venueId: number,
  authorization: string | null,
  options: { now?: Date; venueName?: string; venueStaffId?: string | null } = {},
): Promise<void> {
  try {
    const result = await reconcileBufferOverlaps(supabase, venueId, authorization, options.now ?? new Date());
    if (!result || !options.venueName) return;
    const messages = bufferOverlapNotifications(options.venueName, result.inserted, options.venueStaffId ?? null);
    await Promise.all(messages.map((message) => getPublisher().publish(message)));
  } catch (err) {
    console.error(`[buffer-overlap-review] reconciliation failed for venue ${venueId}`, err);
  }
}
