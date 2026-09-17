-- E2-3: coordinator marks each clarification question resolved once the
-- Organiser's reply satisfies it. Approval (0007) stays blocked while any
-- top-level question (parent_id null) for the event has resolved = false;
-- once every question is resolved, the coordinator can approve without
-- the Organiser needing to resubmit.
--
-- Guarded so this is safe to re-run.

alter table event_clarifications add column if not exists resolved boolean not null default false;
