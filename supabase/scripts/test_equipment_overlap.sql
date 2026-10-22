-- DEV ONLY. Checks reserve_equipment_request (0050, 0051) refuses a unit
-- that is booked for overlapping dates or unavailable for them, and allows a
-- non-overlapping one, and (case 5) that equipment_reschedule_clashes (0055)
-- reports a booking that a reschedule made clash. Paste into the Supabase SQL editor and run. It ends by
-- raising an error on purpose so everything rolls back; the message is the
-- report, so a red "ERROR: RESULTS" box is the expected outcome.
-- Needs migrations 0048-0056, plus at least two events and one coordinator.

do $$
declare
  ev1 integer; ev2 integer; v_coord text;
  cat bigint; u1 bigint;
  r1 bigint; r2 bigint; i1 bigint; i2 bigint;
  day bigint := 86400000;
  t0 bigint := 1900000000000;  -- an arbitrary instant; only differences matter
  res text := '';
  kinds text;
  err text;
  r record;
begin
  select min(id) into ev1 from events;
  select min(id) into ev2 from events where id <> ev1;
  select min(id) into v_coord from users where role = 'coordinator';
  if ev1 is null or ev2 is null or v_coord is null then
    raise exception 'Needs two events and a coordinator (run supabase/seed.sql first)';
  end if;

  insert into equipment_catalog (name) values ('ZZ Overlap Projector') returning id into cat;
  insert into equipment (type, status, equipment_catalog_id) values ('ZZ Overlap Projector', 'Available', cat) returning id into u1;
  insert into equipment_requests (event_id, coordinator_id) values (ev1, v_coord) returning id into r1;
  insert into equipment_requests (event_id, coordinator_id) values (ev2, v_coord) returning id into r2;
  insert into equipment_request_items (request_id, equipment_type, quantity, equipment_catalog_id) values (r1, 'ZZ Overlap Projector', 1, cat) returning id into i1;
  insert into equipment_request_items (request_id, equipment_type, quantity, equipment_catalog_id) values (r2, 'ZZ Overlap Projector', 1, cat) returning id into i2;

  select total_stock into r from equipment_catalog where id = cat;
  res := res || E'\n0 total_stock after adding one unit: ' || r.total_stock || ' (expect 1)';

  -- 1. First event reserves the only unit.
  perform reserve_equipment_request(r1, 'Arranged', null, '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('itemId', i1, 'unitIds', jsonb_build_array(u1))), t0, t0 + day);
  res := res || E'\n1 first reservation: ok';

  -- 2. Second event, overlapping window: must be refused.
  err := null;
  begin
    perform reserve_equipment_request(r2, 'Arranged', null, '[]'::jsonb,
      jsonb_build_array(jsonb_build_object('itemId', i2, 'unitIds', jsonb_build_array(u1))), t0 + day / 2, t0 + day + day / 2);
  exception when others then err := sqlerrm; end;
  res := res || E'\n2 overlapping dates: ' || coalesce(err, 'NOT REFUSED (bug)');

  -- 2b. catalog_stock_now: the one unit is booked over t0..t0+day, so it is not available then, and is on the day after.
  select * into r from catalog_stock_now((to_timestamp(t0 / 1000.0) at time zone 'UTC')::date, t0, t0 + day) where catalog_id = cat;
  res := res || E'\n2b stock on the booked day: total ' || r.total || ', available ' || r.available || ' (expect 1, 0)';
  select * into r from catalog_stock_now(((to_timestamp(t0 / 1000.0) at time zone 'UTC')::date + 1), t0 + day, t0 + 2 * day) where catalog_id = cat;
  res := res || E'\n2c stock the day after: total ' || r.total || ', available ' || r.available || ' (expect 1, 1)';

  -- 3. Second event the next day: allowed (one unit, two events on different days).
  err := null;
  begin
    perform reserve_equipment_request(r2, 'Arranged', null, '[]'::jsonb,
      jsonb_build_array(jsonb_build_object('itemId', i2, 'unitIds', jsonb_build_array(u1))), t0 + 2 * day, t0 + 3 * day);
  exception when others then err := sqlerrm; end;
  res := res || E'\n3 non-overlapping dates: ' || coalesce(err, 'ok');

  -- 3b. Releasing the second event keeps its booking as history, and frees the unit.
  perform release_equipment_for_event(ev2);
  select count(*) filter (where status = 'Released') as released, count(*) filter (where status = 'Reserved') as reserved
    into r from equipment_booking where equipment_id = u1 and event_id = ev2;
  res := res || E'\n3b after release, event 2 bookings: Released ' || r.released || ', Reserved ' || r.reserved || ' (expect 1, 0)';

  -- 4. Unavailable period covering the window: refused.
  delete from equipment_booking where equipment_id = u1;  -- test cleanup only
  update equipment_request_items set quantity_fulfilled = 0 where equipment_catalog_id = cat;
  update equipment_requests set status = 'Requested' where id in (r1, r2);
  insert into equipment_unavailability (equipment_id, reason, start_date, end_date)
    values (u1, 'Damaged', (to_timestamp(t0 / 1000.0) at time zone 'UTC')::date, null);
  err := null;
  begin
    perform reserve_equipment_request(r1, 'Arranged', null, '[]'::jsonb,
      jsonb_build_array(jsonb_build_object('itemId', i1, 'unitIds', jsonb_build_array(u1))), t0, t0 + day);
  exception when others then err := sqlerrm; end;
  res := res || E'\n4 unavailable period: ' || coalesce(err, 'NOT REFUSED (bug)');

  -- 5. equipment_reschedule_clashes (0055): the unit is held by event 1 on day 0 and event 2 on day 2.
  delete from equipment_unavailability where equipment_id = u1;  -- test cleanup only
  delete from equipment_booking where equipment_id = u1;
  insert into equipment_booking (equipment_id, event_id, request_item_id, window_start_ms, window_end_ms)
    values (u1, ev1, i1, t0, t0 + day), (u1, ev2, i2, t0 + 2 * day, t0 + 3 * day);
  select coalesce(string_agg(kind, ','), 'none') into kinds from equipment_reschedule_clashes(ev1);
  res := res || E'\n5 different days, clashes for event 1: ' || kinds || ' (expect none)';

  -- 5b. Event 1 is rescheduled onto event 2's day: that booking now clashes.
  update equipment_booking set window_start_ms = t0 + 2 * day, window_end_ms = t0 + 3 * day
    where event_id = ev1 and equipment_id = u1;
  select coalesce(string_agg(kind, ','), 'none') into kinds from equipment_reschedule_clashes(ev1);
  res := res || E'\n5b rescheduled onto the other event\'s day: ' || kinds || ' (expect booking)';

  -- 5c. Adjacent windows (one ends as the other starts) don't clash.
  update equipment_booking set window_start_ms = t0 + 3 * day, window_end_ms = t0 + 4 * day
    where event_id = ev1 and equipment_id = u1;
  select coalesce(string_agg(kind, ','), 'none') into kinds from equipment_reschedule_clashes(ev1);
  res := res || E'\n5c back-to-back windows: ' || kinds || ' (expect none)';

  -- 5d. Rescheduled into an out-of-use period: reported as unavailable.
  insert into equipment_unavailability (equipment_id, reason, start_date, end_date)
    values (u1, 'Under Maintenance', (to_timestamp((t0 + 3 * day) / 1000.0) at time zone 'UTC')::date, null);
  select coalesce(string_agg(kind, ','), 'none') into kinds from equipment_reschedule_clashes(ev1);
  res := res || E'\n5d inside an out-of-use period: ' || kinds || ' (expect unavailable)';

  -- 5e. Released bookings and the other event are not reported.
  update equipment_booking set status = 'Released', released_at = now(), release_reason = 'test'
    where event_id = ev1 and equipment_id = u1;
  select coalesce(string_agg(kind, ','), 'none') into kinds from equipment_reschedule_clashes(ev1);
  res := res || E'\n5e after releasing event 1: ' || kinds || ' (expect none)';

  raise exception 'RESULTS%', res;
end
$$;
