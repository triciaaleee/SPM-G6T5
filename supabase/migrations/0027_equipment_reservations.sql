-- E5-6: Technical Support actually reserve equipment for an event, so it's
-- guaranteed and not double-allocated (AC1), rejected with the available
-- count shown when demand exceeds supply (AC2), re-checked and flagged when
-- the event's schedule changes (AC3), and released when the event is
-- cancelled (AC4).
--
-- Per the issue's own open question (PRD section 11): equipment is
-- requested for the event as a whole, not per venue (Change #3 only
-- confirmed an event can use several venues; nothing in the data model
-- ties an equipment request to one of them, and no AC asks for that
-- granularity) — so no venue_id is added here.
--
-- "Reserve" is folded into the existing E5-3 status workflow rather than a
-- new standalone action: marking an item Arranged or Partially Fulfilled is
-- already the real commitment point (it's what moves equipment_catalog's
-- counter), so that's also the moment specific physical units are claimed
-- via equipment_booking (migration 0025) for the event's date/time window —
-- making that claim date-aware, unlike the flat catalog counter. See
-- equipment-service's routes/equipmentRequests.ts PATCH handler and
-- lib/equipmentConflicts.ts for the per-unit claim/release logic (it has to
-- live in the application layer, not SQL, since it needs each other
-- booking's event schedule from events-service over HTTP).
--
-- Guarded so this is safe to re-run.

-- Which request item a claimed unit belongs to, so a reservation can be
-- released (or partially released, on a smaller re-fulfilment) one item at
-- a time. Nullable: the two pre-existing seeded rows (seed.sql) predate
-- this column and aren't tied to any request item.
alter table equipment_booking add column if not exists request_item_id bigint references equipment_request_items (id) on delete cascade;

create index if not exists equipment_booking_request_item_idx on equipment_booking (request_item_id);

-- AC4: cancelling an event (E3-6, #31 — not built yet) releases every
-- equipment reservation for it and returns the stock it held. Not called by
-- anything yet (there is no cancel-event endpoint in events-service to call
-- it), but ready for events-service to call the same way it already
-- forwards the caller's token to this service elsewhere (lib/eventsClient.ts,
-- lib/arrangementsClient.ts) once E3-6 ships. Exposed as
-- POST /api/equipment-requests/events/:eventId/release.
--
-- Mirrors apply_equipment_request_status (migration 0022): restores
-- available_stock by whatever each item currently holds, then zeroes
-- quantity_fulfilled — the request's own status (Requested/Arranged/
-- Partially Fulfilled) is left alone as history, same as a cancelled
-- event's record stays viewable. Runs in the caller's transaction
-- (PostgREST wraps each request in one).
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
    if item.equipment_catalog_id is not null then
      update equipment_catalog
        set available_stock = available_stock + item.quantity_fulfilled
        where id = item.equipment_catalog_id;
    end if;

    update equipment_request_items
      set quantity_fulfilled = 0
      where id = item.id;
  end loop;

  delete from equipment_booking where event_id = p_event_id;
end;
$$;
