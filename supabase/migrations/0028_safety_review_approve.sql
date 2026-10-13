-- E3-12: the Safety Officer approves an event's Operational Safety Check
-- (Safety Review -> Confirmed). Owned by events-service.
--
-- Guarded so this is safe to re-run.

-- The status change and the decision land together or not at all. The
-- update only matches while the event is still in Safety Review, so a
-- concurrent decision or re-review (arrangements changed) between
-- events-service's checks and this call makes it return null instead of
-- moving the event. The decision is linked to the submission it answers
-- (E3-4/E1-10) via the latest row in event_safety_submissions for this
-- event — there is exactly one unanswered submission at a time, since a
-- submission only exists while the event is in Safety Review. Returns the
-- new review's id.
create or replace function approve_event_safety_review(
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
     set status = 'Confirmed'
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
  values (p_event_id, p_officer_id, 'Approved', p_reason, v_submission_id)
  returning id into v_review_id;

  return v_review_id;
end;
$$;
