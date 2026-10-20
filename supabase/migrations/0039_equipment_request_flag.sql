-- E3-11 AC3: when a coordinator approves a held change request whose
-- `equipment` field was touched, the event's equipment requests are
-- flagged so Technical Support knows to reassess them against the
-- organiser's updated wording — nothing about the actual reservation
-- (quantity_fulfilled, item rows) changes automatically (AGENTS.md §1:
-- "no automatic process, has to be done manually").
--
-- Flagged at the request level, not per item: Technical Support reviews
-- the whole request when reassessing, and there's no structural link
-- between the organiser's free-text equipment field and any one item row.
--
-- Guarded so this is safe to re-run.

alter table equipment_requests
  add column if not exists flagged_for_reassessment boolean not null default false,
  add column if not exists flag_reason text,
  add column if not exists flagged_at timestamptz;
