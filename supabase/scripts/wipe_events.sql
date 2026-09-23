-- Wipes events, event_clarifications, and access_denials — dev/testing
-- reset only, does NOT touch users. Run manually (e.g.
-- `supabase db execute -f supabase/scripts/wipe_events.sql`, or paste into
-- the SQL editor) — this does NOT run automatically like seed.sql.
--
-- Order matters: event_clarifications has a FK on events.id, so it's
-- cleared first. RESTART IDENTITY resets events.id back to 1 instead of
-- continuing from wherever the auto-increment sequence left off.

truncate table event_clarifications restart identity;
truncate table access_denials restart identity;
truncate table events restart identity cascade;
