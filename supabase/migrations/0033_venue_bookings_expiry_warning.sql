-- #106 row 4b: dedupe flag for the new scheduled "hold about to expire"
-- sweep, so it warns a coordinator once per booking rather than every
-- sweep interval.

alter table venue_bookings
  add column if not exists expiry_warning_sent_at timestamptz;
