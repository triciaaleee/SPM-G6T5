# Backend

Two Express/TypeScript microservices:

- **`services/events-service`** (port 4001) — event CRUD, scoped by role
- **`services/user-service`** (port 4002) — signup/login, JWT issuance, user records

Both share one config file and Supabase project.

## First-time setup

```bash
cd backend
npm install                              # installs concurrently
cp .env.example .env                     # fill in real values below
cd services/events-service && npm install
cd ../user-service && npm install
```

Edit `backend/.env`:

```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
JWT_SECRET=replace-with-a-long-random-string

EVENTS_SERVICE_PORT=4001
USER_SERVICE_PORT=4002
```

Apply the SQL migrations in `supabase/migrations/` (in numeric order) against your Supabase project, then `supabase/seed.sql` for test data.

## Running

Start both services together:

```bash
cd backend
npm run dev
```

Output is prefixed per service (`[events]`, `[users]`) so you can tell which one logged what. Ctrl+C stops both.

To run just one service on its own:

```bash
cd backend/services/events-service && npm run dev   # or services/user-service
```

## Verify it's up

```bash
curl http://localhost:4001/health   # events-service
curl http://localhost:4002/health   # user-service
```

Both should return `{"ok":true}`.

## Tests

```bash
cd backend/services/events-service && npm test
cd backend/services/user-service && npm test
```

## Notes

- All Supabase/JWT config lives in the single `backend/.env` — don't add per-service `.env` files, both services load the shared one.
- `user-service` issues and verifies tokens; `events-service` only verifies them (same `JWT_SECRET`), so a token from one works on the other.
