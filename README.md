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

**Action messages are retried.** `event.cancelled` and `event.rejected` (which venue and equipment services act on, and registration service for `event.cancelled`) is stored in events-service's `event_outbox` table (migration `0045`) and republished every 10 seconds until RabbitMQ confirms it, so a broker outage doesn't leave a cancelled event with its bookings still held. Apply the migration before starting events-service. Every other message is still best effort.

**Restart equipment-service and venue-service after pulling.** Each binds its queue to its routing keys when it starts, so a service that was already running keeps the old bindings. equipment-service listens for `event.cancelled`, `event.rejected` and `event.rescheduled` (without it, stored equipment booking windows stay at the old dates until the next claim); venue-service listens for `event.cancelled`, `event.rejected`, `event.rescheduled` and `event.attendance_changed` (without it, a Planning edit won't flag venue bookings that no longer fit).

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

### Running everything in Docker

Each backend service and the frontend has its own `Dockerfile`, and the root `docker-compose.yml` runs them all together with RabbitMQ:

```bash
docker compose up --build -d     # from the repo root; needs backend/.env
docker compose ps                # every backend service should show (healthy)
docker compose logs -f events-service
docker compose down              # stop everything (add -v to also wipe RabbitMQ's data)
```

- The services publish the same host ports as `npm run dev` (4001–4007), and the frontend is at `http://localhost:5173`. **Stop any local `npm run dev` first**, or the ports clash.
- Config comes from `backend/.env`. Compose overrides `RABBITMQ_URL` and every `*_SERVICE_URL` so the containers reach each other by service name (e.g. `http://events-service:4001`), so leave those as `localhost` in `.env`.
- The frontend's `VITE_*` API URLs are baked in at build time and point at `localhost:400x`, since the browser calls the services directly. To change them, pass build args (`docker compose build --build-arg VITE_EVENTS_API_URL=... frontend`) and rebuild.
- After changing code, run `docker compose up --build -d <service>` to rebuild. The images run the compiled `dist/` build, not `tsx watch`.

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
cd backend/services/equipment-service && npm test
```

`user-service` and `venue-service` also have coverage, real-database integration tests and (venue-service) mutation testing:

```bash
cd backend/services/venue-service
npm run test:coverage      # unit tests + v8 coverage report (text, coverage/index.html, lcov)
npm run test:integration   # hits the real (shared dev) Supabase project; never part of `npm test`
npm run test:mutation      # Stryker: mutates src/ and checks the unit tests notice (slow; report in reports/mutation/)
```

The integration tests seed throwaway rows under a `ZINT-` prefix and delete them in `afterAll`, so they are safe to run against the dev database. They need `backend/.env` to be filled in.

`events-service` (like `user-service` and `chat-service`) also has coverage, real-database integration and mutation testing. Run these from `backend/services/events-service`:

| Command | What it does |
|---|---|
| `npm run test:coverage` | `npm test` with v8 coverage; report in `coverage/` (text, html, lcov). Fails below 100% statements, branches, functions and lines (`src/index.ts`, which only boots the server, is excluded and covered by the CI smoke test). |
| `npm run test:integration` | Runs `src/__tests__/integration/` against the **real** Supabase project in `backend/.env`. Never part of `npm test` or CI. It creates `ZEVT-` throwaway users and events and deletes them in `afterAll` (and sweeps any a crashed run left behind). RabbitMQ is replaced by an in-memory publisher, so only Supabase is needed. |
| `npm run test:mutation` | Stryker mutation testing of the mocked unit suite; report in `reports/mutation/`. Sets `MUTATION_RUN=1`, which leaves out `routeMatrix.test.ts` (the route sweep) so each mutant runs fast. The TypeScript checker drops mutants that could never compile. A full run takes about 20 minutes; add `-- --mutate 'src/lib/**/*.ts'` for a quicker run on the pure modules, or `--mutate 'src/routes/events/review.ts:100-200'` for a line range. Run only one Stryker at a time per folder, or give a second run its own `--tempDirName`. Mutants that cannot change behaviour are marked `// Stryker disable next-line <Mutator>: <why>` in the source. |

`equipment-service` has the same three, run from `backend/services/equipment-service`:

| Command | What it does |
|---|---|
| `npm run test:coverage` | `npm test` with v8 coverage; fails below 100% statements, branches, functions and lines. `src/index.ts` (boots the server) and `*.fake.ts` are excluded. Three branches that no input can reach carry a `/* v8 ignore next -- @preserve */` with the reason beside them. |
| `npm run test:integration` | Runs `src/__tests__/integration/` against the **real** Supabase project in `backend/.env`: the catalog, unit and unavailability routes against real constraints, enums, cascades and stored functions, plus a contract test that runs the same queries on the real database and on the in-memory fake (`src/__tests__/helpers/fakeDb.ts`). Never part of `npm test`. It creates `ZINT` throwaway catalog items, units and one user, and deletes them in `afterAll`. It leaves bookings, requests and events alone, because `equipment_booking.event_id` points at events-service's table. |
| `npm run test:mutation` | Stryker mutation testing of the unit suite; report in `reports/mutation/`. A full run takes about 9 minutes. Mutants that cannot change behaviour are marked `// Stryker disable next-line <Mutator>: <why>` in the source. |

The unit suites run the real routers and the real auth middleware against `helpers/fakeDb.ts`, an in-memory Supabase stand-in that stores rows, so tests assert the resulting state rather than which methods were called. `helpers/world.ts` stubs events-service and user-service over `fetch`.

`notification-service` has the same layers. Run these from `backend/services/notification-service`:

| Command | What it does |
|---|---|
| `npm run test:coverage` | `npm test` with v8 coverage. Fails below 100% statements, branches, functions and lines (`src/index.ts` and `*.fake.ts` are excluded). |
| `npm run test:integration` | Runs `src/__tests__/integration/` against the **real** Supabase project in `backend/.env`. Never part of `npm test` or CI. Rows use `ZINT-NOTIF-` recipients and are deleted in `afterAll`. No broker or user-service is needed: role lookups are stubbed, and the boot test blanks `RABBITMQ_URL` so it never consumes from the shared queue. |
| `npm run test:mutation` | Stryker mutation testing of the mocked unit suite; report in `reports/mutation/`. Takes about 2 minutes. |

`registration-service` has the same layers. Run these from `backend/services/registration-service`:

| Command | What it does |
|---|---|
| `npm run test:coverage` | `npm test` with v8 coverage. Fails below 100% statements, branches, functions and lines (`src/index.ts` and `*.fake.ts` are excluded). |
| `npm run test:integration` | Runs `src/__tests__/integration/` against the **real** Supabase project in `backend/.env`. Never part of `npm test` or CI. It creates `ZINT-REG-` throwaway users and events and deletes them in `afterAll`. The other services are replaced at their client modules and RabbitMQ by a fake, and the boot test blanks `RABBITMQ_URL` so it never consumes from the shared queue. |
| `npm run test:mutation` | Stryker mutation testing of the mocked unit suite; report in `reports/mutation/`. Takes about 3 minutes. |

### How the tests stay deterministic

`events-service` follows these rules, so a test never depends on when or where it runs:

- **Time is injected.** Code reads the current time from `lib/clock.ts` (`clock.now()`), never `new Date()` / `Date.now()`. Every test starts with the clock pinned (`src/__tests__/setup.ts`); a test that needs another instant calls `setClockForTest("2026-11-10T10:00:00Z")`. JWT issue and expiry follow the same clock, so sign test tokens with the helper in `src/__tests__/tokens.ts` (events-service).
- **No sockets.** `supertest` is aliased to an in-process stand-in (`src/__tests__/supertestInProcess.ts`, built on `light-my-request`), so requests go straight to the Express app: no ports, no connection reuse, nothing another app on the machine can collide with.
- **No retries.** `retry: 0`: a test that passes only on a second attempt is a flaky test and should fail where it is seen.
- **Any zone, any order.** Tests run in `America/Los_Angeles` by default; set `TEST_TZ=Asia/Singapore` (or any zone) to try another, and `npx vitest run --sequence.shuffle --sequence.seed=<n>` to shuffle the order. Fixtures that a route mutates must be copied per test.

## CI

Every pull request and every push to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): secret scan, lint, type-check, tests, frontend build and the smoke test above. See [CI.md](CI.md) for what each job does, how to run the same checks locally, and the decisions behind it.

```bash
cd backend && npm run lint      # ESLint for every service
cd frontend && npm run lint     # ESLint for the Vue app
```

## Notes

- All Supabase/JWT config lives in the single `backend/.env` — don't add per-service `.env` files, both services load the shared one.
- `user-service` issues and verifies tokens; `events-service` only verifies them (same `JWT_SECRET`), so a token from one works on the other.
