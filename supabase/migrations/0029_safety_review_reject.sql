-- E3-13: the Safety Officer rejects an event's Operational Safety Check
-- (Safety Review -> Planning). Owned by events-service.
--
-- Guarded so this is safe to re-run.

-- Same shape as approve_event_safety_review (migration 0028): the status
-- change and the decision land together or not at all, and the update
-- only matches while the event is still in Safety Review, so a concurrent
-- decision, re-review or cancellation makes it return null instead of
-- moving the event. A rejection doesn't end the event: it returns to
-- Planning with its venue bookings and equipment reservations untouched,
-- for the coordinator to rework (E3-13 assumption). The reason is
-- required — event_safety_reviews' check constraint refuses a 'Rejected'
-- row without one. Returns the new review's id.
create or replace function reject_event_safety_review(
  p_event_id integer,
  p_officer_id text,
  p_reason text
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

  insert into event_safety_reviews (event_id, officer_id, outcome, reason, submission_id)
  values (p_event_id, p_officer_id, 'Rejected', p_reason, v_submission_id)
  returning id into v_review_id;

  return v_review_id;
end;
$$;
