-- E4-10: Venue Staff place a booking request on hold, approve it, or
-- reject it with a reason.
--
-- Rejecting requires a reason (E4-10 AC4) and the coordinator sees it on
-- the event's venue requests panel, so the decision is recorded on the
-- booking itself rather than in a separate log. decided_by is null when
-- the system made the decision: a booking auto-rejected because another
-- one reached "On Hold"/"Approved" first (§3a, E4-11), or a hold that
-- lapsed into "Expired" (E4-12).
--
-- venues.staff_id is who looks after that venue (E4-10 AC7: "I am not
-- Venue Staff for that venue" must block the action). Before this, the
-- venue_staff role granted every venue. A column rather than a join table,
-- so a venue has at most one assigned staff member; a venue with no
-- staff_id has nobody who can decide on its bookings. There is deliberately
-- no UI for maintaining it yet — it is set in Supabase Studio until an
-- admin flow exists — so the seed below gives every venue to the
-- longest-standing member of venue staff rather than leaving the queue
-- empty for everyone.
--
-- Guarded so this is safe to re-run.

alter table venue_bookings add column if not exists decision_reason text;
alter table venue_bookings add column if not exists decided_by text references users (id);
alter table venue_bookings add column if not exists decided_at timestamptz;

-- A rejection without a reason is the one state AC4 forbids. Backfill any
-- row that predates the column before the constraint goes on.
update venue_bookings
set decision_reason = 'Reason not recorded'
where status = 'Rejected' and (decision_reason is null or btrim(decision_reason) = '');

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'venue_bookings_rejection_reason_check'
  ) then
    alter table venue_bookings add constraint venue_bookings_rejection_reason_check
      check (status <> 'Rejected' or btrim(coalesce(decision_reason, '')) <> '');
  end if;
end
$$;

-- The pending queue (AC6) filters by status across every assigned venue.
create index if not exists venue_bookings_status_idx on venue_bookings (status);

alter table venues add column if not exists staff_id text references users (id);

create index if not exists venues_staff_idx on venues (staff_id);

-- Seed: every unassigned venue goes to the first venue_staff account, so
-- the decision queue works out of the box. Reassign per venue afterwards.
update venues
set staff_id = (select id from users where role = 'venue_staff' order by id limit 1)
where staff_id is null;
