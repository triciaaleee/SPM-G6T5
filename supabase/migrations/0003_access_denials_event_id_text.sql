-- Fix: malformed/garbage event IDs (e.g. /events/abc) were skipping the
-- audit log because event_id was typed uuid — a non-UUID string couldn't be
-- inserted, so the app-layer validation added alongside this migration
-- (isUuid) needs event_id to accept arbitrary attempted values, not just
-- valid UUIDs. No FK relies on this column, so widening it is safe.

alter table access_denials
  alter column event_id type text;
