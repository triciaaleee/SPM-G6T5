-- Stop using the stock counters (equipment_catalog.total_stock and
-- available_stock) and compute stock from the unit rows and their bookings.
--
-- The counters were a date-blind running total: reserving a unit for any event,
-- on any day, took one off available_stock, so an item with N units could back
-- at most N reservations across all events however far apart, and the
-- availability page subtracted reserved units twice (once in the counter, once
-- as "reserved elsewhere"). Whether a unit is free is a per-unit, per-date
-- question that equipment_booking's stored windows (0050) can already answer.
--
-- From here:
--   total      = the number of unit rows for the catalog item;
--   available  = units that are Available, have no unusable period today and
--                no booking whose window overlaps today (catalog_stock_now);
--   a reservation is refused by the per-unit checks in reserve_equipment_request
--   (type, status, booked for overlapping dates, unavailable during these
--   dates), not by a counter, so "Not enough stock" is no longer raised.
--
-- equipment_request_items.quantity_fulfilled is still written: it is the
-- request's own record of how many Technical Support marked fulfilled, which the
-- routes and the API use. The stock counters are simply no longer read or
-- written. The columns stay until migration 0052 drops them, so this can be
-- rolled back by redeploying the previous functions.
--
-- Guarded (create or replace) so this is safe to re-run.

create or replace function apply_equipment_request_status(
  p_request_id bigint,
  p_status text,
  p_note text,
  p_fulfillments jsonb default '[]'::jsonb
)
returns void
language plpgsql
as $$
declare
  item record;
  target_fulfilled integer;
begin
  if p_status not in ('Requested', 'Arranged', 'Partially Fulfilled') then
    raise exception 'Invalid status: %', p_status;
  end if;

  if not exists (select 1 from equipment_requests where id = p_request_id for update) then
    raise exception 'Equipment request not found: %', p_request_id;
  end if;

  for item in
    select id, quantity, quantity_fulfilled, equipment_catalog_id
    from equipment_request_items
    where request_id = p_request_id
    order by equipment_catalog_id, id
  loop
    if p_status = 'Requested' then
      target_fulfilled := 0;
    elsif p_status = 'Arranged' then
      target_fulfilled := item.quantity;
    else
      select (elem->>'fulfilledQuantity')::integer into target_fulfilled
      from jsonb_array_elements(p_fulfillments) elem
      where (elem->>'itemId')::bigint = item.id;

      if target_fulfilled is null then
        raise exception 'Missing fulfilled quantity for item %', item.id;
      end if;
      if target_fulfilled < 0 or target_fulfilled > item.quantity then
        raise exception 'Fulfilled quantity for item % must be between 0 and %', item.id, item.quantity;
      end if;
    end if;

    update equipment_request_items
      set quantity_fulfilled = target_fulfilled
      where id = item.id;
  end loop;

  update equipment_requests
    set status = p_status, fulfillment_note = p_note
    where id = p_request_id;
end;
$$;

create or replace function release_equipment_for_event(p_event_id integer)
returns void
language plpgsql
as $$
declare
  item record;
begin
  for item in
    select eri.id, eri.quantity_fulfilled, eri.equipment_catalog_id
    from equipment_request_items eri
    join equipment_requests er on er.id = eri.request_id
    where er.event_id = p_event_id and eri.quantity_fulfilled > 0
    order by eri.equipment_catalog_id, eri.id
  loop
    update equipment_request_items
      set quantity_fulfilled = 0
      where id = item.id;
  end loop;

  delete from equipment_booking where event_id = p_event_id;
end;
$$;

create or replace function amend_equipment_request(p_request_id bigint, p_items jsonb)
returns jsonb
language plpgsql
as $$
declare
  req_status text;
  item record;
  spec jsonb;
  new_qty integer;
  new_catalog bigint;
  new_type text;
  surplus integer;
  total_fulfilled integer;
  all_met boolean;
  new_status text;
  changes jsonb := '[]'::jsonb;
