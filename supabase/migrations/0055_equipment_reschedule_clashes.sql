-- Which of an event's reserved units now clash, after the event was rescheduled.
--
-- When an event moves, equipment-service rewrites the stored window on its
-- Reserved bookings (event.rescheduled). That is a plain update, and the
-- overlap checks in reserve_equipment_request only run when units are reserved,
-- so nothing noticed that the new window may overlap another event's booking
-- of the same unit, or a period the unit is out of use. This lists those, so
-- equipment-service can notify the coordinator and Technical Support (and have
-- a Confirmed event moved to Needs Review).
--
-- One row per clashing booking of the event:
--   item_id  the request item the booking belongs to
--   unit_id  the unit
--   kind     'booking'      another event's Reserved booking overlaps the window
--            'unavailable'  a period the unit is out of use (E5-5) touches the
--                           window's days
-- A booking with no stored window (made before 0050) can't be compared and is
-- left out. The unavailability test is the one reserve_equipment_request uses:
-- whole days, the last day being the one holding the window's end minus 1 ms.
--
-- Read-only and stable. Guarded (create or replace) so it is safe to re-run.

create or replace function equipment_reschedule_clashes(p_event_id bigint)
returns table (item_id bigint, unit_id bigint, kind text)
language sql
stable
as $$
  select b.request_item_id, b.equipment_id, 'booking'::text
  from equipment_booking b
  where b.event_id = p_event_id
    and b.status = 'Reserved'
    and b.window_start_ms is not null
    and b.window_end_ms is not null
    and exists (
      select 1 from equipment_booking o
      where o.equipment_id = b.equipment_id
        and o.event_id <> b.event_id
        and o.status = 'Reserved'
        and o.window_start_ms is not null
        and o.window_start_ms < b.window_end_ms
        and b.window_start_ms < o.window_end_ms
    )
  union all
  select b.request_item_id, b.equipment_id, 'unavailable'::text
  from equipment_booking b
  where b.event_id = p_event_id
    and b.status = 'Reserved'
    and b.window_start_ms is not null
    and b.window_end_ms is not null
    and exists (
      select 1 from equipment_unavailability u
      where u.equipment_id = b.equipment_id
        and u.start_date <= (to_timestamp((b.window_end_ms - 1) / 1000.0) at time zone 'UTC')::date
        and (u.end_date is null or u.end_date >= (to_timestamp(b.window_start_ms / 1000.0) at time zone 'UTC')::date)
    );
$$;
