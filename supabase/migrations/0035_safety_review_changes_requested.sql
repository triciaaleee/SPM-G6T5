-- E3-14: the Safety Officer requests specific changes to an event's safety
-- arrangements, short of rejecting it (Safety Review -> Planning). Owned by
-- events-service.
--
-- The decision itself is an event_safety_reviews row with outcome
-- 'Changes Requested' (migration 0012 already allows it). What must change
-- is written per flagged arrangement (event_safety_review_flags.note), plus
-- an optional general note for anything that isn't about one arrangement
-- (event_safety_reviews.general_note, added below). The review's reason —
-- required by that table's check constraint — holds them combined
-- ("Label: note; …"), so decision history and notifications read as before.
--
-- A flag points at an arrangement owned by another service (AGENTS.md §1):
-- a venue booking (venue-service's venue_bookings) or an equipment request
-- item (equipment-service's equipment_request_items). So there is no
-- foreign key — only the id, a label for display, and a snapshot of how the
-- arrangement looked when it was flagged. events-service reads the
-- arrangement's current state from its owning service and, when it no
-- longer matches the snapshot, records cleared_at (AC3: "each flag clears
-- when that arrangement is changed"). Once cleared, a flag stays cleared.
--
-- Guarded so this is safe to re-run.

create table if not exists event_safety_review_flags (
  id bigserial primary key,
  review_id bigint not null references event_safety_reviews (id) on delete cascade,
  event_id integer not null references events (id) on delete cascade,
  arrangement_type text not null check (arrangement_type in ('venue_booking', 'equipment_item')),
  arrangement_id bigint not null,
  label text not null,
  -- What must change about this arrangement (required, AC1/AC2).
  note text not null check (length(btrim(note)) > 0),
  snapshot jsonb not null,
  cleared_at timestamptz,
  created_at timestamptz not null default now(),
  unique (review_id, arrangement_type, arrangement_id)
);

-- For a database that ran this file before per-arrangement notes were
-- added: create table above skipped the existing table, so add the note
-- here. Any flag recorded without one is given a placeholder so the
-- not-null and non-empty rules below can hold.
alter table event_safety_review_flags add column if not exists note text;
update event_safety_review_flags set note = 'No note recorded' where note is null or btrim(note) = '';
alter table event_safety_review_flags alter column note set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'event_safety_review_flags_note_check') then
    alter table event_safety_review_flags add constraint event_safety_review_flags_note_check
      check (length(btrim(note)) > 0);
  end if;
end $$;

create index if not exists event_safety_review_flags_event_idx on event_safety_review_flags (event_id);

-- Same stance as the other events-service tables: RLS on, no policies, so
-- only the backend's service-role key reaches it.
alter table event_safety_review_flags enable row level security;

-- Anything the Safety Officer wants changed that isn't about one
-- arrangement. Optional; null for every other outcome.
alter table event_safety_reviews add column if not exists general_note text;

-- Same shape as reject_event_safety_review (migration 0029): the status
-- change, the decision and its flags land together or not at all, and the
-- update only matches while the event is still in Safety Review, so a
-- concurrent decision, re-review or cancellation makes it return null
-- instead of moving the event. Venue bookings and equipment reservations
-- are left as they are, for the coordinator to rework. p_flags is a JSON
-- array of {type, id, label, note, snapshot}; events-service has already
-- checked each one belongs to the event, that there is at least one and
-- that each has a note (AC2). p_reason is the notes combined.
-- Returns the new review's id.
--
-- The earlier version of this function had no p_general_note. A new
-- parameter list makes a second function rather than replacing it, so the
-- old one is dropped first.
drop function if exists request_event_safety_changes(integer, text, text, jsonb);

create or replace function request_event_safety_changes(
  p_event_id integer,
  p_officer_id text,
  p_reason text,
  p_general_note text,
  p_flags jsonb
) returns bigint
language plpgsql
as $$
declare
  v_submission_id bigint;
  v_review_id bigint;
begin
  update events
     set status = 'Planning'
   where id = p_event_id
     and status = 'Safety Review';
  if not found then
    return null;
  end if;

  select id into v_submission_id
    from event_safety_submissions
   where event_id = p_event_id
   order by submitted_at desc
   limit 1;

  insert into event_safety_reviews (event_id, officer_id, outcome, reason, general_note, submission_id)
  values (p_event_id, p_officer_id, 'Changes Requested', p_reason, p_general_note, v_submission_id)
  returning id into v_review_id;

  insert into event_safety_review_flags (review_id, event_id, arrangement_type, arrangement_id, label, note, snapshot)
  select v_review_id,
         p_event_id,
         flag ->> 'type',
         (flag ->> 'id')::bigint,
         flag ->> 'label',
         flag ->> 'note',
         coalesce(flag -> 'snapshot', '{}'::jsonb)
    from jsonb_array_elements(p_flags) as flag;

  return v_review_id;
end;
$$;
