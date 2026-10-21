-- Reserving equipment as one step.
--
-- Moving a request to Arranged / Partially Fulfilled (E5-3, E5-6) used to be
-- three separate database calls from the application: pick free units, move
-- the stock counters (apply_equipment_request_status, 0022), then write the
-- equipment_booking rows. If the last step failed, the counters had already
-- moved and the code tried to undo them with a second call. This function does
-- all of it in one transaction, so a failure anywhere leaves nothing changed.
--
-- Which units are free for the event's dates is still decided by the
-- application, because event times live in events-service and the database
-- holds no dates. The application passes the units it chose in p_claims
-- ([{"itemId": 1, "unitIds": [201, 202]}], one entry per item whose reserved
-- quantity grows). What this function can check, and does, is what the
-- database knows: each unit exists, is the right equipment item, is still
-- 'Available', and is not already reserved for this same event. It does NOT
-- refuse a unit that is reserved for another event, since the same unit may be
-- used on different days. A shrinking item releases its oldest bookings.
--
-- Raises (and so rolls everything back):
--   'Not enough stock ...'                  from apply_equipment_request_status
--   'Unit N is no longer available'         the unit was marked unusable meanwhile
--   'Unit N is already reserved for this event'
--   'Unit N is not the requested equipment type'
--   'Item N needs X units but Y were chosen' / 'No units were chosen for item N'
--
-- Guarded so this is safe to re-run.

create or replace function reserve_equipment_request(
  p_request_id bigint,
  p_status text,
  p_note text,
  p_fulfillments jsonb default '[]'::jsonb,
  p_claims jsonb default '[]'::jsonb
)
returns void
language plpgsql
as $$
declare
  req record;
  before_fulfilled jsonb;
  item record;
  claim jsonb;
  claimed bigint[];
  delta integer;
  unit record;
  found_units integer;
begin
  select id, event_id into req from equipment_requests where id = p_request_id for update;
  if not found then
    raise exception 'Equipment request not found: %', p_request_id;
  end if;

  -- What each item held before, to tell how many units to claim or release.
  select coalesce(jsonb_object_agg(id::text, quantity_fulfilled), '{}'::jsonb)
    into before_fulfilled
    from equipment_request_items
    where request_id = p_request_id;

  -- The stock counters and the request status (0022). Raises if there is not enough stock.
  perform apply_equipment_request_status(p_request_id, p_status, p_note, p_fulfillments);

  for item in
    select id, equipment_catalog_id, quantity_fulfilled
    from equipment_request_items
    where request_id = p_request_id
    order by id
  loop
    delta := item.quantity_fulfilled - coalesce((before_fulfilled ->> item.id::text)::integer, 0);

    if delta < 0 then
      delete from equipment_booking
      where id in (
        select id from equipment_booking where request_item_id = item.id order by id limit -delta
      );

    elsif delta > 0 then
      select e.c into claim
        from jsonb_array_elements(p_claims) as e(c)
        where (e.c ->> 'itemId')::bigint = item.id
        limit 1;
      if claim is null then
        raise exception 'No units were chosen for item %', item.id;
      end if;

      select coalesce(array_agg(t.value::bigint), '{}') into claimed
        from jsonb_array_elements_text(claim -> 'unitIds') as t(value);
      if (select count(distinct x) from unnest(claimed) as x) <> delta
         or coalesce(array_length(claimed, 1), 0) <> delta then
        raise exception 'Item % needs % units but % were chosen', item.id, delta, coalesce(array_length(claimed, 1), 0);
      end if;

      -- Lock the units so two reservations of the same unit run one after the other.
      found_units := 0;
      for unit in
        select id, equipment_catalog_id, status
        from equipment
        where id = any(claimed)
        order by id
        for update
      loop
        found_units := found_units + 1;
        if unit.equipment_catalog_id is distinct from item.equipment_catalog_id then
          raise exception 'Unit % is not the requested equipment type', unit.id;
        end if;
        if unit.status <> 'Available' then
          raise exception 'Unit % is no longer available', unit.id;
        end if;
        if exists (
          select 1 from equipment_booking b where b.equipment_id = unit.id and b.event_id = req.event_id
        ) then
          raise exception 'Unit % is already reserved for this event', unit.id;
        end if;
      end loop;
      if found_units <> delta then
        raise exception 'Unknown equipment unit in the claim for item %', item.id;
      end if;

      insert into equipment_booking (equipment_id, event_id, request_item_id)
        select u, req.event_id, item.id from unnest(claimed) as u;
    end if;
  end loop;
end;
$$;
