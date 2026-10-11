-- E3-4: the assigned coordinator submits an event for the Safety Officer's
-- Operational Safety Check (Week 7 change 6). Owned by events-service.
--
-- One row per submission, so a resubmission after the Safety Officer
-- rejects or requests changes gets fresh notes and the earlier decision
-- doesn't carry over (E3-12 AC4). The four notes are the ones E3-4 AC5
-- lists; each is required, so "blocked if empty" holds per field. Where
-- there are no restrictions, the coordinator writes "None known".
--
-- E1-10 shows the latest submission; E3-12/13/14 link their decision in
-- event_safety_reviews to the submission it answers via submission_id.
--
-- Guarded so this is safe to re-run.

create table if not exists event_safety_submissions (
  id bigserial primary key,
  event_id integer not null references events (id),
  submitted_by text not null references users (id),
  equipment_placement text not null check (length(trim(equipment_placement)) > 0),
  crowd_movement      text not null check (length(trim(crowd_movement)) > 0),
  emergency_access    text not null check (length(trim(emergency_access)) > 0),
  venue_restrictions  text not null check (length(trim(venue_restrictions)) > 0),
  submitted_at timestamptz not null default now()
);

create index if not exists event_safety_submissions_event_id_idx on event_safety_submissions (event_id);

alter table event_safety_submissions enable row level security;

alter table event_safety_reviews
  add column if not exists submission_id bigint references event_safety_submissions (id);

-- The status change and the notes land together or not at all. The update
-- only matches while the event is still in Planning and still assigned to
-- the submitter, so a concurrent submission, cancellation or reassignment
-- between events-service's checks and this call makes it return null
-- instead of moving the event. Returns the new submission's id.
create or replace function submit_event_for_safety_review(
  p_event_id integer,
  p_submitted_by text,
  p_equipment_placement text,
  p_crowd_movement text,
  p_emergency_access text,
  p_venue_restrictions text
) returns bigint
language plpgsql
as $$
declare
  v_submission_id bigint;
begin
  update events
     set status = 'Safety Review'
   where id = p_event_id
     and status = 'Planning'
     and coordinator_id = p_submitted_by;
  if not found then
    return null;
  end if;

  insert into event_safety_submissions (
    event_id, submitted_by, equipment_placement, crowd_movement, emergency_access, venue_restrictions
  ) values (
    p_event_id, p_submitted_by, p_equipment_placement, p_crowd_movement, p_emergency_access, p_venue_restrictions
  )
  returning id into v_submission_id;

  return v_submission_id;
end;
$$;
