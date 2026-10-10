# SPM-G6T5


# Backend

Express/TypeScript microservices:

- **`services/events-service`** (port 4001) — event CRUD, scoped by role
- **`services/user-service`** (port 4002) — signup/login, JWT issuance, user records
- **`services/venue-service`** (port 4003) — venue search/filters and venue recommendations for an event (reads events via events-service's API), venue staff schedule and block-out periods (E4-3)
- **`services/notification-service`** (port 4004) — in-app notifications: each user's feed, plus a REST endpoint other services call to notify someone (e.g. venue-service telling coordinators a booked venue was blocked out)
- **`services/registration-service`** (port 4006) — attendee registration (E6): register for / withdraw from an event, an attendee's own registrations, an event's roster (organiser/coordinator only), and the attendee-facing event view. Reads event, venue and user data through those services' REST APIs

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
REGISTRATION_SERVICE_PORT=4006

# Where venue-service reaches events-service (defaults to localhost:EVENTS_SERVICE_PORT)
EVENTS_SERVICE_URL=http://localhost:4001
# Where venue-service reaches notification-service (defaults to localhost:NOTIFICATION_SERVICE_PORT)
NOTIFICATION_SERVICE_URL=http://localhost:4004
# Where registration-service reaches user-service and venue-service (default to localhost:<their port>)
USER_SERVICE_URL=http://localhost:4002
VENUE_SERVICE_URL=http://localhost:4003
```

Apply the SQL migrations in `supabase/migrations/` (in numeric order) against your Supabase project, then `supabase/seed.sql` for test data.

### Accounts

- **Attendees and Event Organisers** sign up themselves at `/signup` (role defaults to Attendee). Passwords need at least 8 characters with at least one letter and one number.
- **Coordinator, Venue Staff and Technical Support** are internal staff roles with no signup path — insert them directly into `users`. `seed.sql` creates one of each (`coordinator-one@`, `venue-staff-one@`, `tech-support-one@example.com`, password `password123`) alongside two organisers.
- After inserting users with hand-picked IDs, run `select sync_user_id_sequences();` so signups don't reuse those IDs (migration `0013`).

## Running

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
curl http://localhost:4006/health   # registration-service
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
