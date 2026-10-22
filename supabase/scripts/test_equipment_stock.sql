-- DEV ONLY. Checks the equipment functions in the database itself (the vitest
-- route tests mock them, so nothing else tests the SQL).
--
-- Run it in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/scripts/test_equipment_stock.sql
--
-- It creates its own catalog items ("ZZ Test ...") and requests, runs the
-- functions that reserve and release equipment, and ROLLS BACK at the end, so
-- nothing is kept. Needs migrations 0048-0056 and at least one event and one
-- coordinator user (the normal seed has both).
--
-- Every check is logged, and the script ends by raising the log as an error
-- ("ALL PASSED (N checks)" plus the list), which also rolls everything back.
-- The first failure raises "FAIL: ..." with the expected and actual value.
-- See also test_equipment_overlap.sql (overlapping dates, unavailability).

begin;

-- The editor doesn't show notices, so every passed check is also logged here and
-- the script ends by raising the log (which also rolls everything back).
create temp table test_log (n serial, line text);

create function pg_temp.assert_eq(label text, actual text, expected text) returns void
language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL: % (expected %, got %)', label, expected, actual;
  end if;
  raise notice 'PASS: %', label;
  insert into test_log (line) values ('PASS: ' || label);
end
$$;

create function pg_temp.total(p_cat bigint) returns text
language sql as $$ select total_stock::text from equipment_catalog where id = p_cat $$;

create function pg_temp.units(p_cat bigint) returns text
language sql as $$ select count(*)::text from equipment where equipment_catalog_id = p_cat $$;

create function pg_temp.fulfilled(p_item bigint) returns text
language sql as $$ select quantity_fulfilled::text from equipment_request_items where id = p_item $$;

create function pg_temp.reserved(p_item bigint) returns text
language sql as $$ select count(*)::text from equipment_booking where request_item_id = p_item and status = 'Reserved' $$;

create function pg_temp.released(p_event integer, p_reason text) returns text
language sql as $$
  select count(*)::text from equipment_booking
  where event_id = p_event and status = 'Released' and release_reason = p_reason
$$;

create function pg_temp.req_status(p_req bigint) returns text
language sql as $$ select status from equipment_requests where id = p_req $$;

-- A claim for reserve_equipment_request: the first p_n free units of a catalog item.
create function pg_temp.claim(p_item bigint, p_cat bigint, p_n integer) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object('itemId', p_item, 'unitIds', coalesce(jsonb_agg(u.id), '[]'::jsonb)))
  from (
    select e.id from equipment e
    where e.equipment_catalog_id = p_cat and e.status = 'Available'
      and not exists (select 1 from equipment_booking b where b.equipment_id = e.id and b.status = 'Reserved')
    order by e.id limit p_n
  ) u
$$;

do $$
declare
  v_event integer;
  v_coord text;
  cat bigint;
  r1 bigint; i1 bigint;
  r2 bigint; i2 bigint;
  t0 bigint := 1900000000000;
  day bigint := 86400000;
  out jsonb;
  threw boolean;
