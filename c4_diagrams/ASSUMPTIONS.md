# C4 architecture — assumptions and open decisions

Companion to `c1-system-context.dsl`, `c2-containers.dsl` and `c3-components.dsl`.

Every claim below is traced either to a GitHub issue or to code in this repo. Where neither settles the question, it is recorded as an assumption with the alternative spelled out, so the team can overturn it without re-deriving the reasoning.

---

## 1. Scope of the model

These diagrams describe the **target** architecture for the full E1–E7 backlog, not the state of the code today. Elements that exist are tagged `Existing` in the DSL and render green; everything else is tagged `Planned` and renders with a dashed border.

What exists today:

| Element | Where |
|---|---|
| Web application | `frontend/` — Vue 3, Vite, Tailwind, 4 views |
| Event request service | `backend/services/events-service/` — 3 routes plus `/health` |
| Database | `supabase/migrations/` — `events` and `access_denials` only |
| Supabase Auth | external, already in use for sign-in and token verification |

Everything else in C2 — the gateway, six of the seven services, and the broker — is design, not code.

---

## 2. Decisions taken (team-confirmed)

These were chosen deliberately and are not open questions.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Seven backend services, one per epic** | Every one of the 60 stories traces to exactly one container, so the `epic-eN` labels double as ownership boundaries. |
| D2 | **One Supabase Postgres, one schema per service** | Preserves row level security as the cross-cutting authorisation control, which the existing code depends on, while still expressing ownership. A true database-per-service split would force every service to re-implement scoping in application code. |
| D3 | **API gateway in front** | `frontend/src/lib/eventsApi.ts` currently targets a single `VITE_EVENTS_API_URL`. That does not scale to seven services without either a gateway or seven base URLs in the SPA. |
| D4 | **RabbitMQ topic exchange `connectsphere.events`** | E7-2 defines 18 triggers fired from every other epic. Without async delivery, all six services acquire a synchronous dependency on the notification service. |
| D5 | **Synchronous REST for live reads** | Used only where eventual consistency is unacceptable: the E3-4 confirmation gate, E3-10 impact assessment, and E6-1/E6-7 capacity checks. |

---

## 3. Assumptions

### A1 — The `events` aggregate belongs to the event lifecycle service — **OPEN, please confirm**

**Assumed:** `event-request-service` owns intake artefacts only (submitted request payloads, drafts, clarification threads, coordinator assignment). On approval it hands off via REST, and `event-lifecycle-service` creates the event in `Planning` and owns `status` from that point forward.

**Why:** E3-3 requires one status machine over the full set `Draft, Requested, Planning, Confirmed, Completed, Rejected, Cancelled`. Putting it in a single service is the stronger architectural position and avoids two services writing the same `status` column.

**Cost:** `POST /api/events` in `backend/services/events-service/src/routes/events.ts` writes the `events` table directly today. Under this split it becomes a handoff call, which is real refactoring work.

**Alternative:** `event-request-service` owns `events` through `Requested` and `Rejected`; lifecycle takes over after approval. Zero refactoring, and the seam falls naturally at the approval boundary — but the status machine is then split across two services, which is harder to defend against E3-3.

This is the one assumption most likely to be wrong. Decide it before writing any E3 code.

### A2 — Role resolution happens once, at the gateway

**Assumed:** The gateway calls `identity-service`, resolves the roles of the caller, and injects them into the forwarded request.

**Why:** E1-4 through E1-7 are all role-scoping stories, so every service needs the caller role. Resolving per service would give all seven a synchronous dependency on identity and would dominate the C2 diagram with arrows that carry no domain meaning.

**Note:** no role exists anywhere in the schema today. There is no `profiles` table and no role column — `supabase/migrations/0001_events_organiser_scoping.sql` scopes purely on `organiser_id = auth.uid()`. E1-1 requires new accounts to default to the Attendee role, so this is net-new work.

### A3 — The gateway validates the JWT, but each service still builds a user-scoped client

**Assumed:** The gateway verifies the token once, then forwards the original token. Each service constructs its own short-lived Supabase client from that token, exactly as `backend/services/events-service/src/lib/supabase.ts` does now. No component anywhere holds a service-role key.

**Why:** This is the security model the existing code already commits to. `routes/events.ts` states plainly that its own `organiser_id` filter is "defense-in-depth, not the primary control" — the primary control is the `organisers_select_own_events` RLS policy. Introducing a gateway must not weaken that.

### A4 — The identity service wraps Supabase Auth rather than replacing it

**Assumed:** Supabase issues and verifies tokens. `identity-service` owns only what Supabase cannot do natively: the E1-2 lockout (5 attempts, 15-minute lock), the role directory, and the active-coordinator roster that E2-6 round-robin assignment reads.

