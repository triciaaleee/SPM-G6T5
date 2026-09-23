# AGENTS.md

Rules for any AI agent (and human) contributing to this repo. These are **mandatory**, not suggestions. If a request conflicts with a rule here, stop and ask before proceeding.

## Repo layout

```
backend/
  package.json            # root runner: starts ALL services with one command
  .env                    # single shared env file for every service
  services/
    events-service/       # port 4001
    user-service/         # port 4002
frontend/                 # Vue 3 + Vite + Tailwind
supabase/migrations/      # numbered SQL migrations (NNNN_description.sql)
Style.md                  # frontend design system — source of truth
c4_diagrams/              # C4 model + Architecture Decision Record
```

---

## 1. Microservices architecture

Follow a microservices architecture as much as possible.

- **New entity → new microservice.** If the work introduces an entirely new domain entity (e.g. `venue`, `equipment`, `notification`), create a new service under `backend/services/<entity>-service/`. Do **not** bolt it onto an existing service.
- **One service owns its data.** A service only reads/writes its own tables. To use another entity's data, call that service's REST API — never query another service's tables directly.
- **No shared code imports between services.** Each service is self-contained (its own `package.json`, `tsconfig.json`, `src/`, tests). Duplicate small helpers (e.g. `jwt.ts`, `env.ts`) rather than importing across service folders.
- **All services share one `.env`.** Every service loads the single `backend/.env` (via `lib/env.ts` → `dotenv.config({ path: "../../.env" })`). Never create a per-service `.env`; add new variables to `backend/.env` and `backend/.env.example`.
- **Extending an existing entity** (new field, new endpoint on events, etc.) stays in the service that owns that entity.
- If you're unsure whether something is a "new entity" or part of an existing one, ask.
- Follow the c4_diagrams in the repo to determine if need new microservice. 

### New service checklist

Copy the structure of an existing service (e.g. `events-service`):

```
backend/services/<entity>-service/
  package.json            # scripts: dev (tsx watch), build, start, test (vitest run)
  tsconfig.json
  src/
    index.ts              # Express app, GET /health -> {"ok":true}
    lib/env.ts            # dotenv.config({ path: "../../.env" }) — imported FIRST in index.ts
    lib/supabaseAdmin.ts
    lib/jwt.ts            # verify-only, uses shared JWT_SECRET
    middleware/auth.ts
    routes/
    __tests__/
```

Then:

1. **Pick the next free port** (4003, 4004, …) and add `<ENTITY>_SERVICE_PORT=<port>` to `backend/.env.example`.
2. **Edit `backend/package.json`** so `npm run dev` starts the new service alongside the others (see §2).
3. Add any tables as a new numbered migration in `supabase/migrations/`.
4. Update `backend/README.md` (service list, ports, install steps, health check curl, test command).
5. Add tests under `src/__tests__/`.

---

## 2. One command starts every service

Whenever you create a service, update the `dev` script in **`backend/package.json`** so all services start with a single `npm run dev`. Add the service to the `concurrently` command, its name to `-n`, and a colour to `-c`:

```json
"dev": "concurrently -n events,users,venues -c blue,magenta,green \"npm run dev --prefix services/events-service\" \"npm run dev --prefix services/user-service\" \"npm run dev --prefix services/venue-service\""
```

The `-n` names and `-c` colours lists must stay the same length as the list of commands. Check that `cd backend && npm run dev` boots every service and each `/health` returns `{"ok":true}`.

---

## 3. Event lifecycle (strict)

The event status machine is **fixed**. Use exactly these status values (exact casing and spacing) and **only** these transitions. Do not add, rename or skip statuses (no `Submitted`, `Approved`, `Cancelled`, etc.) unless the team updates this section first.

`Draft` is allowed, but it sits **before** the process: it's the organiser's unsubmitted work. The lifecycle process itself starts at `Requested`. Once an event leaves `Draft` it can never go back.

### Statuses

| Status | Type |
|---|---|
| `Draft` | Pre-process (optional, not part of the lifecycle) |
| `Requested` | **Start** of the lifecycle |
| `Clarification Requested` | Intermediate |
| `Planning` | Intermediate |
| `Rejected` | **End** (terminal) |
| `Confirmed` | Intermediate |
| `Completed` | **End** (terminal) |

### Diagram

