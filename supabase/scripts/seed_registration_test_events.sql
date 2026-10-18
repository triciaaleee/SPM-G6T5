-- DEV ONLY. Seven Confirmed events for trying the registration period by
-- hand. Dates are relative to today, so the expected states hold whenever
-- you run it. Re-run to refresh the dates (it replaces its own rows first).
-- Uses the seed users ORG-0001 (organiser) and COORD-0001 (coordinator).
--
--   Event                               Expected for an attendee
--   [REG TEST] 1 not open yet           hidden (opens in 7 days)
--   [REG TEST] 2 open now               listed, OPEN
--   [REG TEST] 3 inside 5-day cutoff    listed, CLOSED (starts in 3 days)
--   [REG TEST] 4 forced open            listed, OPEN (starts in 3 days)
--   [REG TEST] 5 forced closed          listed, CLOSED
--   [REG TEST] 6 capacity of 1          listed, OPEN until one attendee registers, then FULL
--   [REG TEST] 7 no open date           hidden
--
-- Remove everything it added with the last statement in this file.

delete from events where submitted_details ->> 'name' like '[REG TEST]%';

insert into events (organiser_id, status, coordinator_id, registration_open_date, registration_override, submitted_details)
select
  'ORG-0001',
  'Confirmed',
  'COORD-0001',
  case when t.open_offset is null then null else current_date + t.open_offset end,
  t.override,
  jsonb_build_object(
    'name', t.name,
    'purpose', 'Registration period testing',
    'description', t.name || ' (dev test event)',
    'proposedDate', to_char(current_date + t.event_offset, 'YYYY-MM-DD'),
    'startTime', '18:00',
    'endTime', '21:00',
    'expectedAttendance', t.capacity,
    'venue', 'Main Hall',
    'registrationNeeded', true
  )
from (values
  ('[REG TEST] 1 not open yet',        14,    7, 'NONE',         50),
  ('[REG TEST] 2 open now',            14,    0, 'NONE',         50),
  ('[REG TEST] 3 inside 5-day cutoff',  3,   -3, 'NONE',         50),
  ('[REG TEST] 4 forced open',          3, null, 'FORCE_OPEN',   50),
  ('[REG TEST] 5 forced closed',       14,    0, 'FORCE_CLOSED', 50),
  ('[REG TEST] 6 capacity of 1',       14,    0, 'NONE',          1),
  ('[REG TEST] 7 no open date',        14, null, 'NONE',         50)
) as t(name, event_offset, open_offset, override, capacity);

-- To remove the test events (and their registrations):
-- delete from events where submitted_details ->> 'name' like '[REG TEST]%';
