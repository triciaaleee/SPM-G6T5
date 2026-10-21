-- "Needs Review": the status a Confirmed event moves to when something it
-- relied on changes after safety approval — a venue booking becomes
-- Replacement Required, a reserved equipment unit becomes unusable, or the
-- Organiser raises a change request holding critical fields. Owned by
-- events-service. See AGENTS.md section 3.
--
-- Why a status and not Planning: Planning is where an event is built before
-- it has been safety-approved. A Confirmed event that loses its venue is
-- already approved, so the coordinator needs somewhere to re-arrange it
-- without the event reading as "back to the start" (and without the venue,
-- equipment and change-request routes being gated on Planning alone).
--
-- safety_approval_stale: true once anything the Safety Officer approved has
-- changed (an arrangement was lost, or a change request was approved). While
-- false, Needs Review is only waiting on a change-request decision, so a
-- rejected request can return the event straight to Confirmed. While true,
-- the event must pass Safety Review again. Cleared on every submission.
--
-- Guarded so this is safe to re-run. The new value is only referenced as a
-- string inside the function body, which Postgres does not resolve until it
-- runs, so this works in one script.

alter type event_status add value if not exists 'Needs Review' after 'Confirmed';

alter table events add column if not exists safety_approval_stale boolean not null default false;

-- Same as 0026, but a coordinator may also submit from Needs Review.
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
     set status = 'Safety Review',
         safety_approval_stale = false
   where id = p_event_id
     and status::text in ('Planning', 'Needs Review')
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