begin
  select status into req_status from equipment_requests where id = p_request_id for update;
  if not found then
    raise exception 'Equipment request not found: %', p_request_id;
  end if;
  if req_status not in ('Requested', 'Partially Fulfilled') then
    raise exception 'Equipment request cannot be amended: %', req_status;
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'At least one item is required';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_items) as e(v)
    where e.v->>'itemId' is not null
      and not exists (
        select 1 from equipment_request_items i
        where i.id = (e.v->>'itemId')::bigint and i.request_id = p_request_id
      )
  ) then
    raise exception 'Unknown item in amendment';
  end if;

  for item in
    select id, equipment_type, quantity, quantity_fulfilled, equipment_catalog_id
    from equipment_request_items
    where request_id = p_request_id
    order by equipment_catalog_id, id
  loop
    select e.v into spec
    from jsonb_array_elements(p_items) as e(v)
    where (e.v->>'itemId')::bigint = item.id
    limit 1;

    if spec is null then
      -- Removed: give back everything it held. Its equipment_booking rows go
      -- with it (on delete cascade, migration 0027).
      delete from equipment_request_items where id = item.id;
      changes := changes || jsonb_build_object(
        'kind', 'removed',
        'equipmentType', item.equipment_type,
        'quantity', item.quantity,
        'released', item.quantity_fulfilled
      );
      continue;
    end if;

    new_qty := (spec->>'quantity')::integer;
    new_catalog := (spec->>'equipmentCatalogId')::bigint;
    new_type := spec->>'equipmentType';

    if new_catalog is distinct from item.equipment_catalog_id then
      delete from equipment_booking where request_item_id = item.id;
      update equipment_request_items
        set equipment_catalog_id = new_catalog,
            equipment_type = new_type,
            quantity = new_qty,
            quantity_fulfilled = 0
        where id = item.id;
      changes := changes || jsonb_build_object(
        'kind', 'type',
        'fromType', item.equipment_type,
        'equipmentType', new_type,
        'from', item.quantity,
        'to', new_qty,
        'released', item.quantity_fulfilled
      );
    elsif new_qty <> item.quantity then
      surplus := greatest(0, item.quantity_fulfilled - new_qty);
      if surplus > 0 then
        delete from equipment_booking
          where id in (
            select id from equipment_booking
            where request_item_id = item.id
            order by id
            limit surplus
          );
      end if;
      update equipment_request_items
        set quantity = new_qty,
            quantity_fulfilled = least(item.quantity_fulfilled, new_qty)
        where id = item.id;
      changes := changes || jsonb_build_object(
        'kind', 'quantity',
        'equipmentType', item.equipment_type,
        'from', item.quantity,
        'to', new_qty,
        'released', surplus
      );
    end if;
  end loop;

  for spec in
    select e.v from jsonb_array_elements(p_items) as e(v) where e.v->>'itemId' is null
  loop
    insert into equipment_request_items (request_id, equipment_catalog_id, equipment_type, quantity)
    values (
      p_request_id,
      (spec->>'equipmentCatalogId')::bigint,
      spec->>'equipmentType',
      (spec->>'quantity')::integer
    );
    changes := changes || jsonb_build_object(
      'kind', 'added',
      'equipmentType', spec->>'equipmentType',
      'quantity', (spec->>'quantity')::integer,
      'released', 0
    );
  end loop;

  select coalesce(sum(quantity_fulfilled), 0), coalesce(bool_and(quantity_fulfilled >= quantity), false)
    into total_fulfilled, all_met
    from equipment_request_items
    where request_id = p_request_id;

  if total_fulfilled = 0 then
    new_status := 'Requested';
  elsif all_met then
    new_status := 'Arranged';
  else
    new_status := 'Partially Fulfilled';
  end if;

  update equipment_requests
    set status = new_status,
        fulfillment_note = case when new_status = 'Partially Fulfilled' then fulfillment_note else null end
    where id = p_request_id;

  return jsonb_build_object('status', new_status, 'changes', changes);
end;
$$;

create or replace function release_equipment_for_request(p_request_id bigint)
returns jsonb
language plpgsql
as $$
declare
  req_status text;
  item record;
  released jsonb := '[]'::jsonb;
begin
  select status into req_status from equipment_requests where id = p_request_id for update;
  if not found then
    raise exception 'Equipment request not found: %', p_request_id;
  end if;
  if req_status = 'Cancelled' then
    raise exception 'Equipment request already cancelled: %', p_request_id;
  end if;

  for item in
    select id, equipment_type, quantity_fulfilled, equipment_catalog_id
    from equipment_request_items
    where request_id = p_request_id
    order by equipment_catalog_id, id
  loop
    if item.quantity_fulfilled > 0 then
      released := released || jsonb_build_object(
        'equipmentType', item.equipment_type,
        'quantity', item.quantity_fulfilled
      );
      update equipment_request_items set quantity_fulfilled = 0 where id = item.id;
    end if;
    delete from equipment_booking where request_item_id = item.id;
  end loop;

  update equipment_requests
    set status = 'Cancelled', fulfillment_note = null
    where id = p_request_id;

  return jsonb_build_object('released', released);
end;
$$;