**Why:** Supabase Auth has no configurable per-account lockout matching E1-2, and no concept of an "active coordinator".

### A5 — Single-session events only

**Assumed:** Every booking and reservation is one period against one venue.

**Why:** This is open question Q1, raised on issues #44, #47 and #53, where it is flagged as *priority to resolve — changes the data model*. The working assumption stated on those issues is single-session.

**Cost if wrong:** The venue and equipment schemas change shape, and the venue component view needs a session-level component between event and booking. This is the highest-impact unresolved question in the backlog.

### A6 — Coordinator reassignment (E2-12) is in the model

**Assumed:** Included, implemented by the `Coordinator picker` component in the event request service.

**Why:** Issue #67 records a direct conflict — the customer confirmed reassignment is out of scope (PRD section 10), but Week 4 Project Instructions Area 5 lists it as core functionality. Including it covers the graded requirement and is cheap to remove.

### A7 — Round-robin coordinator assignment

**Assumed:** Round-robin across active coordinators, no capacity model.

**Why:** Open question Q5 on issue #20. The customer confirmed assignment is automatic and capped at one coordinator per event but did not specify an algorithm. Round-robin is the team choice already recorded on that issue.

### A8 — Notification delivery is in-app only

**Assumed:** No email or SMS provider appears anywhere in C1 or C2.

**Why:** E7-1 states delivery is in-app only and the channel is the choice of the team. Issue #63 confirms no integration with external tools.

### A9 — Component views exist for three services only

`identity`, `equipment`, `registration` and `notification` appear as containers with no component breakdown. This was a deliberate scoping choice; the three services modelled at C3 carry the most domain logic. Add the others when their stories reach a sprint.

---

## 4. Defects and inconsistencies found in the existing code

These are **not** assumptions. They are real problems in the repo that the architecture makes visible, and each will bite during implementation. None has been fixed as part of this work.

### 4.1 Status vocabulary is inconsistent three ways

E3-3 defines the canonical set as `Draft, Requested, Planning, Confirmed, Completed, Rejected, Cancelled`. Nothing in the repo matches it:

| Location | Value used |
|---|---|
| `supabase/migrations/0001_events_organiser_scoping.sql` | column default `'submitted'` |
| `backend/services/events-service/src/routes/events.ts` | inserts `'Requested'` |
| `supabase/seed.sql` | `'approved'`, `'submitted'`, `'rejected'` |
| E3-3 acceptance criteria | `Requested`, `Planning`, `Confirmed`, … |

Fix this before building the status machine, or the machine will be written against three vocabularies at once.

### 4.2 `submitted_details` is opaque `jsonb`

`events.submitted_details` holds name, purpose, description, date, times and attendance as an unqueryable blob. But E4-7 needs `expected_attendance` for the capacity check, E4-6 needs date and time to pre-fill search, and E6-1 compares configured capacity against venue maximum. Every one of those becomes a cross-service fetch-and-parse instead of a query. Promote the fields the other services read into real columns.

### 4.3 No `UPDATE` policy on `events`

Migrations 0001 and 0002 grant `SELECT` and `INSERT` only. E2-7 (edit before approval), E3-7 (update during planning) and every status transition will fail silently under RLS until an `UPDATE` policy is added.

### 4.4 The E1-2 lockout has no home in the current stack

Five failed attempts and a 15-minute lock is not native Supabase Auth behaviour. Nothing in the repo implements it. It is assigned to `identity-service` in the model (see A4), but note that the SPA currently calls `supabase.auth.signInWithPassword` directly from `frontend/src/views/LoginView.vue`, bypassing any service that could count attempts.

### 4.5 `access_denials` rows are written by the user being audited

`GET /api/events/:id` correctly collapses 404 and 403 to avoid leaking existence, per E1-3. But it inserts the audit row through the caller own client, and policy `users_insert_own_access_denials` permits exactly that. An audit trail the audited party can write is weak. Acceptable for now; worth revisiting if audit requirements harden.

---

## 5. How to render these files

Each `.dsl` file is a self-contained workspace with no cross-file `!include`, so any one of them opens on its own.

With Structurizr Lite via Docker, from the repo root:

```bash
docker run --rm -it -p 8080:8080 -v "$PWD/c4_diagrams:/usr/local/structurizr" structurizr/lite
```

Structurizr Lite serves one workspace per directory and looks for `workspace.dsl`, so either rename the file you want to view, or point the mount at a directory containing a copy named `workspace.dsl`. Alternatively paste any file into the DSL editor at <https://structurizr.com/dsl>.
