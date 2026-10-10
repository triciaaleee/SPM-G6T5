-- E3-4 / E1-10 (Week 7 change 6): the coordinator's safety notes, entered
-- when an event is submitted for the Safety Officer's Operational Safety
-- Check. Agreed on issue #29: one row per submission, so a resubmission
-- after a safety rejection or "request changes" (E3-13/E3-14) carries fresh
-- notes, and an earlier decision never carries over to it (E3-12 AC4).
--
-- The four notes are E3-4 AC5's list, each required so "blocked if empty"
-- holds per field. Where a venue has no known restrictions the coordinator
-- writes so ("None known") rather than leaving it blank.
--
-- Owned by events-service, like event_safety_reviews (0012), which now
-- records which submission each decision was made on.
--
-- Guarded so this is safe to re-run.

create table if not exists event_safety_submissions (
  id bigserial primary key,
  event_id integer not null references events (id),
  submitted_by text not null references users (id),
  equipment_placement text not null check (length(trim(equipment_placement)) > 0),
  crowd_movement      text not null check (length(trim(crowd_movement)) > 0),
  emergency_access    text not null check (length(trim(emergency_access)) > 0),
  venue_restrictions  text not null check (length(trim(venue_restrictions)) > 0),
  submitted_at timestamptz not null default now()
);

-- E1-10 reads the latest submission per event.
create index if not exists event_safety_submissions_event_id_idx
  on event_safety_submissions (event_id, submitted_at desc);

alter table event_safety_submissions enable row level security;

alter table event_safety_reviews
  add column if not exists submission_id bigint references event_safety_submissions (id);
