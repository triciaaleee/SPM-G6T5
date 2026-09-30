-- venue_bookings no longer stores its own timing — a booking's date/time
-- now always comes from its linked event (events.submitted_details, via
-- events-service's GET /venue-booking-info), never duplicated here. This
-- also means every booking must have a real event: the old "external
-- hold" concept (a booking with no event, just a reason like "Floor
-- maintenance") is dropped entirely.
--
-- Captures a schema change already made live in Supabase Studio — see
-- AGENTS.md's migration rule ("schema changes go in a new migration").
--
-- Guarded so this is safe to re-run.

drop index if exists venue_bookings_venue_date_idx;
drop index if exists venue_bookings_date_idx;

alter table venue_bookings drop column if exists booking_date;
alter table venue_bookings drop column if exists start_time;
alter table venue_bookings drop column if exists end_time;
alter table venue_bookings drop column if exists reason;

-- Every booking now requires a real event; on delete cascade replaces the
-- old on delete set null, since a booking can't survive its event being
-- deleted without violating not null. Guarded: if any hold rows (no
-- event_id) are still around, delete them first — they have no event to
-- reference under the new model.
delete from venue_bookings where event_id is null;

alter table venue_bookings drop constraint if exists venue_bookings_event_id_fkey;
alter table venue_bookings alter column event_id set not null;
alter table venue_bookings add constraint venue_bookings_event_id_fkey
  foreign key (event_id) references events (id) on delete cascade;

create index if not exists venue_bookings_venue_id_idx on venue_bookings (venue_id);
