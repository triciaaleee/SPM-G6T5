-- E1-4.2: Coordinator approves/rejects/requests clarification on a request.
--
-- review_outcome (0001) already holds the free-text note ("Rejected —
-- venue unavailable after 10pm"), so it's reused here as the decision
-- reason/clarification message. decided_at/decided_by are new: created_at
-- is submission time, not decision time, and the Organiser needs to see
-- when (and by whom) a decision was made (AC4).
--
-- Status values this feature introduces, alongside the existing
-- "Requested" (E2-1): "Planning", "Rejected", "Clarification Requested".
-- Capitalized to match "Requested", the one other status value the app
-- itself writes — seed.sql's older lowercase 'approved'/'submitted'/
-- 'rejected' values have been migrated onto this scheme too.
--
-- Guarded so this is safe to re-run.

alter table events add column if not exists decided_at timestamptz;
alter table events add column if not exists decided_by text references users (id);
