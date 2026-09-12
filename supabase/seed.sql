-- Local/dev seed data for E1-3 (Organiser data scoping) manual testing.
-- Run with `supabase db reset` (local dev stack) — this file is executed
-- automatically after migrations. DO NOT run against production; the
-- passwords below are fixed, publicly-known test credentials.
--
-- Custom auth: users are rows in public.users, not Supabase Auth. The
-- password hash below uses pgcrypto's crypt()/gen_salt('bf'), which
-- produces a standard bcrypt hash string ($2a$/$2b$ prefixed) — the same
-- format the backend's bcryptjs verifies on login, so these seed users
-- can log in normally through POST /api/auth/login.
--
-- Manual test flow:
--   1. Sign in as organiser-one@example.com / password123 in the frontend.
--   2. Confirm the events list shows only organiser-one's 4 events.
--   3. Navigate directly to /events/<one of organiser-two's event ids below>.
--   4. Confirm the app shows "Access denied" and a row appears in
--      access_denials (user_id = organiser-one's id, event_id = that id).

create extension if not exists pgcrypto;

-- Test accounts ---------------------------------------------------------

insert into users (id, name, email, password_hash, role) values
  ('ORG-0001', 'Organiser One', 'organiser-one@example.com', crypt('password123', gen_salt('bf')), 'organiser'),
  ('ORG-0002', 'Organiser Two', 'organiser-two@example.com', crypt('password123', gen_salt('bf')), 'organiser'),
  ('COORD-0001', 'Coordinator One', 'coordinator-one@example.com', crypt('password123', gen_salt('bf')), 'coordinator')
on conflict (id) do nothing;

-- Events ----------------------------------------------------------------

-- submitted_details uses the same field names NewEventRequestView.vue's
-- form submits (name/purpose/description/proposedDate/startTime/endTime/
-- expectedAttendance) — matching EventRequestPayload in eventsApi.ts — so
-- the "Event details" panel in EventDetailView.vue renders these fields
-- instead of falling back to "—".

insert into events (
  id, organiser_id, status, submitted_details, coordinator_id, review_outcome, created_at
) values
  -- organiser-one's events
  (
    1,
    'ORG-0001',
    'approved',
    '{"name":"Freshman Orientation Fair","purpose":"Welcome new students to campus","description":"Booths, campus tours, and icebreaker activities for incoming freshmen.","proposedDate":"2026-09-20","startTime":"09:00","endTime":"15:00","expectedAttendance":300}',
    'COORD-0001',
    'Approved with minor notes on AV setup',
    now() - interval '10 days'
  ),
  (
    2,
    'ORG-0001',
    'submitted',
    '{"name":"Career Networking Night","purpose":"Connect students with industry recruiters","description":"An evening networking session with alumni and partner companies.","proposedDate":"2026-09-25","startTime":"18:00","endTime":"21:00","expectedAttendance":150}',
    null,
    null,
    now() - interval '3 days'
  ),
  (
    3,
    'ORG-0001',
    'rejected',
    '{"name":"Late-Night Study Jam","purpose":"Provide a late-night study space during finals","description":"Extended library hours with snacks and quiet study zones.","proposedDate":"2026-09-18","startTime":"22:00","endTime":"23:59","expectedAttendance":80}',
    'COORD-0001',
    'Rejected — venue unavailable after 10pm',
    now() - interval '20 days'
  ),
  (
    4,
    'ORG-0001',
    'submitted',
    '{"name":"Alumni Homecoming Mixer","purpose":"Reconnect alumni with current students and staff","description":"A homecoming social with games, food, and a keynote from a notable alum.","proposedDate":"2026-10-05","startTime":"17:00","endTime":"20:00","expectedAttendance":500}',
    null,
    null,
    now() - interval '1 day'
  ),
  -- organiser-two's events (used to test cross-owner access denial)
  (
    5,
    'ORG-0002',
    'approved',
    '{"name":"Design Club Showcase","purpose":"Exhibit student design projects","description":"An open gallery night showcasing student design portfolios and projects.","proposedDate":"2026-09-22","startTime":"14:00","endTime":"17:00","expectedAttendance":120}',
    'COORD-0001',
    'Approved',
    now() - interval '7 days'
  ),
  (
    6,
    'ORG-0002',
    'submitted',
    '{"name":"Robotics Demo Day","purpose":"Demonstrate student robotics projects","description":"Robotics club teams demo their builds and compete in mini-challenges.","proposedDate":"2026-09-28","startTime":"10:00","endTime":"13:00","expectedAttendance":200}',
    null,
    null,
    now() - interval '2 days'
  )
on conflict (id) do nothing;

-- Keep the identity sequence ahead of these explicit ids so the next
-- app-created event doesn't collide with id 1-6 above.
select setval(pg_get_serial_sequence('events', 'id'), 6);
