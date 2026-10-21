-- Reserving equipment: the database now refuses overlapping dates.
--
-- 0049 made a reservation one transaction, but it could not tell whether a unit
-- was already booked for ANOTHER event on overlapping dates, because
-- equipment_booking stored no dates (they live in events-service). So two
-- coordinators picking the last unit for overlapping events at the same moment
-- could both succeed. It also did not check equipment_unavailability, so a unit
-- marked damaged for those dates between "chosen" and "reserved" still booked.
--
-- Now every booking stores the window it holds, as epoch milliseconds in the
-- same wall-clock-read-as-UTC form as the application's occupiedWindow()
-- (equipment-service lib/scheduleWindow.ts), so the two always compare equal.
-- reserve_equipment_request takes the event's window from the application,
-- locks the units, and then refuses:
--   'Unit N is already booked for overlapping dates'
--   'Unit N is unavailable during these dates'      (an equipment_unavailability period)
-- Both run after the row lock, so of two simultaneous reservations the second
-- waits, then sees the first's booking and is refused.
--
-- Bookings made before this migration have no stored window (NULL). The
-- database cannot invent one, so it skips them; the application still checks
-- them against events-service, and writes each window back as it resolves it
-- (lib/equipmentConflicts.ts), so they fill in over time. The window is also
-- refreshed there when an event is rescheduled, so a stored window can lag a
-- reschedule only until the unit is next checked.
--
-- Guarded so this is safe to re-run.

alter table equipment_booking add column if not exists window_start_ms bigint;
alter table equipment_booking add column if not exists window_end_ms bigint;

create index if not exists equipment_booking_window_idx on equipment_booking (equipment_id, window_start_ms, window_end_ms);

-- The signature changes, so the 0049 version must go or both would exist.
drop function if exists reserve_equipment_request(bigint, text, text, jsonb, jsonb);

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
