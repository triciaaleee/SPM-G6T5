-- Registration period (coordinator sets when registration opens, and can step
-- in manually). Only intent is stored; whether registration is open right now
-- is worked out on every read (events-service lib/registrationPeriod.ts), so
-- opening, closing 5 days before the event, and reopening after a withdrawal
-- need no scheduled job.
--
--   registration_open_date  the day registration opens (Singapore local date).
--                           There is no closing date: by default it closes
--                           5 days before the event starts, or when the event
--                           is full. It always stops when the event starts.
--   registration_override   the coordinator's manual say. NONE follows the
--                           dates; FORCE_OPEN opens it now (even inside the
--                           5-day window); FORCE_CLOSED closes it. Neither
--                           beats the stop at the event start.
alter table public.events
  add column if not exists registration_open_date date,
  add column if not exists registration_override text not null default 'NONE';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'events_registration_override_check'
  ) then
    alter table public.events
      add constraint events_registration_override_check
      check (registration_override in ('NONE', 'FORCE_OPEN', 'FORCE_CLOSED'));
  end if;
end $$;
