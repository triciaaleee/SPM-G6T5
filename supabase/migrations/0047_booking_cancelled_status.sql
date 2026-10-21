-- "Cancelled": a venue booking the system cancelled because its venue became
-- unavailable (Venue Staff added a block-out period over an Approved booking,
-- Week 7 change 2). Owned by venue-service. See AGENTS.md section 3a.
--
-- Not the same as the other end states: Rejected is Venue Staff refusing a
-- request, Withdrawn is the coordinator giving a booking up, Expired is a hold
-- that lapsed. Cancelled is nobody's choice, so decided_by stays null and
-- decision_reason holds why (the venue and the block-out reason). The event is
-- not cancelled; its coordinator searches for a replacement venue.
--
-- Guarded so this is safe to re-run.

alter type venue_booking_status add value if not exists 'Cancelled';
