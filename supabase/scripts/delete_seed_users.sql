-- Removes the 3 seed test users from supabase/seed.sql, plus any rows that
-- reference them, since events.organiser_id/coordinator_id and
-- access_denials.user_id are FKs into auth.users with no ON DELETE CASCADE.
-- Run manually (e.g. `supabase db execute -f supabase/scripts/delete_seed_users.sql`,
-- or paste into the SQL editor) — this does NOT run automatically like seed.sql.

delete from access_denials
where user_id in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333'
);

delete from events
where organiser_id in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333'
)
or coordinator_id in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333'
);

delete from auth.users
where id in (
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333'
);
