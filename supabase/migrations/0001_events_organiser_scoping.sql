-- E1-3: Organiser data scoping
-- Minimal events schema plus RLS so organisers can only read their own events.
-- Columns beyond organiser_id/status/coordinator_id/review_outcome belong to
-- E1-2 (event creation) and should be extended there, not here.

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  organiser_id uuid not null references auth.users (id),
  status text not null default 'submitted',
  submitted_details jsonb not null default '{}'::jsonb,
  coordinator_id uuid references auth.users (id),
  review_outcome text,
  created_at timestamptz not null default now()
);

create table if not exists access_denials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  event_id uuid not null,
  reason text not null,
  attempted_at timestamptz not null default now()
);

alter table events enable row level security;
alter table access_denials enable row level security;

-- Organisers can only see events they created.
create policy "organisers_select_own_events"
  on events for select
  using (organiser_id = auth.uid());

-- Users can only read their own audit rows.
create policy "users_select_own_access_denials"
  on access_denials for select
  using (user_id = auth.uid());

-- Any authenticated user can insert a denial record about themselves
-- (the service inserts these on the user's behalf when access is denied).
create policy "users_insert_own_access_denials"
  on access_denials for insert
  with check (user_id = auth.uid());
