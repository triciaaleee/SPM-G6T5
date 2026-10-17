-- E3-9: the Organiser raises a change request once an event is Confirmed,
-- instead of editing it directly (AGENTS.md section 3, "who can edit").
-- E3-8: critical fields (date/time, expected attendance, venue, equipment,
-- accessibility) are held here for the assigned coordinator to decide,
-- rather than applied immediately. Non-critical fields are applied straight
-- to events.submitted_details by events-service and never get a row here.
--
-- Deciding a held request (approve/reject, applying the values, moving the
-- event back to Planning) is E3-11 (#36) and is not implemented by this
-- migration or the route that inserts these rows — decided_by/decided_at/
-- decision_reason exist now so E3-11 needs no follow-up migration.
--
-- Guarded so this is safe to re-run.

do $$ begin
  create type change_request_status as enum ('Pending', 'Approved', 'Rejected');
exception
  when duplicate_object then null;
end $$;

create table if not exists change_requests (
  id bigserial primary key,
  event_id integer not null references events (id) on delete cascade,
  organiser_id text not null,
  status change_request_status not null default 'Pending',
  decided_by text,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz not null default now(),
  constraint decision_reason_required_on_reject
    check (status <> 'Rejected' or decision_reason is not null)
);

create table if not exists change_request_fields (
  id bigserial primary key,
  request_id bigint not null references change_requests (id) on delete cascade,
  field text not null,
  old_value text,
  new_value text,
  is_critical boolean not null
);

create index if not exists change_requests_event_id_idx on change_requests (event_id);
create index if not exists change_request_fields_request_id_idx on change_request_fields (request_id);
