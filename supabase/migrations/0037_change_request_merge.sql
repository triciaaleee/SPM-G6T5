-- E3-9: while a change request is Pending, a later submission on the same
-- event merges into it instead of piling up a second open request — same
-- field overwrites its held value, a new field is added, and reverting a
-- held field back to its original (committed) value removes it. If that
-- empties out every held field, the request auto-resolves to Approved
-- (nothing left to decide).
--
-- Two constraints enforce the invariants the merge logic depends on:

-- Pre-existing data predates the merge logic: every submission used to
-- create its own row, so an event can already have more than one Pending
-- request. Collapse that before the one-open-per-event index below can be
-- created — keep the most recently created Pending request per event and
-- auto-resolve the rest to Approved (decided_by null), the same
-- "nothing left to decide, system-resolved" treatment the app itself now
-- gives an emptied-out request. Nothing is deleted; only superseded
-- duplicates change status.
with ranked as (
  select id, event_id,
         row_number() over (partition by event_id order by created_at desc, id desc) as rn
  from change_requests
  where status = 'Pending'
)
update change_requests cr
set status = 'Approved', decided_at = now(), decided_by = null
from ranked
where cr.id = ranked.id
  and ranked.rn > 1;

-- Same reason as above: a request could already have more than one row
-- for the same field (each old submission inserted fresh rather than
-- upserting). Keep the most recent one per (request_id, field) — these
-- are just the held-value snapshot, not an audit trail (event_history is
-- that), so it's safe to drop the superseded ones outright.
delete from change_request_fields f
using (
  select id,
         row_number() over (partition by request_id, field order by id desc) as rn
  from change_request_fields
) ranked
where f.id = ranked.id
  and ranked.rn > 1;

-- At most one field row per request — the merge upserts on (request_id,
-- field) rather than ever inserting a duplicate.
create unique index if not exists change_request_fields_request_field_idx
  on change_request_fields (request_id, field);

-- At most one *open* request per event. The route already checks for an
-- existing Pending request before deciding whether to reuse or create one,
-- but that read-then-write has a race window across two concurrent
-- submissions; this is the DB-level backstop (mirrors the "two guards"
-- pattern in venue-service's booking decisions, AGENTS.md section 3a) so
-- two Pending rows for the same event can never coexist.
create unique index if not exists change_requests_one_open_per_event_idx
  on change_requests (event_id)
  where status = 'Pending';
