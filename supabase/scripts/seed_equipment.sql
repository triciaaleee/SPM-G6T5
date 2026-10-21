-- DEV ONLY. Resets and reseeds Technical Support's equipment inventory.
-- Re-run it any time to get back to a known state. Run it in the Supabase
-- SQL editor, or: psql "$DATABASE_URL" -f supabase/scripts/seed_equipment.sql
--
-- What it does, in one transaction so nothing is left half-done:
--   1. Releases every reservation: deletes all equipment_booking rows, zeroes
--      every request item's quantity_fulfilled, and puts Arranged / Partially
--      Fulfilled requests back to Requested. The requests themselves, their
--      items and any Cancelled requests are kept.
--   2. Clears the per-unit rows, their unavailability periods and the stock
--      change log, since the totals below replace them.
--   3. Upserts equipment_catalog (the names in the list below).
--   4. Creates one `equipment` row per unit, with the quantities in the same
--      list. total_stock follows the unit rows by trigger (0053), so it is
--      never set by hand.
--   5. Puts a few units out of service so the damaged / maintenance paths
--      have something to show (E5-4, E5-5).
--
-- Do NOT run this against data you want to keep: step 1 undoes real
-- reservations. To change the quantities, edit the list in step 4.

begin;

-- 1. Release every reservation -------------------------------------------------
delete from equipment_booking;

update equipment_request_items set quantity_fulfilled = 0 where quantity_fulfilled <> 0;

update equipment_requests
set status = 'Requested', fulfillment_note = null
where status in ('Arranged', 'Partially Fulfilled');

-- 2. Clear the per-unit rows ---------------------------------------------------
-- equipment_unavailability goes with its units (on delete cascade, 0043).
delete from equipment_stock_changes;
delete from equipment;

-- 3. Catalog -------------------------------------------------------------------
-- Names overlap with venues.facilities in seed.sql where the item is the same
-- thing (e.g. "PA system"). The quantities are a starting assumption for local
-- testing, not a real inventory count.
insert into equipment_catalog (name) values
  ('Projector'),
  ('Screen'),
  ('PA system'),
  ('Microphones'),
  ('Livestream equipment'),
  ('Video conferencing'),
  ('Stage'),
  ('Lighting rig'),
  ('Folding table'),
  ('Round table'),
  ('Chairs'),
  ('Gazebo tent'),
  ('Registration desk'),
  ('Name badge printer'),
  ('Extension cords')
on conflict (name) do nothing;

-- 4. One unit per item in stock, linked to its catalog item by id (0048) -------
-- A catalog item not in this list ends up with no units (total_stock 0).
insert into equipment (type, status, equipment_catalog_id)
select ec.name, 'Available', ec.id
from (values
  ('Projector', 20),
  ('Screen', 15),
  ('PA system', 10),
  ('Microphones', 40),
  ('Livestream equipment', 8),
  ('Video conferencing', 6),
  ('Stage', 4),
  ('Lighting rig', 6),
  ('Folding table', 100),
  ('Round table', 50),
  ('Chairs', 300),
  ('Gazebo tent', 25),
  ('Registration desk', 10),
  ('Name badge printer', 5),
  ('Extension cords', 50)
) as stock (name, quantity)
join equipment_catalog ec on ec.name = stock.name
cross join generate_series(1, stock.quantity);

-- 5. A few units out of service ------------------------------------------------
-- One Projector is Damaged and two Microphones are Under Maintenance by
-- status, with no end date (out of use until someone marks them usable).
update equipment set status = 'Damaged'
where id = (select min(id) from equipment where type = 'Projector');

update equipment set status = 'Under Maintenance'
where id in (select id from equipment where type = 'Microphones' order by id limit 2);

-- A dated period (E5-5): one Screen is under maintenance from next week for
-- three days, so it is usable today but excluded for an event in that window.
-- marked_by is the first Technical Support account, or null if there is none.
insert into equipment_unavailability (equipment_id, reason, start_date, end_date, note, marked_by)
select
  (select min(id) from equipment where type = 'Screen'),
  'Under Maintenance',
  current_date + 7,
  current_date + 9,
  'Scheduled lamp and cable check',
  (select id from users where role = 'technical_support' order by id limit 1)
where exists (select 1 from equipment where type = 'Screen');

-- Sanity check: the trigger (0053) must have set total_stock to the unit count.
-- If this raises, the whole script rolls back and nothing is changed.
do $$
declare
  bad record;
begin
  select ec.name, ec.total_stock, count(e.id) as units
    into bad
    from equipment_catalog ec
    left join equipment e on e.equipment_catalog_id = ec.id
    group by ec.id, ec.name, ec.total_stock
    having count(e.id) <> ec.total_stock
    limit 1;
  if found then
    raise exception 'total_stock does not match the unit rows for "%": % units, total %', bad.name, bad.units, bad.total_stock;
  end if;
end
$$;

commit;
