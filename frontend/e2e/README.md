# End-to-end tests

Real backend, real database, nothing mocked — this is the layer that
catches contract drift between services that backend unit tests and
frontend Vitest+mocked tests each can't, because each of those fakes the
other side.

## Running locally

1. Start the backend (all 7 services): `cd backend && npm run dev`
2. Start RabbitMQ: `docker compose up -d rabbitmq` (repo root) — flows that
   depend on a notification being sent need this running.
3. Make sure `frontend/.env` has every `VITE_*` var from `.env.example` —
   `cp frontend/.env.example frontend/.env` if unsure.
4. `cd frontend && npm run e2e`

This builds the frontend and serves the production build (`vite preview`),
not the dev server — the suite tests what ships.

## Conventions

- Tests live in `e2e/*.e2e.ts` — **not** `*.test.ts`, so Vitest's default
  glob never picks them up and this suite never picks up Vitest's unit
  tests.
- `support/backend.ts` creates test data through each service's real HTTP
  API — the same way a real client would — so only the one UI flow a test
  actually cares about gets driven through the browser. Never click through
  a flow just to get into the state the test under test needs.
- `support/browser.ts` has thin, intent-named helpers (`logIn`, not a Page
  Object Model class hierarchy).
- Every test creates its own data with a per-run random suffix
  (`uniqueName()` in `support/backend.ts`) — never hardcode an email,
  never assert a total/count, since the database carries other tests'
  leftover data. Assert only on what this test itself created.
- `retries: 0`, deliberately. A test that passes on its second try is a
  flaky test; a retry would hide that signal instead of surfacing it. If a
  test flakes, fix the race in its setup (usual cause: two async
  side-effects that need a specific order) rather than retrying around it.
  If you can't fully eliminate the race, say so in a comment at the test —
  a documented, known flake beats a mystery failure next time it happens.
