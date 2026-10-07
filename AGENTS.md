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
    venue-service/        # port 4003
    notification-service/ # port 4004
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

The event status machine is **fixed**. Use exactly these status values (exact casing and spacing) and **only** these transitions. Do not add, rename or skip statuses (no `Submitted`, `Approved`, etc.) unless the team updates this section first.

`Draft` is allowed, but it sits **before** the process: it's the organiser's unsubmitted work. The lifecycle process itself starts at `Unassigned` (Week 7 change 5: new requests are no longer auto-assigned to a coordinator). Once an event leaves `Draft` it can never go back.

> **Week 7 customer changes (Release 1).** This section reflects `Week 7 Customer Changes.pdf`. Items marked *(assumption)* are interpretations the team has not confirmed with the customer — confirm them, then remove the marker.

### Statuses

`events.status` is a Postgres enum (`event_status`, migration `0014`) — the database itself rejects any value outside this list, not just application code.

| Status | Type |
|---|---|
| `Draft` | Pre-process (optional, not part of the lifecycle) |
| `Unassigned` | **Start** of the lifecycle. Every submitted request waits here in the Event Coordinator Lead's unassigned queue until the Lead assigns it to a coordinator (Week 7 change 5). Replaces the E2-6 round-robin auto-assignment. |
| `Requested` | Assigned to an Event Coordinator, awaiting that coordinator's review |
| `Clarification Requested` | Intermediate |
| `Planning` | Intermediate. Venue and technical arrangements are made here. |
| `Rejected` | **End** (terminal) |
| `Safety Review` | Intermediate. Venue bookings are confirmed and equipment is reserved; awaiting the Safety Officer's Operational Safety Check (E3-12/13/14). Outcomes are recorded in `event_safety_reviews` (migration `0012`). |
| `Confirmed` | Intermediate. Safety-approved: arrangements are locked in and the event may proceed to preparation. *(There is deliberately no `Preparation` status — the Week 7 PDF only says the event cannot "proceed to preparation" until safety approves; `Confirmed` is that point.)* |
| `Completed` | **End** (terminal) |
| `Cancelled` | **End** (terminal). The Organiser cancelled their own event. Added in `0014`. |

### Diagram

```
  (pre-process)         (lifecycle START)
 ┌─────────┐  submit   ┌───────────────┐  Lead assigns  ┌───────────────┐              ┌─────────────────────────┐
 │  Draft  │ ────────▶ │  Unassigned   │ ─────────────▶ │   Requested   │ ◀──────────▶ │ Clarification Requested │
 └─────────┘           └───────────────┘                └───────┬───────┘              └─────────────────────────┘
  optional                                                      │
                                                    ┌───────────┴───────────┐
                                                    ▼                       ▼
                                            ┌───────────────┐       ┌───────────────┐
                                            │   Planning    │       │   Rejected    │  END
                                            └───┬───────┬───┘       └───────────────┘
                                                │  ▲    └────────▶ Clarification Requested (returns to Planning)
                  coordinator submits for │  │ safety: changes requested / rejected
                  safety review           ▼  │
                                            ┌───────────────┐
                                            │ Safety Review │
                                            └───────┬───────┘
                                                    │ Safety Officer approves
                                                    ▼
                                            ┌───────────────┐
                                            │   Confirmed   │
                                            └───────┬───────┘
                                                    │ after event concludes
                                                    ▼
                                            ┌───────────────┐
                                            │   Completed   │  END
                                            └───────────────┘

  Cancelled (END): the Organiser can cancel from any active status
  (Unassigned, Requested, Clarification Requested, Planning,
  Safety Review, Confirmed) — see the transitions table.
```

### Allowed transitions (the only ones)