begin
  select min(id) into v_event from events;
  select min(id) into v_coord from users where role = 'coordinator';
  if v_event is null or v_coord is null then
    raise exception 'Needs at least one event and one coordinator user (run supabase/seed.sql first)';
  end if;

  -- total_stock follows the unit rows (0053) --------------------------------------
  insert into equipment_catalog (name) values ('ZZ Test Projector') returning id into cat;
  perform pg_temp.assert_eq('a new catalog item has no stock', pg_temp.total(cat), '0');
  insert into equipment (type, status, equipment_catalog_id) select 'ZZ Test Projector', 'Available', cat from generate_series(1, 6);
  perform pg_temp.assert_eq('adding 6 units sets total_stock to 6', pg_temp.total(cat), '6');
  update equipment set status = 'Damaged' where id = (select min(id) from equipment where equipment_catalog_id = cat);
  perform pg_temp.assert_eq('a damaged unit still counts in total_stock', pg_temp.total(cat), '6');

  -- reserve_equipment_request -----------------------------------------------------
  insert into equipment_requests (event_id, coordinator_id) values (v_event, v_coord) returning id into r1;
  insert into equipment_request_items (request_id, equipment_type, quantity, equipment_catalog_id)
    values (r1, 'ZZ Test Projector', 3, cat) returning id into i1;

  perform reserve_equipment_request(r1, 'Arranged', null, '[]'::jsonb, pg_temp.claim(i1, cat, 3), t0, t0 + day);
  perform pg_temp.assert_eq('Arranged sets the request status', pg_temp.req_status(r1), 'Arranged');
  perform pg_temp.assert_eq('Arranged records the full quantity as fulfilled', pg_temp.fulfilled(i1), '3');
  perform pg_temp.assert_eq('Arranged writes one Reserved booking per unit', pg_temp.reserved(i1), '3');

  -- Partially Fulfilled down to 1 releases the other two, keeping them as history.
  perform reserve_equipment_request(r1, 'Partially Fulfilled', 'one arrived',
    jsonb_build_array(jsonb_build_object('itemId', i1, 'fulfilledQuantity', 1)), '[]'::jsonb, t0, t0 + day);
  perform pg_temp.assert_eq('lowering the fulfilment keeps 1 Reserved', pg_temp.reserved(i1), '1');
  perform pg_temp.assert_eq('lowering the fulfilment marks 2 Released', pg_temp.released(v_event, 'Fulfilment reduced'), '2');

  -- Back to Requested releases the last one.
  perform reserve_equipment_request(r1, 'Requested', null, '[]'::jsonb, '[]'::jsonb);
  perform pg_temp.assert_eq('reverting to Requested leaves nothing Reserved', pg_temp.reserved(i1), '0');
  perform pg_temp.assert_eq('the released rows are kept', (select count(*)::text from equipment_booking where event_id = v_event and status = 'Released'), '3');

  -- A request can only claim what the claim says: asking for more than were chosen fails.
  threw := false;
  begin
    perform reserve_equipment_request(r1, 'Arranged', null, '[]'::jsonb, pg_temp.claim(i1, cat, 2), t0, t0 + day);
  exception when others then threw := true; end;
  perform pg_temp.assert_eq('fewer units chosen than needed is refused', threw::text, 'true');

  -- release_equipment_for_event ---------------------------------------------------
  perform reserve_equipment_request(r1, 'Arranged', null, '[]'::jsonb, pg_temp.claim(i1, cat, 3), t0, t0 + day);
  perform release_equipment_for_event(v_event);
  perform pg_temp.assert_eq('releasing the event zeroes the fulfilment', pg_temp.fulfilled(i1), '0');
  perform pg_temp.assert_eq('releasing the event leaves nothing Reserved', pg_temp.reserved(i1), '0');
  perform pg_temp.assert_eq('releasing the event records why', pg_temp.released(v_event, 'Event cancelled'), '3');
  perform pg_temp.assert_eq('releasing the event cancels its requests', pg_temp.req_status(r1), 'Cancelled');
  -- Test only: reopen the request so the steps below can reuse it.
  update equipment_requests set status = 'Requested' where id = r1;

  -- amend_equipment_request: lowering the quantity below what is reserved -----------
  -- (a request can only be amended while Requested or Partially Fulfilled)
  perform reserve_equipment_request(r1, 'Partially Fulfilled', null,
    jsonb_build_array(jsonb_build_object('itemId', i1, 'fulfilledQuantity', 3)), pg_temp.claim(i1, cat, 3), t0, t0 + day);
  out := amend_equipment_request(r1, jsonb_build_array(jsonb_build_object(
    'itemId', i1, 'equipmentCatalogId', cat, 'equipmentType', 'ZZ Test Projector', 'quantity', 2)));
  perform pg_temp.assert_eq('amending down releases the surplus unit', pg_temp.reserved(i1), '2');
  perform pg_temp.assert_eq('amending down records why', pg_temp.released(v_event, 'Quantity lowered'), '1');

  -- release_equipment_for_request: cancelling the request ---------------------------
  out := release_equipment_for_request(r1);
  perform pg_temp.assert_eq('cancelling the request marks it Cancelled', pg_temp.req_status(r1), 'Cancelled');
  perform pg_temp.assert_eq('cancelling the request leaves nothing Reserved', pg_temp.reserved(i1), '0');
  perform pg_temp.assert_eq('cancelling the request records why', pg_temp.released(v_event, 'Request cancelled'), '2');

  -- change_equipment_stock --------------------------------------------------------
  perform change_equipment_stock(cat, 4, 'New delivery', (select min(id) from users where role = 'technical_support'));
  perform pg_temp.assert_eq('adding stock raises total_stock', pg_temp.total(cat), '10');
  perform pg_temp.assert_eq('adding stock creates the unit rows', pg_temp.units(cat), '10');

  insert into equipment_requests (event_id, coordinator_id) values (v_event, v_coord) returning id into r2;
  insert into equipment_request_items (request_id, equipment_type, quantity, equipment_catalog_id)
    values (r2, 'ZZ Test Projector', 8, cat) returning id into i2;
  perform reserve_equipment_request(r2, 'Arranged', null, '[]'::jsonb, pg_temp.claim(i2, cat, 8), t0, t0 + day);

  -- 10 units: 1 damaged, 8 reserved, 1 free. Only the free one can go.
  threw := false;
  begin
    perform change_equipment_stock(cat, -2, 'Sold', null);
  exception when others then threw := true; end;
  perform pg_temp.assert_eq('removing reserved or damaged units is refused', threw::text, 'true');

  perform change_equipment_stock(cat, -1, 'Sold', null);
  perform pg_temp.assert_eq('removing a free unit lowers total_stock', pg_temp.total(cat), '9');
  perform pg_temp.assert_eq('removing a free unit deletes its row', pg_temp.units(cat), '9');

  -- quantity_fulfilled follows the bookings by trigger (0054) -----------------------
  -- Changing bookings directly, bypassing every function, must still keep the count right.
  perform pg_temp.assert_eq('8 Reserved bookings mean fulfilled 8 (before the manual change)', pg_temp.fulfilled(i2), '8');
  update equipment_booking set status = 'Released', released_at = now(), release_reason = 'manual test'
    where id = (select min(id) from equipment_booking where request_item_id = i2 and status = 'Reserved');
  perform pg_temp.assert_eq('releasing a booking by hand lowers quantity_fulfilled', pg_temp.fulfilled(i2), '7');
  delete from equipment_booking
    where id = (select min(id) from equipment_booking where request_item_id = i2 and status = 'Reserved');
  perform pg_temp.assert_eq('deleting a booking by hand lowers quantity_fulfilled', pg_temp.fulfilled(i2), '6');

  raise notice 'ALL PASSED';
end
$$;

-- Raising rolls everything back; the message is the report.
do $$
declare
  report text;
begin
  select string_agg(line, E'\n' order by n) into report from test_log;
  raise exception E'ALL PASSED (% checks)\n%', (select count(*) from test_log), report;
end
$$;

rollback;
