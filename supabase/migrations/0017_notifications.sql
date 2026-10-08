-- E7-1 (first slice): in-app notifications, owned by notification-service.
-- Other services create notifications through its REST API; they never
-- write this table directly. The first trigger is E4-3: a coordinator is
-- told when a venue they had an Approved booking at is blocked out.
--
-- recipient_id is a users.id (text, e.g. "COORD-0001"). It deliberately
-- has no foreign key: users belong to user-service, and this service only
-- stores the id it was handed.
--
-- read_at is null until the recipient opens their notification list.
--
-- Guarded so this is safe to re-run.

create table if not exists notifications (
  id bigserial primary key,
  recipient_id text not null,
  type text not null,
  title text not null,
  body text not null,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_recipient_created_idx
  on notifications (recipient_id, created_at desc);

-- RLS on with no policies: only the backend's service-role key reaches it.
alter table notifications enable row level security;
