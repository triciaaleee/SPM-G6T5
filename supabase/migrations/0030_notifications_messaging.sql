-- E7-1 (#61) + ARD section 1.1: columns notification-service needs for
-- "which event" in the feed, and for the RabbitMQ consumer's dedupe (M5).
-- No FK on event_id: events belongs to events-service, same reasoning as
-- recipient_id having no FK to users.

alter table notifications
  add column if not exists event_id int4,
  add column if not exists message_id uuid;

-- One broker message can fan out to several recipients (e.g.
-- coordinator.assigned notifies both the coordinator and the organiser),
-- so several rows legitimately share a message_id — the dedupe key is the
-- pair, not message_id alone.
create unique index if not exists notifications_message_id_recipient_key
  on notifications (message_id, recipient_id)
  where message_id is not null;

create index if not exists notifications_event_id_idx
  on notifications (event_id)
  where event_id is not null;
