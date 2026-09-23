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
