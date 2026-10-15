-- E4-17: each venue booking of a (multi-venue) event carries what that
-- venue is for, so suitability is judged per booking — a breakout room
-- against its own session, not the whole event's attendance.
--
--   purpose          — fixed list (lib/bookingPlan.ts BOOKING_PURPOSES);
--                      'Other' needs purpose_detail.
--   headcount        — 1 .. the event's expected attendance (checked by
--                      venue-service, which reads the event through
--                      events-service; the attendance isn't in this table).
--   required_*       — the layouts/facilities/accessibility this booking
--                      needs, pre-filled from the event and editable.
--
-- All nullable: bookings made before E4-17 have none of them, and are read
-- as purpose 'Main programme', headcount = the event's expected attendance
-- and the event's own requirements — exactly what E4-7/E4-8 judged them
-- against. No backfill: the attendance lives in events-service's data.
--
-- Guarded so this is safe to re-run.

alter table venue_bookings add column if not exists purpose text;
alter table venue_bookings add column if not exists purpose_detail text;
alter table venue_bookings add column if not exists headcount integer;
alter table venue_bookings add column if not exists required_layouts text[];
alter table venue_bookings add column if not exists required_facilities text[];
alter table venue_bookings add column if not exists required_accessibility text[];

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'venue_bookings_purpose_check') then
    alter table venue_bookings add constraint venue_bookings_purpose_check
      check (purpose is null or purpose in ('Main programme', 'Breakout', 'Registration', 'Catering', 'Other'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'venue_bookings_purpose_detail_check') then
    alter table venue_bookings add constraint venue_bookings_purpose_detail_check
      check (purpose is distinct from 'Other' or length(btrim(coalesce(purpose_detail, ''))) > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'venue_bookings_headcount_check') then
    alter table venue_bookings add constraint venue_bookings_headcount_check
      check (headcount is null or headcount >= 1);
  end if;
end $$;
