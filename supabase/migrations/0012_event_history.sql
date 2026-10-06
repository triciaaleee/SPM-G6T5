-- E2-7 AC3: structured edit-history audit trail. One row per changed
-- field (not one row per edit action), so it's directly queryable/sortable
-- as "field, old value, new value, timestamp, author" per the AC's
-- literal wording — distinct from event_clarifications, which is a Q&A
-- thread, not a field-level audit log.
--
-- Guarded so this is safe to re-run.

create table if not exists event_history (
  id bigserial primary key,
  event_id integer not null references events (id),
  field text not null,
  old_value text,
  new_value text,
  changed_by text not null references users (id),
  changed_at timestamptz not null default now()
);

create index if not exists event_history_event_id_idx on event_history (event_id);

-- Week 7 change 6 (E3-12/13/14): every Operational Safety Check outcome the
-- Safety Officer records. A reason is required unless the outcome is
-- 'Approved'. The event's status change itself is driven by events.status.
create table if not exists event_safety_reviews (
  id bigserial primary key,
  event_id integer not null references events (id),
  officer_id text not null references users (id),
  outcome text not null check (outcome in ('Approved', 'Rejected', 'Changes Requested')),
  reason text,
  created_at timestamptz not null default now(),
  check (outcome = 'Approved' or (reason is not null and length(trim(reason)) > 0))
);

create index if not exists event_safety_reviews_event_id_idx on event_safety_reviews (event_id);

alter table event_safety_reviews enable row level security;
