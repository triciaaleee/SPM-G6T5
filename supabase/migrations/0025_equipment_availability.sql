-- E5-4: Technical Support check whether enough suitable equipment is free
-- for an event's date/time before committing to it.
--
-- Fixes the rough edge migration 0021 flagged when it captured
-- `equipment`/`equipment_booking` as unused scaffolding: `equipment.status`
-- borrowed the *event* status enum (Planning, Safety Review, Cancelled,
-- ...), which says nothing about whether a piece of equipment is usable.
-- 0021 is edited in place (pre-prod) to create the real equipment_status
-- enum and use it from the start on a fresh database; this migration
-- catches up a dev database created before that edit, same as it already
-- had the old event_status-typed column.
--
-- Still no quantity column on `equipment`, by design: it stays one row per
-- physical unit (seed.sql mirrors equipment_catalog's totals this way), so
-- "available count" for a type is a row count, not a number pulled out of
-- a separate aggregate.
--
-- equipment_booking still has no status column — every row is a committed
-- reservation. That's within scope today because E5-4 only reads the
-- table; E5-6 (actually reserving equipment) is a separate story and can
-- extend this if it needs a pending/approved distinction later.
--
-- Transit time between venues is explicitly not modelled (customer
-- confirmed "none", per the issue) — unlike venue_bookings, there is no
-- setup/turnaround padding around an equipment booking's window.
--
-- Guarded so this is safe to re-run.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'equipment_status') then
    create type equipment_status as enum ('Available', 'Damaged', 'Under Maintenance');
  end if;
end
$$;

-- Widen first so any existing value (including a leftover event_status
-- string, or null) survives the swap regardless of whether it's a valid
-- equipment_status — this table has no production data, but the guard
-- costs nothing and matches how 0014 handled the same kind of enum swap.
alter table equipment alter column status type text using status::text;
update equipment set status = 'Available' where status is null or status not in ('Available', 'Damaged', 'Under Maintenance');
alter table equipment alter column status type equipment_status using status::equipment_status;
alter table equipment alter column status set default 'Available'::equipment_status;
alter table equipment alter column status set not null;

create index if not exists equipment_type_status_idx on equipment (type, status);
