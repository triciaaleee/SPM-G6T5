-- E4-11 AC5: a real, cross-process mutex for one venue's hold/approve
-- decisions. lib/venueLock.ts only serialises decisions within a single
-- service instance (an in-memory queue); this table is the guard that
-- holds across several instances, closing the gap the project previously
-- covered only with a post-write re-check and rollback.
--
-- A row's existence *is* the lock: the primary key on venue_id means two
-- concurrent inserts for the same venue cannot both succeed — Postgres
-- itself picks the winner. locked_at lets a lock abandoned by a crashed
-- process be reclaimed instead of stuck forever. See
-- lib/venueBookingLock.ts for the acquire/release logic.

create table if not exists venue_booking_locks (
  venue_id integer primary key references venues (id),
  locked_at timestamptz not null default now()
);
