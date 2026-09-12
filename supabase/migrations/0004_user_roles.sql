-- Custom auth: public.users is now the sole source of truth for accounts
-- and credentials — Supabase Auth (auth.users/auth.identities) is no
-- longer used for login. The backend hashes passwords with bcrypt and
-- issues/verifies its own JWTs; RLS is not relied on for authorization
-- going forward (the backend uses the Supabase service-role key, which
-- bypasses RLS, and enforces ownership/role checks in application code
-- instead). Existing RLS policies from 0001/0002/0003 are dropped below
-- since they reference columns being repointed and can never match again
-- (auth.uid() only exists for Supabase Auth-issued JWTs).
--
-- Per requirements (epic E1, ConnectSphere PRD v1.0 section 2), there are
-- five roles and explicitly no admin role. New accounts default to
-- 'attendee' (E1-1).
--
-- Known limitation: a user's readable ID prefix reflects their role at
-- signup time. Since signup always defaults to 'attendee', a later
-- promotion to organiser/coordinator does not regenerate the ID.
-- Acceptable for now — there's no promotion flow defined yet.
--
-- Guards throughout make this migration safe to re-run after a partial
-- failure (e.g. a prior attempt that got interrupted mid-way).

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type app_role as enum (
      'attendee',
      'organiser',
      'coordinator',
      'venue_staff',
      'technical_support'
    );
  end if;
end
$$;

create sequence if not exists organiser_id_seq;
create sequence if not exists coordinator_id_seq;
create sequence if not exists attendee_id_seq;
create sequence if not exists venue_staff_id_seq;
create sequence if not exists technical_support_id_seq;

create or replace function generate_user_id(p_role app_role)
returns text
language plpgsql
as $$
begin
  return case p_role
    when 'organiser' then 'ORG-' || lpad(nextval('organiser_id_seq')::text, 4, '0')
    when 'coordinator' then 'COORD-' || lpad(nextval('coordinator_id_seq')::text, 4, '0')
    when 'attendee' then 'ATT-' || lpad(nextval('attendee_id_seq')::text, 4, '0')
    when 'venue_staff' then 'VEN-' || lpad(nextval('venue_staff_id_seq')::text, 4, '0')
    when 'technical_support' then 'TS-' || lpad(nextval('technical_support_id_seq')::text, 4, '0')
  end;
end;
$$;

create table if not exists users (
  id text primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  role app_role not null default 'attendee',
  created_at timestamptz not null default now()
);

-- Enabled with no policies: deny-all by default for the anon/authenticated
-- Supabase keys. The backend accesses this table exclusively via the
-- service-role key, which bypasses RLS entirely, so this is a safety net
-- against any other key ever touching it directly.
alter table users enable row level security;

-- These policies reference organiser_id/coordinator_id/user_id and would
-- block the type changes below. They're dead weight anyway once the
-- backend uses the service-role key (bypasses RLS).
drop policy if exists "organisers_select_own_events" on events;
drop policy if exists "organisers_insert_own_events" on events;
drop policy if exists "users_select_own_access_denials" on access_denials;
drop policy if exists "users_insert_own_access_denials" on access_denials;

-- Old rows still hold auth.users uuids in these columns, which can never
-- match public.users.id (text). This is dev/seed data — clear it here so
-- the new FK constraints below can be added; seed.sql repopulates it.
truncate table access_denials;
truncate table events;

-- events.organiser_id/coordinator_id and access_denials.user_id were uuid
-- FKs into auth.users. Now that public.users (text id, e.g. ORG-0001) is
-- the identity source of truth, repoint them there.
alter table events drop constraint if exists events_organiser_id_fkey;
alter table events drop constraint if exists events_coordinator_id_fkey;
alter table events alter column organiser_id type text using organiser_id::text;
alter table events alter column coordinator_id type text using coordinator_id::text;
alter table events add constraint events_organiser_id_fkey
  foreign key (organiser_id) references users (id);
alter table events add constraint events_coordinator_id_fkey
  foreign key (coordinator_id) references users (id);

alter table access_denials drop constraint if exists access_denials_user_id_fkey;
alter table access_denials alter column user_id type text using user_id::text;
alter table access_denials add constraint access_denials_user_id_fkey
  foreign key (user_id) references users (id);
