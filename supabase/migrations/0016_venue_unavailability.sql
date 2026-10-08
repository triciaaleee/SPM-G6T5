-- E4-3: venue staff block out periods when a venue can't be used, so
-- coordinators don't request slots that can't be honoured.
--
-- A period spans start_date..end_date (inclusive, local dates — the same
-- shape events store proposedDate in). It either blocks each of those days
-- entirely (all_day) or the same start_time..end_time window on each day
-- (e.g. 09:00–13:00 every morning of a maintenance week). The reason is
-- required: it's what staff and coordinators see on the calendar.
--
-- Owned by venue-service, alongside venues and venue_bookings.
--
-- 'Replacement Required' is added to venue_booking_status (0014): an Approved
-- booking that falls inside a new period is moved there, and its
-- coordinator is told an alternative venue is needed. The event itself is
-- left untouched — its status and details are preserved as they were.
--
-- Guarded so this is safe to re-run.

create table if not exists venue_unavailability (
  id bigserial primary key,
  venue_id integer not null references venues (id) on delete cascade,
  start_date date not null,
  end_date date not null,
  all_day boolean not null default true,
  start_time time,
  end_time time,
  reason text not null check (length(btrim(reason)) > 0),
  created_by text,
  created_at timestamptz not null default now(),
  constraint venue_unavailability_date_order check (end_date >= start_date),
  constraint venue_unavailability_time_window check (
    (all_day and start_time is null and end_time is null)
    or (not all_day and start_time is not null and end_time is not null and end_time > start_time)
  )
);

create index if not exists venue_unavailability_venue_dates_idx
  on venue_unavailability (venue_id, start_date, end_date);

-- Same stance as venues/venue_bookings (0011): RLS on with no policies, so
-- only the backend's service-role key can reach the table.
alter table venue_unavailability enable row level security;

alter type venue_booking_status add value if not exists 'Replacement Required';
