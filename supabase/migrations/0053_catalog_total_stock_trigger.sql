-- Drop the stored available_stock counter; keep total_stock, but have the
-- database keep it equal to the number of unit rows.
--
-- available_stock was a date-blind running total that 0051 stopped using. What
-- is "available" depends on the date (bookings, unusable periods), so it is
-- worked out when read (catalog_stock_now, 0051) and has no place as a column.
--
-- total_stock stays because it is a plain fact that only changes when a unit
-- row is added or removed. Instead of the application remembering to update it
-- (change_equipment_stock and the catalog POST used to, then stopped in 0051),
-- a trigger on `equipment` recomputes it for the catalog items touched by any
-- insert, delete or update, so it cannot drift. Statement-level, so adding
-- 1000 units recounts once, not 1000 times.
--
-- This also means total_stock can no longer be used as an input: seeds that
-- built units from it now carry the quantities themselves (seed.sql,
-- scripts/seed_equipment.sql). Writing total_stock by hand is overwritten the
-- next time a unit changes.
--
-- Guarded so this is safe to re-run.

alter table equipment_catalog drop column if exists available_stock;

create or replace function sync_catalog_total_stock()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    update equipment_catalog c
      set total_stock = (select count(*) from equipment e where e.equipment_catalog_id = c.id)
      where c.id in (select equipment_catalog_id from new_rows where equipment_catalog_id is not null);
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    update equipment_catalog c
      set total_stock = (select count(*) from equipment e where e.equipment_catalog_id = c.id)
      where c.id in (select equipment_catalog_id from old_rows where equipment_catalog_id is not null);
  end if;
  return null;
end;
$$;

drop trigger if exists equipment_total_stock_insert on equipment;
create trigger equipment_total_stock_insert
  after insert on equipment
  referencing new table as new_rows
  for each statement execute function sync_catalog_total_stock();

drop trigger if exists equipment_total_stock_update on equipment;
create trigger equipment_total_stock_update
  after update on equipment
  referencing old table as old_rows new table as new_rows
  for each statement execute function sync_catalog_total_stock();

drop trigger if exists equipment_total_stock_delete on equipment;
create trigger equipment_total_stock_delete
  after delete on equipment
  referencing old table as old_rows
  for each statement execute function sync_catalog_total_stock();

-- Catch up anything that drifted while nothing maintained the column.
update equipment_catalog c
  set total_stock = (select count(*) from equipment e where e.equipment_catalog_id = c.id);
