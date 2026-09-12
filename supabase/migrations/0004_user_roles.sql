-- E1-1 / E1-4: Application-level user roles.
--
-- auth.users has its own "role" column, but that's Supabase Auth's internal
-- Postgres role ('authenticated' vs 'anon') used to decide which RLS
-- policies even apply — it is unrelated to our app roles and must not be
-- reused or overwritten. App roles live in a separate `profiles` table,
-- one row per user, following the standard Supabase pattern.
--
-- Per requirements (epic E1, ConnectSphere PRD v1.0 section 2), there are
-- five roles and explicitly no admin role. New accounts default to
-- 'attendee' (E1-1); organiser/coordinator/venue_staff/technical_support
-- are assigned by seeding, not self-service.

create type app_role as enum (
  'attendee',
  'organiser',
  'coordinator',
  'venue_staff',
  'technical_support'
);

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role app_role not null default 'attendee',
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Users can see their own role; role assignment is not self-service, so
-- there is no insert/update policy for regular users.
create policy "users_select_own_profile"
  on profiles for select
  using (id = auth.uid());

-- Auto-create a profile (defaulting to 'attendee') whenever a new
-- auth.users row is created, satisfying E1-1's "defaults to Attendee" AC
-- without relying on application code to remember to do it.
create function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role) values (new.id, 'attendee');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Backfill profiles for any users that already existed before this
-- migration (the trigger above only fires for future signups).
insert into profiles (id, role)
select id, 'attendee' from auth.users
on conflict (id) do nothing;

-- If you're using the seed.sql test users, assign their real roles here,
-- e.g.:
--   update profiles set role = 'organiser'
--     where id in ('11111111-1111-1111-1111-111111111111',
--                  '22222222-2222-2222-2222-222222222222');
--   update profiles set role = 'coordinator'
--     where id = '33333333-3333-3333-3333-333333333333';

-- Coordinators get full pipeline visibility (see all events), but can only
-- update events assigned to them. This is additive to 0001/0002's existing
-- organiser-scoped policies and closes the ARD's "no UPDATE policy on
-- events" gap for the coordinator case.
create policy "coordinators_select_all_events"
  on events for select
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.role = 'coordinator'
    )
  );

create policy "coordinators_update_assigned_events"
  on events for update
  using (coordinator_id = auth.uid())
  with check (coordinator_id = auth.uid());
