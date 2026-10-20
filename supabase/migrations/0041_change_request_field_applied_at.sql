-- E3-11: the coordinator can approve held critical fields one subset at a
-- time, leaving the rest open for a later decision instead of forcing an
-- all-or-nothing call. Earlier (migration 0040) this was modelled as
-- deleting an approved field's row immediately, which lost the record of
-- what had already been approved once the request's last remaining field
-- was later decided and the row deleted too — "Changes you decided" would
-- render empty. This column replaces that: an approved field's row stays,
-- stamped with when it applied, so the full history of a multi-step
-- decision survives on the request itself, not just in event_history.
--
-- rejected_fields (0040) is no longer written by the approve route — a
-- field the coordinator doesn't select is just left open, never marked
-- rejected — but the column is left in place rather than dropped, since
-- it's dormant and harmless and this project allows editing migrations
-- in place pre-deploy (AGENTS.md section 5) rather than chasing cleanup
-- migrations for an unused nullable column.

alter table change_request_fields add column if not exists applied_at timestamptz;
