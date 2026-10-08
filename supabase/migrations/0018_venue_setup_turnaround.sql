-- Captures venues.setup_minutes / venues.turnaround_minutes, already added
-- live in Supabase Studio but never written down as a migration (see
-- AGENTS.md's migration rule).
--
-- A booking occupies its venue from event start − setup to event end +
-- turnaround: a 10:00–12:00 event with 30 min setup and 45 min turnaround
-- ties the venue up 09:30–12:45. E4-3 block-outs are checked against that
-- occupied window, both when flagging affected bookings and when excluding
-- blocked venues from search.
--
-- Guarded so this is safe to re-run (and a no-op where the columns exist).

alter table venues add column if not exists setup_minutes integer not null default 0;
alter table venues add column if not exists turnaround_minutes integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'venues_setup_minutes_check') then
    alter table venues add constraint venues_setup_minutes_check check (setup_minutes >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'venues_turnaround_minutes_check') then
    alter table venues add constraint venues_turnaround_minutes_check check (turnaround_minutes >= 0);
  end if;
end $$;
