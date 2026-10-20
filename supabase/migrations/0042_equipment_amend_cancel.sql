-- E5-2: the Event Coordinator amends or cancels an equipment request.
--
-- Both changes move stock and per-unit reservations (equipment_booking), so
-- each is one database function: a request's items, the stock it holds and
-- its reservations can't drift apart half way through. They run in the
-- caller's transaction (PostgREST wraps each request in one), so any
-- exception rolls everything back.
--
-- A request's status stays plain text (migration 0020); this adds a fourth
-- value, 'Cancelled' — the coordinator withdrew the whole request. The row
-- and its items stay as history; nothing is reserved against it any more.
-- Technical Support never sees a Cancelled request in their queue.
--
-- Guarded (create or replace) so this is safe to re-run.

-- Amends a request in place. p_items is the request's full new item list, a
-- jsonb array of {"itemId": <existing item id, absent for a new item>,
-- "equipmentCatalogId": ..., "equipmentType": <catalog name>, "quantity": ...}.
-- Existing items missing from the list are removed.
--
--   * quantity lowered below what is reserved -> the surplus is released:
--     stock returns to equipment_catalog and that many equipment_booking
--     rows are deleted (AC2).
--   * type changed -> everything reserved of the old type is released and
--     the item starts unreserved as the new type.
--   * item removed -> everything reserved against it is released.
--   * quantity raised, or a new item -> nothing is reserved automatically;
--     Technical Support arrange it.
--
-- Only a 'Requested' or 'Partially Fulfilled' request can be amended. The
-- status is then recomputed from what is still reserved (nothing -> Requested,
-- everything -> Arranged, otherwise Partially Fulfilled), so an amended
-- request never claims more than it holds.
--
-- Returns {"status": ..., "changes": [...]} where each change is
-- {"kind": "quantity"|"type"|"added"|"removed", "equipmentType", "fromType"?,
--  "from"?, "to"?, "quantity"?, "released"}.
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
      if item.quantity_fulfilled > 0 and item.equipment_catalog_id is not null then
        update equipment_catalog
          set available_stock = available_stock + item.quantity_fulfilled
          where id = item.equipment_catalog_id;
      end if;
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
      if item.quantity_fulfilled > 0 and item.equipment_catalog_id is not null then
        update equipment_catalog
          set available_stock = available_stock + item.quantity_fulfilled
          where id = item.equipment_catalog_id;
      end if;
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
        if item.equipment_catalog_id is not null then
          update equipment_catalog
            set available_stock = available_stock + surplus
            where id = item.equipment_catalog_id;
        end if;
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

-- Cancels a request entirely (AC3): releases everything reserved against it
-- (stock back to equipment_catalog, its equipment_booking rows deleted) and
-- marks it 'Cancelled'. The items stay, unreserved, as history. Mirrors
-- release_equipment_for_event (migration 0027), but for one request.
--
-- Returns {"released": [{"equipmentType": ..., "quantity": ...}]} — only the
-- items that actually held something.
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
      if item.equipment_catalog_id is not null then
        update equipment_catalog
          set available_stock = available_stock + item.quantity_fulfilled
          where id = item.equipment_catalog_id;
      end if;
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
