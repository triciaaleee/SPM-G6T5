-- E4 venue availability calendar: each venue's daily operating hours.
--
-- A coordinator's calendar shows time outside opening_time..closing_time
-- as unavailable, and only offers free slots inside it. The same hours
-- apply every day; per-weekday hours can be split out later if a venue
-- needs them. closing_time may be '24:00' for a venue open until midnight
-- (Postgres `time` accepts 24:00:00).
--
-- Defaults to 08:00–22:00 so existing venues get sensible hours without a
-- backfill; Venue Staff can change them per venue.
--
-- Owned by venue-service, alongside venues (0011).
--
-- Guarded so this is safe to re-run.

alter table venues add column if not exists opening_time time not null default '08:00';
alter table venues add column if not exists closing_time time not null default '22:00';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'venues_operating_hours_check') then
    alter table venues add constraint venues_operating_hours_check check (closing_time > opening_time);
  end if;
end $$;
