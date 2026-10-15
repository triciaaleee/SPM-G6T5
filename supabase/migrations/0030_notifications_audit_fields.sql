-- Audit trail for broker-delivered notifications: who caused it and when
-- it actually happened (vs. created_at, which is when the row was
-- inserted — i.e. when the consumer processed the message, which can lag
-- behind occurred_at if the consumer was busy or briefly down).
-- No FK on actor_id: same reasoning as recipient_id/event_id — notification-
-- service doesn't take a hard dependency on another service's table.
-- actor_id is text, matching recipient_id (0017: "users.id (text, e.g.
-- 'COORD-0001')") — user ids in this system are not uuids.

alter table notifications
  add column if not exists actor_id text,
  add column if not exists occurred_at timestamptz;
