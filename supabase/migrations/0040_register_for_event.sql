-- E6: race-safe registration. Two attendees going for the last place used to
-- both pass the count check (the count and the write were separate steps).
-- This function does count + write as one unit, serialised per event with a
-- transaction-level advisory lock keyed on the event id. (An advisory lock,
-- not a lock on the events row, because registration-service owns only the
-- registrations table and never touches events.)
--
-- p_capacity is null for an uncapped event. Returns:
--   'registered'          a new row, or a Withdrawn row back to Registered
--   'already_registered'  the attendee already holds a place
--   'full'                no place left
-- p_set_info = false keeps a returning attendee's earlier additional_info.
create or replace function public.register_for_event(
  p_event_id integer,
  p_user_id text,
  p_capacity integer,
  p_additional_info jsonb,
  p_set_info boolean
) returns text
language plpgsql
as $$
declare
  v_existing_status registration_status;
  v_count integer;
begin
  perform pg_advisory_xact_lock(p_event_id);

  select status into v_existing_status
  from registrations
  where event_id = p_event_id and user_id = p_user_id;

  if v_existing_status = 'Registered' then
    return 'already_registered';
  end if;

  if p_capacity is not null then
    select count(*) into v_count
    from registrations
    where event_id = p_event_id and status = 'Registered';
    if v_count >= p_capacity then
      return 'full';
    end if;
  end if;

  if v_existing_status is null then
    insert into registrations (event_id, user_id, status, additional_info)
    values (p_event_id, p_user_id, 'Registered', p_additional_info);
  else
    update registrations
    set status = 'Registered',
        additional_info = case when p_set_info then p_additional_info else additional_info end
    where event_id = p_event_id and user_id = p_user_id;
  end if;

  return 'registered';
end;
$$;
