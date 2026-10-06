-- E1-1 (issue #8): self-signup can now create organisers as well as
-- attendees, so generate_user_id() (migration 0004) draws from
-- organiser_id_seq at signup time.
--
-- seed.sql inserts accounts with hand-picked IDs (ORG-0001, COORD-0001,
-- ...) without touching the sequences, so on a seeded database the first
-- organiser to sign up would be handed ORG-0001 and collide with the
-- seed row. Attendee signups never hit this only because no attendees
-- are seeded.
--
-- sync_user_id_sequences() moves each role's sequence past the highest
-- ID already in use for that prefix. It only ever moves a sequence
-- forward, so it's safe to call at any time — seed.sql calls it after
-- inserting its accounts, and it's run once below to repair databases
-- that were seeded before this migration existed.
--
-- Guarded so this is safe to re-run.

create or replace function sync_user_id_sequences()
returns void
language plpgsql
as $$
declare
  r record;
  max_used bigint;
  current_value bigint;
  called boolean;
begin
  for r in
    select * from (values
      ('ORG-', 'organiser_id_seq'),
      ('COORD-', 'coordinator_id_seq'),
      ('ATT-', 'attendee_id_seq'),
      ('VEN-', 'venue_staff_id_seq'),
      ('TS-', 'technical_support_id_seq'),
      ('LEAD-', 'coordinator_lead_id_seq'),
      ('SAF-', 'safety_officer_id_seq')
    ) as t(prefix, seq)
  loop
    select max(substring(id from length(r.prefix) + 1)::bigint)
      into max_used
      from users
      where id like r.prefix || '%'
        and substring(id from length(r.prefix) + 1) ~ '^[0-9]+$';

    continue when max_used is null;

    execute format('select last_value, is_called from %I', r.seq)
      into current_value, called;

    -- A never-used sequence reports last_value = start (1) with
    -- is_called = false, meaning nothing has been handed out yet.
    if not called then
      current_value := current_value - 1;
    end if;

    if max_used > current_value then
      perform setval(r.seq::regclass, max_used, true);
    end if;
  end loop;
end;
$$;

select sync_user_id_sequences();
