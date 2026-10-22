-- When an event is cancelled, its equipment requests are cancelled too.
--
-- release_equipment_for_event (E3-6, run when equipment-service receives
-- event.cancelled) freed the event's units and zeroed each item's
-- quantity_fulfilled, but left the request's status alone. Technical Support
-- then still saw the cancelled event's request in their queue, as "Arranged"
-- or "Partially Fulfilled" with every item "Not arranged", or as "Requested" and
-- waiting for them to act on it.
--
-- It now also sets every request of the event that is not already Cancelled to
-- 'Cancelled' and clears its outstanding note. A Cancelled request is already
-- out of Technical Support's queue (E5-2) and shows greyed out to the
-- coordinator, with its items kept as history. The bookings are released as
-- before, with the reason 'Event cancelled' (0052).
--
-- Safe to run twice: a second run finds nothing left to cancel or release.
-- Guarded (create or replace) so this is safe to re-run.

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

  update equipment_booking set status = 'Released', released_at = now(), release_reason = 'Event cancelled'
    where event_id = p_event_id and status = 'Reserved';

  update equipment_requests
    set status = 'Cancelled', fulfillment_note = null
    where event_id = p_event_id and status <> 'Cancelled';
end;
$$;
