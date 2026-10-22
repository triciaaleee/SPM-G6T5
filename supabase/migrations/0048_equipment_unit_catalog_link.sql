-- Links every equipment unit to its catalog item by id, not by matching names.
--
-- Until now an `equipment` row belonged to a catalog item only because its
-- `type` text happened to equal `equipment_catalog.name`, and a request item's
-- `equipment_catalog_id` was optional. Nothing stopped the two drifting apart,
-- and anything computed per catalog item (stock, availability) had to join on
-- text. Now:
--   * equipment.equipment_catalog_id points at the catalog item;
--   * request items must have one too;
--   * change_equipment_stock() finds and creates units by that id.
-- `equipment.type` stays for now (still written, no longer used to look units up),
-- so the API's `type` field keeps working unchanged.
--
-- Guarded so this is safe to re-run. NOT NULL is only applied when every
-- existing row could be linked; otherwise it raises a notice and leaves the
-- column nullable so the rows can be fixed by hand first.

alter table equipment
  add column if not exists equipment_catalog_id bigint references equipment_catalog (id);

update equipment e
set equipment_catalog_id = c.id
from equipment_catalog c
where e.equipment_catalog_id is null and c.name = e.type;

update equipment_request_items i
set equipment_catalog_id = c.id
from equipment_catalog c
where i.equipment_catalog_id is null and c.name = i.equipment_type;

create index if not exists equipment_catalog_status_idx on equipment (equipment_catalog_id, status);

do $$
begin
  if exists (select 1 from equipment where equipment_catalog_id is null) then
    raise notice 'equipment: some units match no catalog item; equipment_catalog_id left nullable. Fix: select id, type from equipment where equipment_catalog_id is null;';
  else
    alter table equipment alter column equipment_catalog_id set not null;
  end if;

  if exists (select 1 from equipment_request_items where equipment_catalog_id is null) then
    raise notice 'equipment_request_items: some items match no catalog item; equipment_catalog_id left nullable. Fix: select id, equipment_type from equipment_request_items where equipment_catalog_id is null;';
  else
    alter table equipment_request_items alter column equipment_catalog_id set not null;
  end if;
end
$$;

-- change_equipment_stock (0044), now finding and creating units by catalog id.
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
  new_total integer;
  new_available integer;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'Quantity must be at least 1';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required';
  end if;

  select id, name, total_stock, available_stock into cat
    from equipment_catalog where id = p_catalog_id for update;
  if not found then
    raise exception 'Equipment item not found: %', p_catalog_id;
  end if;

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

    removable := least(coalesce(array_length(free_ids, 1), 0), cat.available_stock);
    if removable < wanted then
      raise exception 'Cannot remove %: only % can be removed', wanted, removable;
    end if;

    delete from equipment where id = any(free_ids);
  end if;

  new_total := cat.total_stock + p_delta;
  new_available := cat.available_stock + p_delta;
  update equipment_catalog
    set total_stock = new_total, available_stock = new_available
    where id = cat.id;

  insert into equipment_stock_changes
    (equipment_catalog_id, change_type, quantity, total_before, total_after, reason, changed_by)
  values
    (cat.id, case when p_delta > 0 then 'Added' else 'Removed' end, abs(p_delta),
     cat.total_stock, new_total, btrim(p_reason), p_user);

  return jsonb_build_object(
    'id', cat.id,
    'name', cat.name,
    'totalStock', new_total,
    'availableStock', new_available
  );
end;
$$;
