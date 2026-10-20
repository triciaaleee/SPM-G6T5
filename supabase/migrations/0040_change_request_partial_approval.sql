-- E3-11: the coordinator can approve some held critical fields and reject
-- the rest in the same decision (clarified AC — previously all-or-nothing).
-- The overall change_requests.status stays 'Approved' when at least one
-- field was applied (matches the source clarification: "coordinators
-- approval is still the more important [outcome]"); this column records
-- which held fields, if any, were declined as part of that approval, so
-- the organiser/coordinator can see the split rather than a bare
-- "Approved" that implies everything went through.
--
-- A request that rejects every held field still goes through the existing
-- /reject route (status 'Rejected', unchanged) — this column is only set
-- on a partial approval.

alter table change_requests add column if not exists rejected_fields text[];
