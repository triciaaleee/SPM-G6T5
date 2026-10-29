# SPM-G6T5

[![CI](https://github.com/triciaaleee/SPM-G6T5/actions/workflows/ci.yml/badge.svg)](https://github.com/triciaaleee/SPM-G6T5/actions/workflows/ci.yml)

# Backend

Express/TypeScript microservices:

- **`services/events-service`** (port 4001) — event CRUD, scoped by role
- **`services/user-service`** (port 4002) — signup/login, JWT issuance, user records
- **`services/venue-service`** (port 4003) — venue search/filters and venue recommendations for an event (reads events via events-service's API), venue staff schedule and block-out periods (E4-3)
- **`services/notification-service`** (port 4004) — in-app notifications: each user's feed, filled by consuming RabbitMQ messages from the other services (there is no REST endpoint for creating them)
- **`services/equipment-service`** (port 4005) — equipment requests (E5-1/E5-3/E5-4) and the equipment inventory. Technical Support open one event's requests with `GET /api/equipment-requests/event/:eventId` (the event's name, date, time and venue and the organiser's technical requirements only; 403 when the event has no request), and view and update stock with `GET`/`POST`/`PATCH /api/equipment-catalog`
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
# Where events-service and registration-service reach user-service (defaults to localhost:USER_SERVICE_PORT)
USER_SERVICE_URL=http://localhost:4002
# Where registration-service reaches venue-service (defaults to localhost:VENUE_SERVICE_PORT)
VENUE_SERVICE_URL=http://localhost:4003
```

Apply the SQL migrations in `supabase/migrations/` (in numeric order) against your Supabase project, then `supabase/seed.sql` for test data.

## RabbitMQ (required)

events-service, registration-service, venue-service, equipment-service and chat-service publish notifications to RabbitMQ (`connectsphere.events` topic exchange), and notification-service consumes them — this is how most in-app notifications are delivered now. **Without it running, those notifications are silently never sent** — the services don't fail, they just log that the broker isn't configured and keep going.

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
- **venue-service**: `booking.requested`, `booking.decided` (on hold/approve/reject/auto-reject), `booking.replacement_required`/`booking.unavailability_clash` (venue marked unavailable), `booking.setup_conflict` (also notifies the venue staff member, not just the affected coordinators), `venue.capacity_reduced`, `hold.expired` and `hold.expiring` — migrated off direct REST. `hold.expiring` is new: a scheduled sweep (`setInterval` in `venue-service/src/index.ts`, every 15 minutes) warns a coordinator `HOLD_EXPIRY_WARNING_HOURS` (12h, `lib/bookingStatus.ts`) before a hold lapses, deduped via `venue_bookings.expiry_warning_sent_at` (migration `0033`). It has no end-user token to forward, so it reads events-service's `venue-booking-info` with an internal token instead (see below).
- **chat-service**: `message.sent` — notifies the other party on an event's chat thread; migrated off direct REST, and the response's `notified` flag now reports whether the broker publish succeeded. Optional env: `CORS_ORIGIN` (comma-separated browser origins; unset = any) and `CHAT_SEND_LIMIT_PER_MINUTE` (per-user send cap, default 30, answered with `429` + `Retry-After`). History is paged: `GET /api/chat/:eventId/messages?limit=50&before=<id>` returns the newest page oldest-first plus `hasMore` and `nextBefore`.
- **equipment-service**: `equipment.requested` and `equipment.status_changed` — its first notification integration, migrated straight onto the broker. `equipment.requested` also fixed a boundary violation: it used to query user-service's `users` table directly to find every Technical Support Staff member; now `recipients.roles: ["technical_support"]` lets notification-service resolve that itself.

**Action messages are retried.** `event.cancelled` (which venue, equipment and registration services act on) is stored in events-service's `event_outbox` table (migration `0045`) and republished every 10 seconds until RabbitMQ confirms it, so a broker outage doesn't leave a cancelled event with its bookings still held. Apply the migration before starting events-service. Every other message is still best effort.

**Restart equipment-service and venue-service after pulling.** Each binds its queue to its routing keys when it starts, so a service that was already running keeps the old bindings. equipment-service listens for `event.cancelled` and `event.rescheduled` (without it, stored equipment booking windows stay at the old dates until the next claim); venue-service listens for `event.cancelled`, `event.rescheduled` and `event.attendance_changed` (without it, a Planning edit won't flag venue bookings that no longer fit).

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

Or check every service in one go (starts them with `npm run dev`, checks each `/health`, then stops them; stop any running services first):

```bash
cd backend && npm run smoke
```

## Tests

```bash
cd backend/services/events-service && npm test
cd backend/services/user-service && npm test
cd backend/services/venue-service && npm test
cd backend/services/notification-service && npm test
cd backend/services/registration-service && npm test
```

`user-service` and `venue-service` also have coverage, real-database integration tests and (venue-service) mutation testing:

```bash
cd backend/services/venue-service
npm run test:coverage      # unit tests + v8 coverage report (text, coverage/index.html, lcov)
npm run test:integration   # hits the real (shared dev) Supabase project; never part of `npm test`
npm run test:mutation      # Stryker: mutates src/ and checks the unit tests notice (slow; report in reports/mutation/)
```

The integration tests seed throwaway rows under a `ZINT-` prefix and delete them in `afterAll`, so they are safe to run against the dev database. They need `backend/.env` to be filled in.

## CI

Every pull request and every push to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): secret scan, lint, type-check, tests, frontend build and the smoke test above. See [CI.md](CI.md) for what each job does, how to run the same checks locally, and the decisions behind it.

```bash
cd backend && npm run lint      # ESLint for every service
cd frontend && npm run lint     # ESLint for the Vue app
```

## Notes

- All Supabase/JWT config lives in the single `backend/.env` — don't add per-service `.env` files, both services load the shared one.
- `user-service` issues and verifies tokens; `events-service` only verifies them (same `JWT_SECRET`), so a token from one works on the other.
