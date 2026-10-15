-- Corrects 0030: actor_id was declared uuid, but user ids in this system
-- are text (0017: "users.id (text, e.g. 'COORD-0001')"), matching
-- recipient_id. Every real actor_id value (e.g. "LEAD-0001") failed to
-- insert under the uuid type.

alter table notifications
  alter column actor_id type text using actor_id::text;
