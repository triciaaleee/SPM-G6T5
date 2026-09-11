# Architecture Decision Record: ConnectSphere C4 model

**Version 1.0** | 2026-09-11 | Tricia Lee (@triciaa-leee)

Records the significant decisions behind `c1-system-context.dsl`, `c2-containers.dsl` and `c3-components.dsl`. Scope is levels C1 to C3 of the C4 model, derived from the E1 to E7 issue backlog and the code currently in the repo.

## Changelog

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-09-11 | Tricia Lee | Initial record. Nine decisions and eight assumptions covering C1 to C3. |

---

## 1. Open for discussion

Each item below needs a group decision, or customer clarification, before the related code is written. Ordered by how much rework it causes if settled late.

### 1.1 Who owns the `events` aggregate (blocks all E3 work)

D2 splits E2 and E3 into separate services, but both act on the same event row. Two options:

| Option | Ownership | Trade-off |
|---|---|---|
| A (currently modelled) | Lifecycle service owns `events` and `status`. Request service owns intake artefacts only and hands over on approval. | One status machine in one service, satisfying E3-3. Costs real refactoring of `backend/services/events-service/src/routes/events.ts`, which writes `events` directly today. |
| B | Request service owns `events` through `Requested` and `Rejected`. Lifecycle takes over after approval. | Zero refactoring, seam falls naturally at approval. Splits the status machine across two services, which is harder to defend against E3-3. |

Settle this before writing any E3 code. Moving a table between services later is expensive.

### 1.2 Status vocabulary is inconsistent in three places

E3-3 defines the canonical set as `Draft, Requested, Planning, Confirmed, Completed, Rejected, Cancelled`. Nothing in the repo matches:

| Location | Value |
|---|---|
| `supabase/migrations/0001_events_organiser_scoping.sql` | column default `'submitted'` |
| `backend/services/events-service/src/routes/events.ts` | inserts `'Requested'` |
| `supabase/seed.sql` | `'approved'`, `'submitted'`, `'rejected'` |

Needs a migration and a seed fix. Agree the canonical set first, or the status machine gets written against three vocabularies.

### 1.3 `submitted_details` is an opaque `jsonb` blob

Name, purpose, date, times and attendance are unqueryable. E4-7 needs `expected_attendance` for the capacity check, E4-6 needs date and time to pre-fill search, and E6-1 compares configured capacity against venue maximum. Each becomes a fetch and parse rather than a query. Decide which fields to promote to real columns.

### 1.4 No `UPDATE` policy on `events`

Migrations 0001 and 0002 grant `SELECT` and `INSERT` only. E2-7, E3-7 and every status transition will fail under RLS until an `UPDATE` policy exists.

### 1.5 The E1-2 lockout has nowhere to live

Five failed attempts and a 15 minute lock is not native Supabase Auth behaviour, and nothing implements it. A1 assigns it to the identity service, but `frontend/src/views/LoginView.vue` calls `supabase.auth.signInWithPassword` directly, bypassing any service that could count attempts. Either route login through the gateway or accept that lockout cannot be enforced.

### 1.6 `access_denials` rows are written by the audited user

`GET /api/events/:id` correctly collapses 404 and 403 so existence is not leaked, per E1-3. But it inserts the audit row through the caller's own client, and policy `users_insert_own_access_denials` permits exactly that. An audit trail the audited party can write is weak. Acceptable for a course project; confirm the group agrees.

### 1.7 Which remaining services get C3 views

D9 covers three services only. Identity, equipment, registration and notification have no component breakdown. Decide when each is needed, probably as its stories enter a sprint.

---

## 2. Decisions made

| ID | Decision |
|---|---|
| D1 | Adopt a microservices architecture rather than a modular monolith |
| D2 | Seven backend services, one per epic |
| D3 | One Postgres instance, one schema per service |
| D4 | Row level security remains the primary authorisation control |
| D5 | An API gateway as the single entry point |
| D6 | RabbitMQ topic exchange for asynchronous events |
| D7 | Synchronous REST only for live cross-service reads |
| D8 | Model the target state, tag what exists today |
| D9 | Component views for three services only |

### D1. Adopt a microservices architecture

**Rationale:** the backlog already separates cleanly into seven epics with distinct roles and data. Customer clarifications have effectively drawn the boundaries.

**Consequence:** more infrastructure than the current single service, and cross-service reads that a monolith would resolve with a join.

### D2. Seven backend services, one per epic

Identity (E1), event request (E2), event lifecycle (E3), venue (E4), equipment (E5), registration (E6), notification (E7).

**Rationale:** each of the 60 stories traces to exactly one container, so the `epic-eN` labels double as ownership boundaries.

**Consequence:** E2 and E3 both act on the event row, which is unresolved. See 1.1.

### D3. One Postgres instance, one schema per service

Each service reads and writes only its own schema.

**Rationale:** preserves RLS as a cross-cutting control, which the existing code depends on. A true database per service would force every service to reimplement scoping in application code.

**Consequence:** not textbook microservice isolation. The shared instance is a single point of failure and a shared deployment dependency.

