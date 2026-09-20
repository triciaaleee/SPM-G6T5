-- Lets a coordinator request clarification even after an event has moved
-- to "Planning" (post-approval), not just before approval. Since the
-- status returns to "Clarification Requested" either way, we need to
-- remember what to restore it to once the organiser responds — "Requested"
-- if it was requested pre-approval, "Planning" if it was already approved.
--
-- Guarded so this is safe to re-run.

alter table events add column if not exists status_before_clarification text;
