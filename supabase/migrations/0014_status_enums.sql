-- Converts events.status and venue_bookings' booking-approval status from
-- free text to Postgres enums. This captures in version control a change
-- that was made live in Supabase Studio — per AGENTS.md's migration rule
-- ("schema changes go in a new migration"), so a fresh environment ends
-- up with the same schema the dev project already has.
--
-- event_status: every status in AGENTS.md §3, including "Unassigned"
-- (the Event Coordinator Lead's unassigned queue) and "Safety Review"
-- (awaiting the Safety Officer's Operational Safety Check, Week 7 change 6).
--
-- venue_status: new, backs a booking-approval workflow (a booking request
-- for a venue gets approved/rejected — not the venue itself). The column
-- was created live as venue_bookings."Status" (capitalized); this
-- migration renames it to the lowercase `status` every other column in
-- the schema uses. Statuses and their meaning: AGENTS.md §3a (Week 7
-- changes 2 and 4 add "Expired" and "Replacement Required"). A "Requested"
-- booking is a tentative hold and carries hold_expires_at, added below.
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
      'Safety Review',
      'Rejected',
      'Confirmed',
      'Completed'
    );
  end if;
end
$$;

alter table events alter column status drop default;
alter table events alter column status type event_status using status::text::event_status;
alter table events alter column status set default 'Requested'::event_status;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'venue_status') then
    create type venue_status as enum (
      'Requested',
      'Approved',
      'Rejected',
      'Expired',
      'Replacement Required'
    );
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

-- Tentative-hold expiry (Week 7 change 4): a 'Requested' booking blocks its
-- venue only until this moment. Null once the booking is Approved.
alter table venue_bookings add column if not exists hold_expires_at timestamptz;
