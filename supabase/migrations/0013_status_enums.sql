-- Converts events.status and venue_bookings' booking-approval status from
-- free text to Postgres enums. This captures in version control a change
-- that was made live in Supabase Studio — per AGENTS.md's migration rule
-- ("schema changes go in a new migration"), so a fresh environment ends
-- up with the same schema the dev project already has.
--
-- event_status: all 8 status strings the app actually writes (see
-- AGENTS.md §3), including "Unassigned" — written by E2-6 AC4 when a
-- request is submitted and no coordinator exists yet to auto-assign.
--
-- venue_status: new, backs a booking-approval workflow (a booking request
-- for a venue gets approved/rejected — not the venue itself). The column
-- was created live as venue_bookings."Status" (capitalized); this
-- migration renames it to the lowercase `status` every other column in
-- the schema uses. Application code doesn't read/write this column yet —
-- see AGENTS.md for the follow-up this unblocks.
--
-- Guarded so this is safe to re-run.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'event_status') then
    create type event_status as enum (
      'Draft',
      'Requested',
      'Unassigned',
      'Clarification Requested',
      'Planning',
      'Rejected',
      'Confirmed',
      'Completed'
    );
  else
    -- The enum already exists live (created via Supabase Studio) without
    -- Unassigned — add it if it's missing, since ADD VALUE can't run
    -- inside the same transaction/block as the CREATE TYPE above.
    if not exists (
      select 1 from pg_enum
      where enumtypid = 'event_status'::regtype and enumlabel = 'Unassigned'
    ) then
      alter type event_status add value 'Unassigned';
    end if;
  end if;
end
$$;

alter table events alter column status drop default;
alter table events alter column status type event_status using status::text::event_status;
alter table events alter column status set default 'Requested'::event_status;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'venue_status') then
    create type venue_status as enum ('Requested', 'Approved', 'Rejected');
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'venue_bookings' and column_name = 'Status'
  ) then
    alter table venue_bookings rename column "Status" to status;
  elsif not exists (
    select 1 from information_schema.columns
    where table_name = 'venue_bookings' and column_name = 'status'
  ) then
    alter table venue_bookings add column status venue_status not null default 'Requested';
  end if;
end
$$;

alter table venue_bookings alter column status set default 'Requested'::venue_status;

do $$
begin
  if not exists (select 1 from venue_bookings where status is null) then
    alter table venue_bookings alter column status set not null;
  end if;
end
$$;