```
  (pre-process)         (lifecycle START)
 ┌─────────┐  submit   ┌───────────────┐              ┌─────────────────────────┐
 │  Draft  │ ────────▶ │   Requested   │ ◀──────────▶ │ Clarification Requested │
 └─────────┘           └───────┬───────┘              └─────────────────────────┘
  optional                     │
                   ┌───────────┴───────────┐
                   ▼                       ▼
           ┌───────────────┐       ┌───────────────┐
           │   Planning    │       │   Rejected    │  END
           └───────┬───────┘       └───────────────┘
                   │  ▲
                   │  └────────▶ Clarification Requested (returns to Planning)
                   ▼
           ┌───────────────┐
           │   Confirmed   │
           └───────┬───────┘
                   │ after event concludes
                   ▼
           ┌───────────────┐
           │   Completed   │  END
           └───────────────┘
```

### Allowed transitions (the only ones)

| From | To | Notes |
|---|---|---|
| — | `Draft` | Optional: organiser saves without submitting. |
| `Draft` | `Requested` | Organiser submits. This is where the lifecycle process starts. |
| — | `Requested` | Submitting directly (no draft) also lands here. |
| `Requested` | `Planning` | Coordinator approves the request. |
| `Requested` | `Rejected` | Coordinator rejects. Terminal. |
| `Requested` | `Clarification Requested` | Set `status_before_clarification = 'Requested'`. |
| `Clarification Requested` | `Requested` | Organiser responds (when `status_before_clarification = 'Requested'`). |
| `Planning` | `Clarification Requested` | Set `status_before_clarification = 'Planning'`. |
| `Clarification Requested` | `Planning` | Organiser responds (when `status_before_clarification = 'Planning'`). |
| `Planning` | `Confirmed` | Planning finalised. |
| `Confirmed` | `Completed` | Only **after the event has concluded** (event end date/time is in the past). Terminal. |

Rules:

- `Clarification Requested` must always return to the status it came from, tracked in `events.status_before_clarification` (migration `0010`). It can never jump straight to `Confirmed`, `Rejected` or `Completed`.
- `Draft` is outside the process: coordinators don't see or act on drafts, and a draft's only exit is `Draft → Requested`. Nothing ever moves back into `Draft`.
- `Rejected` and `Completed` are terminal. No transitions out.
- There is **no** `Planning → Rejected`, `Requested → Confirmed`, or `Confirmed → Planning`.
- Validate every transition on the **backend** against this table and return `409 Conflict` (or `400`) for an illegal one. The frontend may hide invalid actions, but the backend is the source of truth.
- Keep status strings in one constant/enum per service; don't scatter string literals.
- DB defaults, seeds and migrations must use these exact values too.

> Note: `c4_diagrams/ArchitectureDecisionRecord.md` §1.2 lists `Cancelled`. **This section overrides that.** There is no `Cancelled` status. The lifecycle above is the agreed one.

---

## 4. Frontend: follow `Style.md`

All frontend work **must** follow [`Style.md`](Style.md). Read it before creating or editing any UI.

- Read **Section 0** (process rules: column mapping, centred layout, nested grid, grid safety, sidebar margin, icons, font loading, token fidelity) first. It governs how everything else is applied.
- Use tokens **by name** from Style.md (colours, typography, spacing, radius, elevation). No hard-coded hex values, px sizes or ad-hoc Tailwind colours that aren't mapped to a token.
- Use the semantic mappings (UI state colours, text hierarchy, surface hierarchy, button hierarchy) rather than picking raw palette shades.
- If a new token or rule is needed, add it to **Style.md** first, then use it. Don't let it live only in component code.
- Status badges/trackers for events must use the exact status names from §3.

---

## 5. General conventions

- **Backend:** TypeScript, Express 5, ESM (`"type": "module"`), `tsx watch` for dev, `vitest` + `supertest` for tests.
- **Config:** all env lives in the single `backend/.env`. Don't create per-service `.env` files.
- **Auth:** `user-service` issues JWTs. Every other service only **verifies** them with the shared `JWT_SECRET`.
- **Database:** Supabase Postgres. Schema changes go in a new migration `supabase/migrations/NNNN_description.sql` (next number, re-runnable/guarded where possible). Never edit an already-applied migration.
- **Tests:** add or update tests for any backend route or lifecycle change. Run `npm test` in each service you touched before finishing.
- **Docs:** when you add a service, port, env var or script, update `backend/README.md` in the same change.
