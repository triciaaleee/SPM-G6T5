# SPM-G6T5


# Backend

Express/TypeScript microservices:

- **`services/events-service`** (port 4001) — event CRUD, scoped by role
- **`services/user-service`** (port 4002) — signup/login, JWT issuance, user records
- **`services/venue-service`** (port 4003) — venue search/filters and venue recommendations for an event (reads events via events-service's API), venue staff schedule and block-out periods (E4-3)
- **`services/notification-service`** (port 4004) — in-app notifications: each user's feed, plus a REST endpoint other services call to notify someone (e.g. venue-service telling coordinators a booked venue was blocked out)
- **`services/registration-service`** (port 4007) — attendee registration (E6): register for / withdraw from an event, an attendee's own registrations, an event's roster (organiser/coordinator only), and the attendee-facing event view. Reads event, venue and user data through those services' REST APIs

All share one config file and Supabase project.

## First-time setup

```bash
cd backend
npm install                              # installs concurrently
cp .env.example .env                     # fill in real values below
cd services/events-service && npm install
cd ../user-service && npm install
cd ../venue-service && npm install
cd ../notification-service && npm install
cd ../registration-service && npm install
```

Edit `backend/.env`:

```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
JWT_SECRET=replace-with-a-long-random-string

EVENTS_SERVICE_PORT=4001
USER_SERVICE_PORT=4002
VENUE_SERVICE_PORT=4003
NOTIFICATION_SERVICE_PORT=4004
REGISTRATION_SERVICE_PORT=4007

# Where venue-service reaches events-service (defaults to localhost:EVENTS_SERVICE_PORT)
EVENTS_SERVICE_URL=http://localhost:4001
# Where venue-service and events-service reach notification-service (defaults to localhost:NOTIFICATION_SERVICE_PORT)
NOTIFICATION_SERVICE_URL=http://localhost:4004
# Where events-service and registration-service reach user-service (defaults to localhost:USER_SERVICE_PORT)
USER_SERVICE_URL=http://localhost:4002
# Where registration-service reaches venue-service (defaults to localhost:VENUE_SERVICE_PORT)
VENUE_SERVICE_URL=http://localhost:4003
```

Apply the SQL migrations in `supabase/migrations/` (in numeric order) against your Supabase project, then `supabase/seed.sql` for test data.

## RabbitMQ (required)

events-service, registration-service, venue-service and equipment-service publish notifications to RabbitMQ (`connectsphere.events` topic exchange), and notification-service consumes them — this is how most in-app notifications are delivered now. **Without it running, those notifications are silently never sent** — the services don't fail, they just log that the broker isn't configured and keep going.

Start it with Docker before running the backend:

```bash
docker compose up -d rabbitmq
```

(from the repo root, using the `docker-compose.yml` at the top level). The management UI is at `http://localhost:15672` (guest/guest) if you want to inspect queues or a dead-letter queue.

Add to `backend/.env` (see the full env block above):

```
RABBITMQ_URL=amqp://guest:guest@localhost:5672
INTERNAL_SERVICE_SECRET=replace-with-a-long-random-string
```

Who publishes what:

- **events-service**: `request.submitted`, `request.edited`, `coordinator.assigned`, `coordinator.reassigned`, `clarification.requested`, `clarification.answered`, `request.decided`, `safety.submitted`/`safety.decided` — migrated off direct REST calls to notification-service's API.
- **registration-service**: `registration.confirmed`/`registration.withdrawn` — its first notification integration ever, built straight onto the broker (there was no REST path to migrate off).
- **venue-service**: `booking.requested`, `booking.decided` (on hold/approve/reject/auto-reject), `booking.replacement_required`/`booking.unavailability_clash` (venue marked unavailable), `booking.setup_conflict` (also notifies the venue staff member, not just the affected coordinators), `venue.capacity_reduced`, `hold.expired` and `hold.expiring` — migrated off direct REST. `hold.expiring` is new: a scheduled sweep (`setInterval` in `venue-service/src/index.ts`, every 15 minutes) warns a coordinator `HOLD_EXPIRY_WARNING_HOURS` (12h, `lib/bookingStatus.ts`) before a hold lapses, deduped via `venue_bookings.expiry_warning_sent_at` (migration `0032`). It has no end-user token to forward, so it reads events-service's `venue-booking-info` with an internal token instead (see below).
- **equipment-service**: `equipment.requested` and `equipment.status_changed` — its first notification integration, migrated straight onto the broker. `equipment.requested` also fixed a boundary violation: it used to query user-service's `users` table directly to find every Technical Support Staff member; now `recipients.roles: ["technical_support"]` lets notification-service resolve that itself.

### Service-to-service auth

`INTERNAL_SERVICE_SECRET` signs short-lived internal tokens for calls that have no end-user bearer token to forward. Two cases today:

- notification-service resolving role-based recipients (`recipients.roles` in a broker message) via user-service.
- venue-service's expiring-hold sweep reading events-service's `GET /api/events/venue-booking-info` (via `requireAuthOrInternal` on that one route; every other events-service route is unaffected).

Separate from `JWT_SECRET` so a leaked value can't forge a user session or vice versa.

### Accounts

- **Attendees and Event Organisers** sign up themselves at `/signup` (role defaults to Attendee). Passwords need at least 8 characters with at least one letter and one number.
- **Coordinator, Event Coordinator Lead, Venue Staff and Technical Support** are internal staff roles with no signup path — insert them directly into `users`. `seed.sql` creates `coordinator-one@`, `coordinator-two@`, `coordinator-lead@`, `venue-staff-one@` and `tech-support-one@example.com` (password `password123`) alongside two organisers.
- After inserting users with hand-picked IDs, run `select sync_user_id_sequences();` so signups don't reuse those IDs (migration `0013`).

## Running

**Make sure RabbitMQ is up first** (`docker compose up -d rabbitmq`, from the repo root) — otherwise notifications silently don't get delivered. See [RabbitMQ (required)](#rabbitmq-required) above.

Start every service together:

```bash
cd backend
npm run dev
```

Output is prefixed per service (`[events]`, `[users]`, `[venues]`, `[notifications]`, `[registrations]`) so you can tell which one logged what. Ctrl+C stops them all.

To run just one service on its own:

```bash
cd backend/services/events-service && npm run dev   # or services/user-service, services/venue-service, services/notification-service, services/registration-service
```

## Verify it's up

```bash
curl http://localhost:4001/health   # events-service
curl http://localhost:4002/health   # user-service
curl http://localhost:4003/health   # venue-service
curl http://localhost:4004/health   # notification-service
curl http://localhost:4007/health   # registration-service
```

Each should return `{"ok":true}`.

## Tests

```bash
cd backend/services/events-service && npm test
cd backend/services/user-service && npm test
cd backend/services/venue-service && npm test
cd backend/services/notification-service && npm test
cd backend/services/registration-service && npm test
```

## Notes

- All Supabase/JWT config lives in the single `backend/.env` — don't add per-service `.env` files, both services load the shared one.
- `user-service` issues and verifies tokens; `events-service` only verifies them (same `JWT_SECRET`), so a token from one works on the other.
