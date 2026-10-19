-- E6-4: a registration whose event the organiser cancelled (E3-6) is now
-- 'Cancelled', not 'Withdrawn'. 'Withdrawn' means only that the attendee
-- gave up their own place; 'Cancelled' means the whole event was called off.
-- registration-service's event.cancelled handler writes it.
--
-- `add value if not exists` makes this safe to re-run.

alter type registration_status add value if not exists 'Cancelled';