create or replace function change_equipment_stock(
  p_catalog_id bigint,
  p_delta integer,
  p_reason text,
  p_user text
)
returns jsonb
language plpgsql
as $$
declare
  cat record;
  free_ids bigint[];
  removable integer;
  wanted integer;
  total_before integer;
  total_after integer;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'Quantity must be at least 1';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required';
  end if;

  select id, name into cat from equipment_catalog where id = p_catalog_id for update;
  if not found then
    raise exception 'Equipment item not found: %', p_catalog_id;
  end if;

  select count(*) into total_before from equipment where equipment_catalog_id = cat.id;

  if p_delta > 0 then
    insert into equipment (type, status, equipment_catalog_id)
      select cat.name, 'Available', cat.id from generate_series(1, p_delta);
  else
    wanted := -p_delta;
    select coalesce(array_agg(s.id), '{}') into free_ids from (
      select e.id
      from equipment e
      where e.equipment_catalog_id = cat.id
        and e.status = 'Available'
        and not exists (select 1 from equipment_booking b where b.equipment_id = e.id)
        and not exists (
          select 1 from equipment_unavailability u
          where u.equipment_id = e.id and (u.end_date is null or u.end_date >= current_date)
        )
      order by e.id desc
      limit wanted
    ) s;

    removable := coalesce(array_length(free_ids, 1), 0);
    if removable < wanted then
      raise exception 'Cannot remove %: only % can be removed', wanted, removable;
    end if;

    delete from equipment where id = any(free_ids);
  end if;

  total_after := total_before + p_delta;

  insert into equipment_stock_changes
    (equipment_catalog_id, change_type, quantity, total_before, total_after, reason, changed_by)
  values
    (cat.id, case when p_delta > 0 then 'Added' else 'Removed' end, abs(p_delta),
     total_before, total_after, btrim(p_reason), p_user);

  return jsonb_build_object('id', cat.id, 'name', cat.name, 'totalStock', total_after);
end;
$$;

create or replace function catalog_stock_now(p_day date, p_start_ms bigint, p_end_ms bigint)
returns table (catalog_id bigint, total integer, unusable_now integer, available integer)
language sql
stable
as $$
  with unit as (
    select
      e.equipment_catalog_id as catalog_id,
      (
        e.status <> 'Available'
        or exists (
          select 1 from equipment_unavailability u
          where u.equipment_id = e.id
            and u.start_date <= p_day
            and (u.end_date is null or u.end_date >= p_day)
        )
      ) as unusable,
      exists (
        select 1 from equipment_booking b
        where b.equipment_id = e.id
          and b.window_start_ms is not null
          and b.window_start_ms < p_end_ms
          and p_start_ms < b.window_end_ms
      ) as booked
    from equipment e
  )
  select
    c.id,
    count(u.catalog_id)::integer,
    count(*) filter (where u.unusable)::integer,
    count(*) filter (where not u.unusable and not u.booked)::integer
  from equipment_catalog c
  left join unit u on u.catalog_id = c.id
  group by c.id;
$$;

create or replace function reserve_equipment_request(
  p_request_id bigint,
  p_status text,
  p_note text,
  p_fulfillments jsonb default '[]'::jsonb,
  p_claims jsonb default '[]'::jsonb,
  p_window_start_ms bigint default null,
  p_window_end_ms bigint default null
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
  first_day date;
  last_day date;
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

      if p_window_start_ms is null or p_window_end_ms is null or p_window_end_ms <= p_window_start_ms then
        raise exception 'The event window is required to reserve item %', item.id;
      end if;
      -- Whole days the window touches, for comparing with unavailability periods
      -- (end is exclusive, so the last day is the one holding end - 1 ms).
      first_day := (to_timestamp(p_window_start_ms / 1000.0) at time zone 'UTC')::date;
      last_day := (to_timestamp((p_window_end_ms - 1) / 1000.0) at time zone 'UTC')::date;

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
        if exists (
          select 1 from equipment_booking b
          where b.equipment_id = unit.id
            and b.window_start_ms is not null
            and b.window_start_ms < p_window_end_ms
            and p_window_start_ms < b.window_end_ms
        ) then
          raise exception 'Unit % is already booked for overlapping dates', unit.id;
        end if;
        if exists (
          select 1 from equipment_unavailability u
          where u.equipment_id = unit.id
            and u.start_date <= last_day
            and (u.end_date is null or u.end_date >= first_day)
        ) then
          raise exception 'Unit % is unavailable during these dates', unit.id;
        end if;
      end loop;
      if found_units <> delta then
        raise exception 'Unknown equipment unit in the claim for item %', item.id;
      end if;

      insert into equipment_booking (equipment_id, event_id, request_item_id, window_start_ms, window_end_ms)
        select u, req.event_id, item.id, p_window_start_ms, p_window_end_ms from unnest(claimed) as u;
    end if;
  end loop;
end;
$$;
