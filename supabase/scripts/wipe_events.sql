-- Wipes events and everything that references it — dev/testing reset
-- only, does NOT touch users or venues. Run manually (e.g.
-- `supabase db execute -f supabase/scripts/wipe_events.sql`, or paste into
-- the SQL editor) — this does NOT run automatically like seed.sql.
--
-- All five tables are truncated in a single statement: event_clarifications,
-- event_history, venue_bookings and access_denials each have a FK on
-- events.id, so Postgres requires them to be truncated together with
-- events (or via CASCADE) rather than one at a time. RESTART IDENTITY
-- resets each table's own id sequence back to 1 instead of continuing from
-- wherever it left off.

truncate table
  event_clarifications,
  event_history,
  venue_bookings,
  access_denials,
  events
restart identity cascade;
