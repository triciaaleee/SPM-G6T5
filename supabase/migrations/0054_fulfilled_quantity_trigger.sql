-- Keep equipment_request_items.quantity_fulfilled equal to the number of
-- Reserved bookings for the item, by trigger.
--
-- quantity_fulfilled is the request's record of how many units it holds. The
-- units themselves are the Reserved rows in equipment_booking, so the two must
-- always agree. Until now every function that touched a booking also updated
-- the counter by hand, so a new code path (or a manual fix in SQL) that forgot
-- would let them drift. A statement-level trigger on equipment_booking now
-- recomputes the count for each item a statement touched, the same approach as
-- total_stock (0053). The existing functions still write the column; they now
-- write the value the trigger would, so nothing about them has to change.
--
-- Guarded so this is safe to re-run.

create or replace function sync_item_quantity_fulfilled()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    update equipment_request_items i
      set quantity_fulfilled = (
        select count(*) from equipment_booking b
        where b.request_item_id = i.id and b.status = 'Reserved'
      )
      where i.id in (select request_item_id from new_rows where request_item_id is not null);
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    update equipment_request_items i
      set quantity_fulfilled = (
        select count(*) from equipment_booking b
        where b.request_item_id = i.id and b.status = 'Reserved'
      )
      where i.id in (select request_item_id from old_rows where request_item_id is not null);
  end if;
  return null;
end;
$$;

drop trigger if exists equipment_booking_fulfilled_insert on equipment_booking;
create trigger equipment_booking_fulfilled_insert
  after insert on equipment_booking
  referencing new table as new_rows
  for each statement execute function sync_item_quantity_fulfilled();

drop trigger if exists equipment_booking_fulfilled_update on equipment_booking;
create trigger equipment_booking_fulfilled_update
  after update on equipment_booking
  referencing old table as old_rows new table as new_rows
  for each statement execute function sync_item_quantity_fulfilled();

drop trigger if exists equipment_booking_fulfilled_delete on equipment_booking;
create trigger equipment_booking_fulfilled_delete
  after delete on equipment_booking
  referencing old table as old_rows
  for each statement execute function sync_item_quantity_fulfilled();

-- Catch up anything that drifted before the trigger existed.
update equipment_request_items i
  set quantity_fulfilled = (
    select count(*) from equipment_booking b
    where b.request_item_id = i.id and b.status = 'Reserved'
  )
  where quantity_fulfilled <> (
    select count(*) from equipment_booking b
    where b.request_item_id = i.id and b.status = 'Reserved'
  );
