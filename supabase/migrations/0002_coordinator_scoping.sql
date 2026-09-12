-- E1-4.1: Coordinator data scoping
-- Coordinators (role = 'coordinator' in app_metadata) can read all events.
-- The existing organisers_select_own_events policy is unaffected — organisers
-- still only see their own rows. These two policies are additive: Postgres
-- grants access if ANY matching policy passes.

create policy "coordinators_select_all_events"
  on events for select
  using (auth.jwt() -> 'app_metadata' ->> 'role' = 'coordinator');
