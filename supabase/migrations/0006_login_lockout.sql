-- E1-2 secure login: account lockout after repeated failed logins.
--
-- Team-chosen policy (issue #9, PRD open question Q4): 5 consecutive
-- failed attempts lock the account for 15 minutes. The thresholds
-- themselves live in the backend (src/routes/auth.ts) so they can be
-- tuned without a migration; only the per-user state is stored here.
--
-- State lives in the DB rather than backend memory so a lockout survives
-- a process restart and holds across multiple backend instances.
--
-- Guarded so this is safe to re-run.

alter table users add column if not exists failed_login_attempts integer not null default 0;

-- Null means "not locked". A timestamp in the past means the lockout has
-- expired; the backend treats that as unlocked and resets the counter on
-- the next attempt, so no cleanup job is needed.
alter table users add column if not exists locked_until timestamptz;
