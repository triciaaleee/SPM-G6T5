-- E4-13: "Identify bookings invalidated by setup/turnaround rules".
--
-- AC1 (detection — findBufferOverlaps/findAllBufferOverlaps in
-- venue-service lib/venueChanges.ts) already identifies pairs of bookings
-- whose padded occupied windows now overlap. This table is what AC2/AC3
-- add: a durable, queryable review list so Venue Staff can revisit flagged
-- pairs later, that reconciles itself — a row exists if and only if the
-- pair currently overlaps under the venue's current setup/turnaround and
-- both bookings still block the venue. There is no "dismissed" state and no
-- dismiss action: reconciliation (lib/bufferOverlapReview.ts) is the only
-- thing that inserts or deletes rows here, run from every write path that
-- could change the overlap set (venue edits, withdrawals, booking
-- decisions, event cancellation, venue-unavailability flagging).
--
-- booking_id_a is always the lower of the pair's two booking ids —
-- enforced by the check constraint below and by normalizePair() in
-- lib/venueChanges.ts, which every write path uses before upserting, so the
-- same pair is never stored twice in swapped order.
--
-- window_a/window_b cache formatWindow()'s human-readable description of
-- each side's occupied window at detection time (e.g.
-- "2026-10-12 09:30–12:45"), so GET /venues/:venueId/buffer-overlaps can
-- render the review list without calling events-service on every read.
-- They are deliberately just the display string, not the raw timestamps:
-- nothing here recomputes or re-sorts by them, and the booking's event
-- dates/times (the source of truth) still live in events-service, never
-- in venue-service (AGENTS.md §3a).
--
-- on delete cascade on both FKs: a deleted venue or booking can never leave
-- a dangling flagged row. Neither venues nor venue_bookings rows appear to
-- be hard-deleted by any current code path (bookings move to a terminal
-- status like Withdrawn/Rejected instead), but cascade is the safer
-- default if that ever changes, and it costs nothing while it doesn't.
--
-- Guarded so this is safe to re-run (AGENTS.md: migrations may be edited in
-- place until the first production deploy).

create table if not exists venue_buffer_overlaps (
  id bigserial primary key,
  venue_id integer not null references venues (id) on delete cascade,
  booking_id_a bigint not null references venue_bookings (id) on delete cascade,
  booking_id_b bigint not null references venue_bookings (id) on delete cascade,
  -- Always insert with the lower booking id as booking_id_a (see
  -- normalizePair() in lib/venueChanges.ts) so one unordered pair can never
  -- be stored as two rows.
  constraint venue_buffer_overlaps_ordered check (booking_id_a < booking_id_b),
  -- formatWindow() output for each side at detection time, cached so the
  -- review list doesn't need an events-service round trip to render.
  window_a text not null,
  window_b text not null,
  detected_at timestamptz not null default now(),
  -- Lets reconciliation upsert idempotently: a pair already flagged is left
  -- untouched rather than deleted and re-inserted (AC3: a still-overlapping
  -- pair must not flicker out of the list and back in).
  constraint venue_buffer_overlaps_unique_pair unique (venue_id, booking_id_a, booking_id_b)
);

create index if not exists venue_buffer_overlaps_venue_idx on venue_buffer_overlaps (venue_id);
create index if not exists venue_buffer_overlaps_booking_a_idx on venue_buffer_overlaps (booking_id_a);
create index if not exists venue_buffer_overlaps_booking_b_idx on venue_buffer_overlaps (booking_id_b);

-- Same stance as venues/venue_bookings (0011) and venue_unavailability
-- (0016): RLS on with no policies, so only the backend's service-role key
-- can reach this table.
alter table venue_buffer_overlaps enable row level security;
