-- E2-1: Submit an event request
-- 0001 only granted organisers SELECT on events; submitting a request needs
-- an INSERT policy too. Additive only — 0001's schema/policies are untouched.

create policy "organisers_insert_own_events"
  on events for insert
  with check (organiser_id = auth.uid());
