-- Local/dev seed data for E1-3 (Organiser data scoping) manual testing.
-- Run with `supabase db reset` (local dev stack) — this file is executed
-- automatically after migrations. DO NOT run against production; the
-- passwords below are fixed, publicly-known test credentials.
--
-- Manual test flow:
--   1. Sign in as organiser-one@example.com / password123 in the frontend.
--   2. Confirm the events list shows only organiser-one's 4 events.
--   3. Navigate directly to /events/<one of organiser-two's event ids below>.
--   4. Confirm the app shows "Access denied" and a row appears in
--      access_denials (user_id = organiser-one's id, event_id = that id).

-- Test organisers -----------------------------------------------------

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data
) values
  (
    '11111111-1111-1111-1111-111111111111',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'organiser-one@example.com',
    crypt('password123', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"name":"Organiser One"}'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'organiser-two@example.com',
    crypt('password123', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"name":"Organiser Two"}'
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'coordinator-one@example.com',
    crypt('password123', gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"name":"Coordinator One"}'
  )
on conflict (id) do nothing;

-- Events ----------------------------------------------------------------

insert into events (
  id, organiser_id, status, submitted_details, coordinator_id, review_outcome, created_at
) values
  -- organiser-one's events
  (
    'aaaaaaaa-0000-0000-0000-000000000001',
    '11111111-1111-1111-1111-111111111111',
    'approved',
    '{"title":"Freshman Orientation Fair","venue":"Hall A","expected_attendees":300}',
    '33333333-3333-3333-3333-333333333333',
    'Approved with minor notes on AV setup',
    now() - interval '10 days'
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000002',
    '11111111-1111-1111-1111-111111111111',
    'submitted',
    '{"title":"Career Networking Night","venue":"Auditorium","expected_attendees":150}',
    null,
    null,
    now() - interval '3 days'
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000003',
    '11111111-1111-1111-1111-111111111111',
    'rejected',
    '{"title":"Late-Night Study Jam","venue":"Library Rooftop","expected_attendees":80}',
    '33333333-3333-3333-3333-333333333333',
    'Rejected — venue unavailable after 10pm',
    now() - interval '20 days'
  ),
  (
    'aaaaaaaa-0000-0000-0000-000000000004',
    '11111111-1111-1111-1111-111111111111',
    'submitted',
    '{"title":"Alumni Homecoming Mixer","venue":"Sports Hall","expected_attendees":500}',
    null,
    null,
    now() - interval '1 day'
  ),
  -- organiser-two's events (used to test cross-owner access denial)
  (
    'bbbbbbbb-0000-0000-0000-000000000001',
    '22222222-2222-2222-2222-222222222222',
    'approved',
    '{"title":"Design Club Showcase","venue":"Gallery Room","expected_attendees":120}',
    '33333333-3333-3333-3333-333333333333',
    'Approved',
    now() - interval '7 days'
  ),
  (
    'bbbbbbbb-0000-0000-0000-000000000002',
    '22222222-2222-2222-2222-222222222222',
    'submitted',
    '{"title":"Robotics Demo Day","venue":"Engineering Atrium","expected_attendees":200}',
    null,
    null,
    now() - interval '2 days'
  )
on conflict (id) do nothing;
