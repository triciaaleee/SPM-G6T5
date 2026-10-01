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
--
-- E1-1 (issue #8): attendees and organisers can self-register through
-- /signup. Coordinator, venue staff and technical support are internal
-- staff roles with no signup path — they only ever exist as rows seeded
-- here (or inserted directly in production).

insert into users (id, name, email, password_hash, role) values
  ('ORG-0001', 'Organiser One', 'organiser-one@example.com', crypt('password123', gen_salt('bf')), 'organiser'),
  ('ORG-0002', 'Organiser Two', 'organiser-two@example.com', crypt('password123', gen_salt('bf')), 'organiser'),
  ('COORD-0001', 'Coordinator One', 'coordinator-one@example.com', crypt('password123', gen_salt('bf')), 'coordinator'),
  ('VEN-0001', 'Venue Staff One', 'venue-staff-one@example.com', crypt('password123', gen_salt('bf')), 'venue_staff'),
  ('TS-0001', 'Technical Support One', 'tech-support-one@example.com', crypt('password123', gen_salt('bf')), 'technical_support')
on conflict (id) do nothing;

-- The IDs above are hand-picked, so move each role's ID sequence past
-- them — otherwise the first organiser to sign up would be handed
-- ORG-0001 and collide with the row above (migration 0013).
select sync_user_id_sequences();

-- Events ----------------------------------------------------------------

-- submitted_details uses the same field names NewEventRequestView.vue's
-- form submits (name/purpose/description/proposedDate/startTime/endTime/
-- expectedAttendance/venue/accessibility/equipment/technicalSupport/
-- registrationNeeded) — matching EventRequestPayload in eventsApi.ts — so
-- the "Event details" panel in EventDetailView.vue renders these fields
-- instead of falling back to "—". Requirement fields are optional (E2-12),
-- so some rows below deliberately omit them to exercise that path.

insert into events (
  id, organiser_id, status, submitted_details, coordinator_id, review_outcome, decided_at, decided_by, created_at
) values
  -- organiser-one's events
  (
    1,
    'ORG-0001',
    'Planning',
    '{"name":"Freshman Orientation Fair","purpose":"Welcome new students to campus","description":"Booths, campus tours, and icebreaker activities for incoming freshmen.","proposedDate":"2026-09-20","startTime":"09:00","endTime":"15:00","expectedAttendance":300,"venue":"Great Lawn (rain site: Sports Hall)","accessibility":"Wheelchair-accessible pathways and a sign-language interpreter for the welcome speech.","equipment":"20 gazebo tents, PA system, 40 folding tables","technicalSupport":"AV technician for the welcome speech","registrationNeeded":true}',
    'COORD-0001',
    'Approved with minor notes on AV setup',
    now() - interval '9 days',
    'COORD-0001',
    now() - interval '10 days'
  ),
  (
    2,
    'ORG-0001',
    'Requested',
    '{"name":"Career Networking Night","purpose":"Connect students with industry recruiters","description":"An evening networking session with alumni and partner companies.","proposedDate":"2026-09-25","startTime":"18:00","endTime":"21:00","expectedAttendance":150,"venue":"Grand Ballroom, Student Centre","equipment":"Registration desk, name badge printer, 15 round tables","registrationNeeded":true}',
    null,
    null,
    null,
    null,
    now() - interval '3 days'
  ),
  (
    3,
    'ORG-0001',
    'Rejected',
    '{"name":"Late-Night Study Jam","purpose":"Provide a late-night study space during finals","description":"Extended library hours with snacks and quiet study zones.","proposedDate":"2026-09-18","startTime":"22:00","endTime":"23:59","expectedAttendance":80}',
    'COORD-0001',
    'Rejected — venue unavailable after 10pm',
    now() - interval '19 days',
    'COORD-0001',
    now() - interval '20 days'
  ),
  (
    4,
    'ORG-0001',
    'Requested',
    '{"name":"Alumni Homecoming Mixer","purpose":"Reconnect alumni with current students and staff","description":"A homecoming social with games, food, and a keynote from a notable alum.","proposedDate":"2026-10-05","startTime":"17:00","endTime":"20:00","expectedAttendance":500}',
    null,
    null,
    null,
    null,
    now() - interval '1 day'
  ),
  -- organiser-two's events (used to test cross-owner access denial)
  (
    5,
    'ORG-0002',
    'Planning',
    '{"name":"Design Club Showcase","purpose":"Exhibit student design projects","description":"An open gallery night showcasing student design portfolios and projects.","proposedDate":"2026-09-22","startTime":"14:00","endTime":"17:00","expectedAttendance":120}',
    'COORD-0001',
    'Approved',
    now() - interval '6 days',
    'COORD-0001',
    now() - interval '7 days'
  ),
  (
    6,
    'ORG-0002',
    'Requested',
    '{"name":"Robotics Demo Day","purpose":"Demonstrate student robotics projects","description":"Robotics club teams demo their builds and compete in mini-challenges.","proposedDate":"2026-09-28","startTime":"10:00","endTime":"13:00","expectedAttendance":200}',
    null,
    null,
    null,
    null,
    now() - interval '2 days'
  )
on conflict (id) do update set
  status = excluded.status,
  coordinator_id = excluded.coordinator_id,
  review_outcome = excluded.review_outcome,
  decided_at = excluded.decided_at,
  decided_by = excluded.decided_by;
-- do update (not do nothing): lets re-running this file migrate rows 1-6
-- that were already seeded under the old lowercase status values onto the
-- new ones, without touching created_at/submitted_details/organiser_id.

-- Keep the identity sequence ahead of these explicit ids so the next
-- app-created event doesn't collide with id 1-6 above.
select setval(pg_get_serial_sequence('events', 'id'), 6);

-- Venues (0011) ---------------------------------------------------------
--
-- Manual test flow for venue search:
--   1. Sign in as coordinator-one@example.com / password123.
--   2. Open event 2 (Career Networking Night, 25 Sep 18:00-21:00, 150
--      attendees) and click "Find venues" — the search opens pre-filled.
--   3. Lecture Theatre LT1 is excluded on capacity (the event's attendance
--      pre-fills Capacity's minimum).
--   4. Add Facilities: Catering kitchen + Layouts: Boardroom — no venue has
--      both, so the "no results" state appears with relax-filter options.

insert into venues (id, name, location, description, capacity, accessibility, layouts, facilities) values
  (1, 'Grand Ballroom', 'Central Campus', 'Student Centre, level 2. Chandeliered hall with a sprung dance floor.', 400,
    '{"Wheelchair access","Step-free entry","Lift access","Accessible toilets","Accessible seating","Hearing loop"}',
    '{"Theatre","Banquet","Cabaret","Reception (standing)","Open floor"}',
    '{"Projector","Screen","PA system","Microphones","Stage","Lighting rig","Wi-Fi","Air conditioning","Catering kitchen","Registration desk","Cloakroom","Green room"}'),
  (2, 'Sports Hall', 'South Campus', 'Multi-purpose indoor court, used as the wet-weather site for outdoor events.', 600,
    '{"Wheelchair access","Step-free entry","Accessible toilets","Accessible parking"}',
    '{"Theatre","Reception (standing)","Open floor"}',
    '{"PA system","Microphones","Wi-Fi","Power outlets","Parking"}'),
  (3, 'Lecture Theatre LT1', 'Central Campus', 'Tiered lecture theatre with fixed seating.', 120,
    '{"Wheelchair access","Lift access","Accessible seating","Hearing loop","Braille signage"}',
    '{"Theatre"}',
    '{"Projector","Screen","PA system","Microphones","Livestream equipment","Video conferencing","Wi-Fi","Air conditioning"}'),
  (4, 'Seminar Room 3-01', 'North Campus', 'Flexible teaching room with movable tables.', 40,
    '{"Wheelchair access","Lift access","Accessible toilets","Quiet room"}',
    '{"Classroom","Boardroom","U-shape","Hollow square"}',
    '{"Projector","Screen","Video conferencing","Wi-Fi","Power outlets","Whiteboard","Air conditioning"}'),
  (5, 'Innovation Hub', 'North Campus', 'Open-plan co-working space with breakout pods.', 180,
    '{"Wheelchair access","Step-free entry","Accessible toilets","Hearing loop","Quiet room","Service animals welcome"}',
    '{"Classroom","Cabaret","Reception (standing)","Open floor"}',
    '{"Projector","Screen","PA system","Microphones","Video conferencing","Wi-Fi","Power outlets","Whiteboard","Air conditioning","Registration desk"}'),
  (6, 'Great Lawn', 'Central Campus', 'Open lawn beside the library. Weather dependent.', 800,
    '{"Wheelchair access","Step-free entry","Ramp access","Service animals welcome"}',
    '{"Reception (standing)","Open floor"}',
    '{"PA system","Power outlets","Outdoor space"}'),
  (7, 'Boardroom A', 'Downtown Annex', 'Executive boardroom for small meetings and panels.', 20,
    '{"Wheelchair access","Lift access","Accessible toilets","Accessible parking"}',
    '{"Boardroom","Hollow square"}',
    '{"Screen","Video conferencing","Wi-Fi","Power outlets","Whiteboard","Air conditioning","Parking"}'),
  (8, 'Rooftop Terrace', 'Downtown Annex', 'Covered rooftop space with city views. Accessed by stairs only.', 150,
    '{}',
    '{"Banquet","Cabaret","Reception (standing)","Open floor"}',
    '{"PA system","Lighting rig","Catering kitchen","Outdoor space"}'),
  (9, 'Black Box Studio', 'South Campus', 'Performance studio with a lighting rig and retractable seating.', 200,
    '{"Wheelchair access","Accessible toilets","Accessible seating","Hearing loop"}',
    '{"Theatre","Open floor"}',
    '{"Projector","Screen","PA system","Microphones","Stage","Lighting rig","Livestream equipment","Green room","Air conditioning"}'),
  (10, 'Multipurpose Hall', 'North Campus', 'Mid-size hall suited to talks, workshops and dinners.', 250,
    '{"Wheelchair access","Step-free entry","Ramp access","Lift access","Accessible toilets","Accessible parking"}',
    '{"Theatre","Classroom","Banquet","Cabaret","U-shape"}',
    '{"Projector","Screen","PA system","Microphones","Stage","Wi-Fi","Power outlets","Air conditioning","Catering kitchen","Registration desk","Cloakroom","Parking"}')
-- do update (not do nothing): re-running this file refreshes the option
-- lists on venues seeded before the standard option catalogue was added.
on conflict (id) do update set
  name = excluded.name,
  location = excluded.location,
  description = excluded.description,
  capacity = excluded.capacity,
  accessibility = excluded.accessibility,
  layouts = excluded.layouts,
  facilities = excluded.facilities;

select setval(pg_get_serial_sequence('venues', 'id'), 10);

-- venue_bookings (0015): every booking must have a real event_id, so only
-- the seed events actually far enough along to have a venue locked in get
-- one — matched by attendance/theme to a suitable venue. Deleted first so
-- re-running this file doesn't stack duplicates.
--
--   Event 1  Freshman Orientation Fair (Planning, 300 attendees, venue
--            field names "Great Lawn / rain site Sports Hall") -> venue 6
--            (Great Lawn, capacity 800), status Approved since the event
--            itself is already approved.
--   Event 2  Career Networking Night (Requested, 150 attendees, venue
--            field names "Grand Ballroom") -> venue 1 (Grand Ballroom,
--            capacity 400), status Requested — a tentative hold while the
--            event itself is still pending review.
--   Event 5  Design Club Showcase (Planning, 120 attendees, no venue
--            field given) -> venue 5 (Innovation Hub, capacity 180 —
--            open-plan space fits a gallery night), status Approved.
--   Event 6  Robotics Demo Day (Requested, 200 attendees, no venue field
--            given) -> venue 10 (Multipurpose Hall, capacity 250),
--            status Requested.
--
-- Events 3 (Rejected) and 4 (Requested, no coordinator yet) have no
-- booking — neither has reached the point of a venue being locked in.
delete from venue_bookings where venue_id between 1 and 10;

insert into venue_bookings (venue_id, event_id, status) values
  (6, 1, 'Approved'),
  (1, 2, 'Requested'),
  (5, 5, 'Approved'),
  (10, 6, 'Requested');
