# CI pipeline

Continuous integration for SPM-G6T5. Workflow file: [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

**Scope: CI only.** The pipeline checks the code; it does not deploy anything. Deployment (CD) is deliberately out of scope for now (see [Out of scope](#out-of-scope)).

---

## 1. What runs

```
                    ┌──────────────────────┐
 push to main  ───▶ │ secret-scan          │  gitleaks over the new commits
 pull request       ├──────────────────────┤
 manual run         │ backend-lint         │  ESLint over every service
                    ├──────────────────────┤
                    │ frontend             │  lint → test → build (vue-tsc + vite)
                    ├──────────────────────┤
                    │ discover-services    │  lists backend/services/*
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ backend (matrix)     │  one job per service, in parallel:
                    │  × 7 services        │  npm ci → tsc --noEmit → npm test
                    └──────────┬───────────┘
                               ▼  only if every service passed
                    ┌──────────────────────┐
                    │ smoke                │  `npm run dev` boots all services,
                    │                      │  every /health must be {"ok":true}
                    └──────────────────────┘
```

| Job | Working dir | Steps | Fails when |
|---|---|---|---|
| **Secret scan (gitleaks)** | repo root | Install gitleaks (checksum-verified) → scan the commits this push/PR adds | A commit adds something that looks like a key, token or password |
| **Discover backend services** | repo root | Lists every `backend/services/*/` with a `package.json` | — (feeds the matrix) |
| **Backend lint** | `backend/` | `npm ci` → `npm run lint` | Any ESLint **error** in any service (warnings don't fail) |
| **Backend (*service*)** | `backend/services/<service>/` | `npm ci` → `tsc --noEmit` → `npm test` | A type error or a failing test in that service |
| **Frontend** | `frontend/` | `npm ci` → `npm run lint` → `npm test` → `npm run build` | A lint error, failing test, type error (`vue-tsc`) or build error |
| **Smoke test** | `backend/` | `npm ci` for root + every service → `npm run smoke` | Any service fails to boot or its `/health` isn't exactly `{"ok":true}` within 60 s |

### When it runs

- **Every pull request** (into any branch).
- **Every push to `main`** (e.g. a merged PR).
- **Manually**: Actions tab → *CI* → *Run workflow*.

A newer push to the same PR cancels that PR's run still in progress. Runs on `main` are never cancelled.

---

## 2. Run the same checks locally

Before pushing, from the repo root:

```bash
# Backend: lint everything, then per service
cd backend && npm run lint
cd backend/services/events-service && npx tsc -p tsconfig.json --noEmit && npm test   # repeat per service

# Frontend
cd frontend && npm run lint && npm test && npm run build

# Smoke test (stop any running `npm run dev` first; uses your backend/.env)
cd backend && npm run smoke
```

The secret scan needs [gitleaks](https://github.com/gitleaks/gitleaks) installed: `gitleaks git --log-opts="origin/main..HEAD" --redact .`

---

## 3. Adding a new service

Nothing to change in the workflow. A new `backend/services/<entity>-service/` is picked up automatically by:

- the **backend matrix** (discovered from the folder), and
- the **smoke test**, which reads the port from `src/index.ts` (`process.env.<NAME>_SERVICE_PORT ?? <port>`).

The service still needs everything in the AGENTS.md §1 checklist. In particular, if it's **not added to the `dev` script** in `backend/package.json`, the smoke test fails with `FAIL <service> no response`. That's on purpose: it enforces AGENTS.md §2.

---

## 4. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **GitHub Actions**, one workflow file. | The repo is on GitHub; no extra service or account needed. Free for public repos. |
| D2 | **Backend runs as a matrix, one job per service**, generated from the folder list. | Mirrors the microservice rule that every service is self-contained (own `package.json` and lockfile). Services run in parallel, a failure points at the exact service, and new services are included automatically. |
| D3 | **`fail-fast: false`** on the matrix. | One broken service shouldn't hide whether the others pass. |
| D4 | **Type-check backend with `tsc --noEmit`**, not `npm run build`. | Same type errors, without writing `dist/`. Services run from source (`tsx`) in dev, so the emitted JS isn't needed. |
| D5 | **Frontend uses `npm run build`** (which is `vue-tsc -b && vite build`). | Type-checks `.vue` files and proves the production bundle builds. |
| D6 | **Smoke test uses the real `npm run dev`**, as a Node script (`backend/scripts/smoke.mjs`). | Tests the exact command the team uses (AGENTS.md §2), runs the same on Windows and Linux, and catches a service missing from the `dev` script. |
| D7 | **Smoke test runs only after every backend job passes.** | A smoke failure on code that already fails tests is just noise; this also saves CI minutes. |
| D8 | **Placeholder env values in CI, no real secrets.** | Unit tests mock Supabase (verified: all 727 backend tests pass with no `.env`). The services only *require* `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `JWT_SECRET` to boot; `/health` never calls Supabase. So no GitHub secret is needed, and forks' PRs can run CI safely. |
| D9 | **Secret scanning with the gitleaks CLI**, not `gitleaks-action`. | No licence key or token needed, the version is pinned and the download is checksum-verified. |
| D10 | **gitleaks scans only the commits a push/PR adds**, not full history. | Full history already contains a leaked `.env.bak` (see [K1](#7-known-issues-found-while-setting-up-ci)); scanning it would fail every run forever. Scanning new commits stops *new* leaks. |
| D11 | **`--redact`** on gitleaks. | The repo is public, so CI logs are public. A finding must never print the secret itself. |
| D12 | **ESLint, bug-catching rules only** (`@eslint/js` + `typescript-eslint` recommended, plus `eslint-plugin-vue` *essential* for the frontend). **No formatting rules, no Prettier.** | Catches real mistakes (unused code, useless assignments, Vue template errors) without reformatting the whole codebase or blocking PRs on style. |
| D13 | **One ESLint config for all backend services** (`backend/eslint.config.mjs`). | Avoids 7 identical copies. It's dev tooling, not shared runtime code, so services still never import each other (AGENTS.md §1). |
| D14 | **`no-explicit-any`: off in tests, warning in source.** | 117 of the 124 `any`s are deliberate loose types on test mocks. The 7 in `lib/` files are visible as warnings but don't block CI (see [Q4](#6-open-questions)). |
| D15 | **Names starting with `_` may be unused.** | Common convention already used in the tests (`_init`, `_venue`) for "intentionally unused". |
| D16 | **Exact versions for new tooling and actions** (`eslint@10.11.0`, `actions/checkout@v7.0.1`, gitleaks `8.30.1`, …), each at least two weeks old when chosen. | Avoids a freshly published (possibly compromised or broken) release landing in CI unannounced. Upgrades are a deliberate change. |
| D17 | **Node 22** in CI. | Matches the version the team develops on (v22.19). |
| D18 | **`permissions: contents: read`** for the workflow. | CI only reads the repo; least privilege for the `GITHUB_TOKEN`. |

---

## 5. Assumptions

| # | Assumption | If it's wrong |
|---|---|---|
| A1 | Everyone develops on **Node 22**. | Change `NODE_VERSION` in `ci.yml` to match. |
| A2 | Unit tests **never need a real database**: every test mocks Supabase. | A test that needs Supabase would fail in CI; it should mock it or move to an integration suite (not part of this pipeline). |
| A3 | Service startup **doesn't call Supabase or other services** (only an env-var check). True today: no timers or sweeps run at boot. | If a service starts doing work at boot (e.g. the §3a hold-expiry sweep on a timer), the smoke test may need a fake Supabase or that work disabled in CI. |
| A4 | Every service keeps the pattern `process.env.<NAME>_SERVICE_PORT ?? <port>` in `src/index.ts`. | The smoke test stops with a clear error naming the service. |
| A5 | Ports 4001–4007 are free on the CI runner. | Fresh GitHub runners have nothing on them, so this holds. |
| A6 | Each service's committed `package-lock.json` matches its `package.json`. | `npm ci` fails; run `npm install` in that service and commit the lockfile. |
| A7 | The repo stays under a **personal** GitHub account. | Nothing changes: the CLI-based secret scan needs no licence either way. |

---

## 6. Open questions

| # | Question | Who | Notes |
|---|---|---|---|
| Q1 | **Have the Supabase service-role key and `JWT_SECRET` from commit `9459dd4` (`backend/.env.bak`) been rotated?** | Repo owner | Public repo: if those were real values, anyone can read them from history. See K1. |
| Q2 | Turn on **branch protection** for `main` (require a PR, require CI to pass)? | Team | Settings → Branches → add rule for `main` → *Require status checks to pass* → pick the CI jobs. Without it, CI reports failures but can't block a merge. |
| Q3 | Should CI also **gate on coverage** (e.g. fail under X %)? | Team | Not added: no agreed threshold yet. Vitest supports `--coverage`. |
| Q4 | Fix the 7 `any`s in backend `lib/` files and make `no-explicit-any` an error? | Owners of equipment-service / venue-service | `equipmentConflicts.ts` (5), `reservationFlags.ts` (1), `venueBookingLock.ts` (1). |
| Q5 | Add **Prettier / formatting checks** later? | Team | Left out on purpose (D12): it would reformat most files in one go and cause merge conflicts on open branches. Best done in one agreed PR when few branches are open. |
| Q6 | Add **Dependabot** to keep npm packages and the pinned actions up to date? | Team | Would open PRs that CI then checks. |
| Q7 | Should the frontend get **ESLint stricter Vue rules** (`flat/recommended` instead of `flat/essential`)? | Frontend owners | `recommended` adds many style-ish rules; start with `essential`. |
| Q8 | Add a **migration check** (e.g. `supabase/migrations/` numbering, or applying migrations to a throwaway Postgres)? | Team | Decided against for now. |

---

## 7. Known issues found while setting up CI

| # | Issue | Status |
|---|---|---|
| K1 | **Secrets in git history.** `backend/.env.bak` (with `SUPABASE_SERVICE_ROLE_KEY` and `JWT_SECRET`) was committed in `9459dd4` and deleted in `32f3ff8`, but stays in the public history. | **Open, see Q1.** `.gitignore` now ignores every `.env.*` except `.env.example`, and the secret scan blocks new leaks. Rotating the keys is the real fix; rewriting history doesn't help once a repo is public. |
| K2 | Frontend `npm run build` failed on 5 type errors (4 unused symbols + `vite.config.ts` importing `defineConfig` from `vite` instead of `vitest/config`). | Fixed in `cc7eeef`. |
| K3 | `user-service` depended on `"backend": "file:../.."` (unused; a symlink back to its own parent folder). | Removed in `cc7eeef`. |
| K4 | Venue search's **"Try relaxing one filter"** suggestions were removed from the page in `8083f46` (the API still returns them). Its handler `relaxFilter` was then dead code and removed for the lint. | **Open:** confirm with the venue search owner whether E4-6 still needs it. If so, restore the template block from `3e8933a`. |
| K5 | `frontend/src/views/EventsListView.vue` logs `console.log(events)` on every load. | **Open:** leftover debug output; not a lint error under the current rules. |
| K6 | Root `README.md` doesn't mention `equipment-service` (4005) or `chat-service` (4006) in its setup, health-check and test lists. | **Open:** docs only. |

---

## 8. Out of scope

- **Deployment / CD.** Nothing is built into an image, published or deployed. To be designed separately.
- Integration or end-to-end tests against a real database or browser.
- Performance or load testing.

---

## 9. Maintenance

- **Bump a pinned version:** edit it in `ci.yml` (`actions/checkout@vX.Y.Z`, `actions/setup-node@vX.Y.Z`, `GITLEAKS_VERSION`) or `package.json` (ESLint packages), preferring a release that's been out for at least two weeks. Open a PR so CI checks the change.
- **A false positive from gitleaks:** add `# gitleaks:allow` at the end of that line (as done for the CI placeholders), or add its fingerprint (from the CI log) to a `.gitleaksignore` file at the repo root.
- **Smoke test too slow on a busy runner:** raise `SMOKE_TIMEOUT_MS` (default 60000) in the smoke job's `env`.
