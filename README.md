# SPM-G6T5


# Backend

Three Express/TypeScript microservices:

- **`services/events-service`** (port 4001) — event CRUD, scoped by role
- **`services/user-service`** (port 4002) — signup/login, JWT issuance, user records
- **`services/venue-service`** (port 4003) — venue search/filters and venue recommendations for an event (reads events via events-service's API)

All share one config file and Supabase project.

## First-time setup

```bash
cd backend
npm install                              # installs concurrently
cp .env.example .env                     # fill in real values below
cd services/events-service && npm install
cd ../user-service && npm install
cd ../venue-service && npm install
```

Edit `backend/.env`:

```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
JWT_SECRET=replace-with-a-long-random-string

EVENTS_SERVICE_PORT=4001
USER_SERVICE_PORT=4002
VENUE_SERVICE_PORT=4003

# Where venue-service reaches events-service (defaults to localhost:EVENTS_SERVICE_PORT)
EVENTS_SERVICE_URL=http://localhost:4001
```

Apply the SQL migrations in `supabase/migrations/` (in numeric order) against your Supabase project, then `supabase/seed.sql` for test data.

## Running

Start every service together:

```bash
cd backend
npm run dev
```

Output is prefixed per service (`[events]`, `[users]`, `[venues]`) so you can tell which one logged what. Ctrl+C stops them all.

To run just one service on its own:

```bash
cd backend/services/events-service && npm run dev   # or services/user-service, services/venue-service
```

## Verify it's up

```bash
curl http://localhost:4001/health   # events-service
curl http://localhost:4002/health   # user-service
curl http://localhost:4003/health   # venue-service
```

Each should return `{"ok":true}`.

## Tests

```bash
cd backend/services/events-service && npm test
cd backend/services/user-service && npm test
cd backend/services/venue-service && npm test
```

## Notes

- All Supabase/JWT config lives in the single `backend/.env` — don't add per-service `.env` files, both services load the shared one.
- `user-service` issues and verifies tokens; `events-service` only verifies them (same `JWT_SECRET`), so a token from one works on the other.