| From | To | Notes |
|---|---|---|
| — | `Draft` | Optional: organiser saves without submitting. |
| `Draft` | `Unassigned` | Organiser submits. This is where the lifecycle process starts. |
| — | `Unassigned` | Submitting directly (no draft) also lands here. |
| `Unassigned` | `Requested` | Event Coordinator Lead assigns the request to a coordinator (E2-13); that coordinator and the Organiser are notified. Blocked if the event already has a coordinator (an event has at most one) or no active coordinator exists. |
| `Requested` | `Requested` | Lead **reassigns** to a different active coordinator (E2-12). Status unchanged, `coordinator_id` changes, the previous assignment ends and is recorded in the event history (previous coordinator, new coordinator, time, who). The Organiser, the previous coordinator and the new coordinator are notified. Allowed in **any status except** `Rejected`, `Cancelled` and `Completed`. |
| `Requested` | `Planning` | Assigned coordinator approves the request. |
| `Requested` | `Rejected` | Assigned coordinator rejects. Terminal. |
| `Requested` | `Clarification Requested` | Set `status_before_clarification = 'Requested'`. |
| `Clarification Requested` | `Requested` | Organiser responds (when `status_before_clarification = 'Requested'`). |
| `Planning` | `Clarification Requested` | Set `status_before_clarification = 'Planning'`. |
| `Clarification Requested` | `Planning` | Organiser responds (when `status_before_clarification = 'Planning'`). |
| `Planning` | `Safety Review` | Assigned coordinator submits for safety review once all venue bookings are confirmed and all requested equipment is reserved (E3-4; blocked and the outstanding arrangements named otherwise). Appears in the Safety Officer's queue (E1-10). |
| `Safety Review` | `Confirmed` | Safety Officer **approves**; the assigned coordinator and Organiser are notified (E3-12). |
| `Safety Review` | `Planning` | Safety Officer **rejects** the safety arrangement with a required reason; the coordinator is notified (E3-13). |
| `Safety Review` | `Planning` | Safety Officer **requests changes**, recording what must change; the affected venue/equipment arrangements are flagged for re-review (E3-14). *(E3-14 says "relevant earlier planning stage" — treated as `Planning`.)* |
| Any of `Unassigned`, `Requested`, `Clarification Requested`, `Planning`, `Safety Review`, `Confirmed` | `Cancelled` | The owning **Organiser** cancels their event with a **required reason** (E3-6). **Automatic — no coordinator approval** (customer answer to PRD Q2); the assigned coordinator is just notified with the reason. Allowed at any active stage *(assumption: E3-6 only says "not `Completed`"; we also exclude `Draft` — delete the draft instead — and `Rejected`/`Cancelled`)*. Terminal. See the cancellation rules below. |
| `Confirmed` | `Completed` | Only **after the event has concluded** (event end date/time is in the past). Terminal. Every `Confirmed` event has already passed the Operational Safety Check (E3-5). |

Rules:

- `Clarification Requested` must always return to the status it came from, tracked in `events.status_before_clarification` (migration `0010`). It can never jump straight to `Safety Review`, `Confirmed`, `Rejected` or `Completed`.
- `Draft` is outside the process: coordinators don't see or act on drafts, and a draft's only exit is `Draft → Unassigned`. Nothing ever moves back into `Draft`.
- `Rejected`, `Completed` and `Cancelled` are terminal. No transitions out.
- **Cancelling an event** (E3-6) releases every venue booking and equipment reservation for it (freeing the venue and returning equipment quantities to inventory immediately), and notifies the assigned coordinator (with the reason), the affected Venue Staff and Technical Support, and every registered attendee. The event's record and history stay viewable. `Cancelled` is set only by the owning Organiser; coordinators `Reject`, they do not `Cancel`. Further edits and change requests are blocked (E3-9).
- There is **no** `Planning → Confirmed` (every event must pass `Safety Review`; the Safety Officer always responds, so it cannot be skipped or time out), and no `Planning → Rejected`, `Unassigned → Planning`, `Requested → Confirmed`, `Safety Review → Completed` or `Confirmed → Planning`.
- Only the **assigned** Event Coordinator can act on an event; the **Event Coordinator Lead** can view every assignment and active event and is the only role that assigns or reassigns. Only the **Safety Officer** can move an event out of `Safety Review`.
- Every safety outcome (approve / request changes / reject) records the Safety Officer, a timestamp and a reason (required for the two non-approve outcomes).
- Validate every transition on the **backend** against this table and return `409 Conflict` (or `400`) for an illegal one. The frontend may hide invalid actions, but the backend is the source of truth.
- Keep status strings in one constant/enum per service; don't scatter string literals.
- DB defaults, seeds and migrations must use these exact values too.

### Who can edit an event's details (business rule)

Event details (`submitted_details`) can only be edited **up to and including `Planning`**. Once an event moves past `Planning`, **no one** can edit it directly.

| Status | Organiser (owner) | Assigned coordinator | Event Coordinator Lead |
|---|---|---|---|
| `Draft` | Yes (draft routes; submitting validates) | — | — |
| `Unassigned` | **Yes** (direct edit) | No | No |
| `Requested` | Yes (direct edit, E2-7) | No | No |
| `Clarification Requested` | Yes (responding edit, E2-10) | No | No |
| `Planning` | Yes (direct edit) | Non-critical fields only (E3-7) | No |
| `Safety Review`, `Confirmed`, `Completed`, `Rejected`, `Cancelled` | **No** | **No** | **No** |