### D4. Row level security remains the primary authorisation control

The gateway validates the JWT and forwards the original token. Each service builds its own short lived Supabase client from that token, as `backend/services/events-service/src/lib/supabase.ts` does now. No component holds a service role key.

**Rationale:** `routes/events.ts` states plainly that its own `organiser_id` filter is defence in depth, not the primary control. The primary control is the `organisers_select_own_events` policy. Adding a gateway must not weaken that.

**Consequence:** every service needs the caller's token, so the gateway cannot terminate auth entirely.

### D5. An API gateway as the single entry point

**Rationale:** `frontend/src/lib/eventsApi.ts` targets a single `VITE_EVENTS_API_URL`, which does not scale to seven services without either a gateway or seven base URLs in the SPA.

**Consequence:** one more container to run, and a single point of failure for all API traffic.

### D6. RabbitMQ topic exchange for asynchronous events

Exchange `connectsphere.events`. Five services publish; four consume.

**Rationale:** E7-2 defines 18 triggers fired from every other epic. Without async delivery all six services acquire a synchronous dependency on the notification service. Cancellation (E3-6) also fans out to venue, equipment and attendees at once.

**Consequence:** eventual consistency on notifications and released resources, plus a broker to run locally.

### D7. Synchronous REST only for live cross-service reads

Used where eventual consistency is unacceptable: the E3-4 confirmation gate, E3-10 impact assessment, E6-1 and E6-7 capacity checks.

**Consequence:** runtime coupling on those paths. A venue service outage blocks confirmation.

### D8. Model the target state, tag what exists today

Elements tagged `Existing` render green; `Planned` renders with a dashed border.

| Element | Status |
|---|---|
| Web application | Exists, `frontend/`, four views |
| Event request service | Exists, three routes plus `/health` |
| Database | Exists, `events` and `access_denials` only |
| Supabase Auth | Exists, in use for sign in and token verification |
| Gateway, six services, broker | Design only |

### D9. Component views for three services only

Event request (E2), event lifecycle (E3) and venue (E4), being the services carrying the most domain logic. See 1.7.

---

## 3. Assumptions made

Each assumption is being proceeded on. The last column says who must confirm it.

| ID | Assumption | Confirm with |
|---|---|---|
| A1 | Role resolution happens once, at the gateway | Group |
| A2 | The identity service wraps Supabase Auth rather than replacing it | Group |
| A3 | Single session events only | Customer (Q1) |
| A4 | Round robin coordinator assignment | Customer (Q5) |
| A5 | E2-12 reassignment is in scope | Customer (#67) |
| A6 | Notification delivery is in app only | Confirmed (E7-1) |
| A7 | The assigned coordinator actions an organiser's cancellation | Customer (Q2) |
| A8 | Venue and equipment are the only gates before confirmation | Customer (Q6) |

### A1. Role resolution happens once, at the gateway

The gateway calls the identity service, resolves the caller's roles and injects them into the forwarded request.

**Basis:** E1-4 to E1-7 are all role scoping stories, so every service needs the caller's role. Resolving per service gives all seven a synchronous dependency on identity.

**Note:** no role exists anywhere in the schema today. There is no profiles table and no role column; migration 0001 scopes purely on `organiser_id = auth.uid()`. E1-1 requires new accounts to default to Attendee, so this is net new work.

### A2. The identity service wraps Supabase Auth rather than replacing it

Supabase issues and verifies tokens. The identity service owns only what Supabase cannot do natively: the E1-2 lockout, the role directory, and the active coordinator roster that E2-6 reads.

### A3. Single session events only

Every booking and reservation is one period against one venue.

**Basis:** PRD open question Q1, raised on #44, #47 and #53 and flagged there as priority to resolve because it changes the data model. Single session is the working assumption recorded on those issues.

**Risk:** if wrong, the venue and equipment schemas change shape and the venue component view needs a session level component between event and booking. Highest impact unresolved question in the backlog.

### A4. Round robin coordinator assignment

No capacity model.

**Basis:** Q5 on #20. The customer confirmed assignment is automatic and capped at one coordinator per event but gave no algorithm.

### A5. E2-12 reassignment is in scope

Implemented by the coordinator picker component.

**Basis:** #67 records a direct conflict. The customer confirmed reassignment is out of scope (PRD section 10), but Week 4 Project Instructions Area 5 lists it as core functionality. Including it covers the graded requirement and is cheap to remove.

### A6. Notification delivery is in app only

No email or SMS provider appears in C1 or C2.

**Basis:** E7-1 states delivery is in app only and the channel is the team's choice. #63 confirms no integration with external tools.

### A7. The assigned coordinator actions an organiser's cancellation

**Basis:** Q2 on #31. Whether cancellation is automatic or needs coordinator approval is unresolved; the working assumption on that issue is that the coordinator actions it.

### A8. Venue and equipment are the only gates before confirmation

**Basis:** Q6 on #29, asking which briefing process steps 6 to 9 are mandatory before confirmation. The direct answer given was venue and technical, so the confirmation gate checks those two only.