- Every edit is recorded in event history (field, old value, new value, timestamp, author).
- A rejection or "request changes" from the Safety Officer returns the event to `Planning`, which makes it editable again; that is the only route to change an event in `Safety Review`.
- After `Confirmed`, the Organiser raises a **change request** instead (E3-9). Critical fields are held for coordinator review (E3-8).
- Editing never changes who is assigned: the Lead's assign/reassign (E2-12/13) is separate and is not an edit of event details.
- Cancelling (E3-6) is not an edit, so the Organiser can still cancel at any active stage.
- Backend enforcement: `PATCH /api/events/:id` returns `409` for any status not marked "Yes" above for the caller's role.

> Note: `c4_diagrams/ArchitectureDecisionRecord.md` §1.2 lists `Cancelled`. It is now part of the agreed lifecycle, but only for the Organiser cancelling their own event. This section overrides the ADR for everything else.

---

## 3a. Venue bookings (Week 7 changes 1–4)

`venue_bookings.status` is the Postgres enum `venue_status` (migration `0014`). A booking links one venue to one event; its date and times come from the event (via events-service), never stored on the booking.

| Status | Meaning | Blocks the venue? |
|---|---|---|
| `Requested` | The coordinator's booking request, awaiting Venue Staff. No expiry. | **No.** Several coordinators can request the same venue and slot at once. |
| `On Hold` | Venue Staff are temporarily holding the venue while the coordinator finalises arrangements (Week 7 change 4). **Must have an expiry** (`hold_expires_at`). Added in `0014`. | Yes, until it expires |
| `Approved` | Confirmed booking. | Yes |
| `Rejected` | Refused by Venue Staff with a reason, or **auto-rejected** because another booking for the same venue and an overlapping window reached `On Hold` or `Approved` first. Allowed from `Requested` or `On Hold`. | No |
| `Expired` | An `On Hold` booking passed `hold_expires_at` without being approved. Never treated as a confirmed booking. Added in `0014`. | No |
| `Withdrawn` | The booking was released: the coordinator withdrew the request or released the booking (E4-9), the event was cancelled (E3-6), or the coordinator gave up the booking after a replacement was found (E4-15). The row stays for history. Added in `0014`. | No |
| `Replacement Required` | The venue became unavailable after booking (Week 7 change 2). The event is **not** cancelled and its information is preserved; the booking is flagged and the coordinator searches for and requests a replacement venue. Added in `0014`. | No (the venue itself is blocked by its unavailability period) |

Allowed booking transitions:

| From | To | Notes |
|---|---|---|
| — | `Requested` | Coordinator submits a booking request (E4-8). |
| `Requested` | `On Hold` | Venue Staff hold the venue temporarily. Only allowed while the venue is free for the period (setup/turnaround included) and the event is still in `Planning` (E4-10). `hold_expires_at` is set from a **fixed hold duration** (E4-12). |
| `Requested` | `Approved` | Venue Staff approve directly, if there is no conflict (E4-10). |
| `Requested` | `Rejected` | Venue Staff reject (a reason is required), **or automatic**: another booking for the same venue with an overlapping occupied window moved to `On Hold` or `Approved` first. The reason is the fixed text "Venue no longer available for this period" (E4-11); the coordinator is notified and can request another venue or time. |
| `On Hold` | `Approved` | Venue Staff approve before the hold expires, if there is no conflict; clear `hold_expires_at`. |
| `On Hold` | `Rejected` | Venue Staff manually reject the held booking, with a reason. Releases the venue immediately. |
| `On Hold` | `Expired` | The deadline passes with no decision. Automatic. |
| `Approved` | `Replacement Required` | The venue became unavailable after booking (change 2). |
| `Requested`, `On Hold` | `Withdrawn` | The coordinator withdraws the request or hold (E4-9). Other bookings of the same event are untouched. |
| `Approved` | `Withdrawn` | The coordinator **releases** the confirmed booking (E4-9: an approved request is released, not withdrawn as a request). |
| `Replacement Required` | `Withdrawn` | The coordinator releases the affected booking once a replacement is requested (E4-15). |
| `Requested`, `On Hold`, `Approved`, `Replacement Required` | `Withdrawn` | The event is cancelled (E3-6): every active booking of the event is released at once. |

An `Expired` booking has no approve, hold or reject action (E4-12). `Rejected`, `Expired` and `Withdrawn` are end states for that booking row (`Replacement Required` ends when the coordinator releases it). To try again the coordinator makes a new request. There is no coordinator override of a Venue Staff decision (E4-10).

Rules:

- **First to reach `On Hold` or `Approved` wins.** Only `On Hold` and `Approved` bookings block a venue. When a booking moves to either, every other `Requested` booking for the same venue whose occupied window (including setup/turnaround) overlaps it is auto-rejected in the same transaction, so two overlapping bookings can never both be `On Hold`/`Approved`. If the winning hold later expires, the auto-rejected requests are **not** revived.
- **New requests are checked on submission.** A new booking request that overlaps an `On Hold` or `Approved` booking for the same venue is rejected at submission and the conflicting window is shown (E4-8, E4-11). Overlap with a `Requested`, `Rejected`, `Expired` or `Withdrawn` booking is not a conflict. When two overlapping bookings are acted on at the same moment, only the first succeeds; the check and update run in one database transaction.
- **Setup and turnaround (change 1).** Each venue has a configurable setup time and turnaround time (`venues.setup_minutes`, `venues.turnaround_minutes`). Availability and conflict checks use the *occupied window* = event start − setup to event end + turnaround (a 10:00–12:00 event with 30 min setup and 45 min turnaround occupies 09:30–12:45). An existing booking that becomes a conflict under a new or changed setup/turnaround is **identified and flagged**, never silently removed.
- **Venue unavailable after booking (change 2).** Venue Staff mark a venue unavailable for a period with a reason (maintenance, equipment failure, renovation, safety, other), stored in `venue_unavailability` (migration `0016`, E4-3). A period is `start_date`–`end_date` (inclusive local dates) and either blocks those days entirely (`all_day`) or the same `start_time`–`end_time` on each day, so "09:00–13:00 every day for a week" is one row; it can be edited or removed. A booking clashes when its occupied window (setup/turnaround included) overlaps the period. Clashing `Approved` bookings are set to `Replacement Required`; clashing pending ones (`Requested`, `On Hold`) keep their status, since that transition is only allowed from `Approved`. Every clashing booking's Event Coordinator is notified via notification-service. Nothing is auto-cancelled. Blocked venues are excluded from venue search.
- **Multiple venues per event (change 3).** An event may have any number of `venue_bookings` rows. Each is checked independently for suitability, availability and conflicts. Changing or cancelling one booking never removes the others unless explicitly required.
- **Tentative holds expire (change 4).** An `On Hold` booking blocks the venue only until `hold_expires_at`, or until Venue Staff approve or reject it first. When it passes without a decision, the booking becomes `Expired`, the venue is released, and the Event Coordinator is notified before or when it expires. Expiry must be applied when availability is checked (and by a scheduled sweep), so a stale `On Hold` row never blocks a venue.
- Statuses that block a venue are the single constant `UNAVAILABLE_BOOKING_STATUSES` in venue-service `lib/bookingStatus.ts` (`On Hold` only while unexpired, and `Approved`; `Requested` does not block).

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
- **Database:** Supabase Postgres. Schema changes go in a new migration `supabase/migrations/NNNN_description.sql` (next number, re-runnable/guarded where possible). **Until the first production deploy, migrations may be edited in place** (the scripts only ever run against a fresh prod DB, and any change to an existing dev database is applied by hand to match). After the first production deploy, never edit an applied migration — add a new one.
- **Enum types:** three columns are backed by Postgres enums, not free text — the database rejects any value outside the list, so a new status/role must be added to the enum (a migration, e.g. `alter type ... add value ...`) before any code can write it:
  - `users.role` → `app_role` (migration `0004`): `attendee`, `organiser`, `coordinator`, `venue_staff`, `technical_support`, plus the Week 7 roles `coordinator_lead` (Event Coordinator Lead: oversees the unassigned queue, assigns and reassigns coordinators) and `safety_officer` (Operational Safety Check). Their user-id prefixes are `LEAD-` and `SAF-`, each with its own sequence (see `generate_user_id()` in `0004` and `sync_user_id_sequences()` in `0013`).
  - `events.status` → `event_status` (migration `0014`): the 10 values in §3's table above (`Safety Review` and `Cancelled` are new).
  - `venue_bookings.status` → `venue_status` (migration `0014`): `Requested`, `On Hold`, `Approved`, `Rejected`, `Expired`, `Replacement Required` and `Withdrawn` — see §3a. It backs a **booking-approval** workflow (a specific booking request is approved/rejected, not the venue itself).
- **Postgres enum caveat:** once a database exists, `alter type ... add value` cannot be used in the same transaction as the statements that use the new value, so apply it on its own. (Because the enums are created with all their values up front, this only matters when hand-patching an existing DB.)
- **Tests:** add or update tests for any backend route or lifecycle change. Run `npm test` in each service you touched before finishing.
- **Docs:** when you add a service, port, env var or script, update `backend/README.md` in the same change.
