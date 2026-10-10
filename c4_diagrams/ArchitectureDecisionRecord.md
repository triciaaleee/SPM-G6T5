# Architecture Decision Record: ConnectSphere C4 model

**Version 2.1** | 2026-10-10 | Tricia Lee (@triciaa-leee)

Records the significant decisions behind `c1-system-context.dsl`, `c2-containers.dsl` and `c3-components.dsl`. The diagrams show the finished Release 1 product (Week 12), including the Week 7 customer changes. Section 1 lists what the code does not do yet.

## Changelog

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | 2026-09-11 | Tricia Lee | Initial record. Nine decisions and eight assumptions covering C1 to C3. |
| 2.0 | 2026-10-10 | Tricia Lee | Week 7 customer changes and alignment with the built services. Seven roles in C1 and C2. Supabase Auth removed. One C2 view instead of two. Six services behind an Express gateway. C3 views for the gateway, events service and venue service. D2, D3, D5, D7 and D9 revised; D4 and D8 superseded; D10 to D13 added. A1 to A8 resolved; A9 to A15 added for Week 7. |
| 2.1 | 2026-10-10 | Tricia Lee | RabbitMQ message catalogue moved to `RabbitMQ.md`. D6 revised: services announce their own releases on cancellation. New section 4 with the messaging rules. A16 and A17 added. |

---

## 1. Open: what the code does not do yet

The diagrams show the target. Each item below is a gap between the diagrams and the repo, with the work needed to close it.

### 1.1 Notifications go over REST, not through the broker

C2 shows every notification trigger published to RabbitMQ (D6). Today venue-service and equipment-service call `POST /api/notifications` directly (`lib/notificationsClient.ts`), and events-service sends none. Closing this means:

- running RabbitMQ locally (`RabbitMQ.md` section 6);
- adding `RABBITMQ_URL` to `backend/.env.example` and `backend/README.md`;
- an `amqplib` publisher in each publishing service and a consumer in each consuming service, following section 4;
- a `message_id` column on notifications so a redelivered message does not create a second feed entry (rule M5).

`POST /api/notifications` can stay while triggers move over one at a time.

### 1.2 The API gateway does not exist yet

D5 specifies it. Work: a new `backend/services/gateway-service/` on port 4000, added to `backend/package.json` and `backend/README.md`; `GATEWAY_PORT` and the six service URLs in `backend/.env.example`; and the frontend's five `VITE_*_API_URL` values replaced by one.

### 1.3 Registration service and Safety Review are not built

`registration-service` (D12, port 4006) and the events-service Safety Review components (D11, E3-4, E3-12 to E3-14) appear in the diagrams only.

### 1.4 Hold expiry has no scheduled sweep

`lib/bookingDecisions.ts` treats a lapsed hold as `Expired` when the booking is read. The scheduled sweep and the "about to expire" warning to the coordinator (E4-12) are not built.

### 1.5 Events service reads the users table directly

`lib/coordinatorAssignment.ts` queries `users`, which user-service owns. The diagrams show events-service asking user-service for active coordinators instead, per AGENTS.md section 1. The file also still holds the E2-6 round-robin, which Week 7 change 5 replaces.

### 1.6 Role enum and AGENTS.md disagree

Migration `0004` defines `coordinator_lead` and `safety_officer` in `app_role`, but AGENTS.md section 5 lists only five roles and no code uses the two new ones yet. AGENTS.md should be corrected.

### 1.7 `submitted_details` is still an opaque `jsonb` blob

Carried over from 1.0. Venue search, suitability and registration capacity all read date, times and attendance from it through events-service. Decide which fields to promote to real columns.

### Resolved since 1.0

| 1.0 item | Resolution |
|---|---|
| 1.1 Who owns the `events` aggregate | events-service owns the event through every status (D2). |
| 1.2 Status vocabulary inconsistent | Postgres enums in migration `0014`; AGENTS.md section 3 is the single list. |
| 1.4 No `UPDATE` policy on `events` | No longer relevant: services use the service-role key and enforce access in code (D4). |
| 1.5 Lockout had nowhere to live | user-service owns login and lockout (migration `0006`). |
| 1.7 Which services get C3 views | Gateway, events and venue (D9). |

---

## 2. Decisions

| ID | Decision | Status in 2.0 |
|---|---|---|
| D1 | Microservices architecture rather than a modular monolith | Kept |
| D2 | Six backend services | Revised |
| D3 | One Postgres instance; each service owns its own tables | Revised |
| D4 | Row level security as the primary authorisation control | Superseded by D10 |
| D5 | An Express API gateway as the single entry point | Revised |
| D6 | RabbitMQ topic exchange for asynchronous events | Revised |
| D7 | Synchronous REST only for live cross-service reads | Revised |
| D8 | Model the target state, tag what exists today | Superseded |
| D9 | Component views for the gateway, events and venue services | Revised |
| D10 | user-service issues the JWT; no external identity provider | New |
| D11 | Safety Review lives in the events service | New |
| D12 | Attendee registration is its own service | New |
| D13 | One C2 view that includes every role | New |

### D1. Microservices architecture

**Rationale:** the backlog separates cleanly by epic, with distinct roles and data.

**Consequence:** more moving parts than one service, and cross-service reads that a monolith would resolve with a join.

### D2. Six backend services (revised)

| Service | Epic | Port |
|---|---|---|
| user-service | E1 | 4002 |
| events-service | E2, E3 | 4001 |
| venue-service | E4 | 4003 |
| notification-service | E7 | 4004 |
| equipment-service | E5 | 4005 |
| registration-service | E6 | 4006 |

**Change from 1.0:** the separate event request (E2) and event lifecycle (E3) services are merged into events-service. Both acted on the same event row, and splitting the status machine across two services could not satisfy E3-3. This settles 1.0 item 1.1.

### D3. One Postgres instance; each service owns its own tables (revised)

Each service reads and writes only its own tables and reaches other data through the owning service's REST API (AGENTS.md section 1). The tables live in the default schema rather than one schema per service.

**Consequence:** not textbook isolation. The shared instance is a single point of failure.

### D4. Row level security as the primary control (superseded)

Services connect with the Supabase service-role key (`lib/supabaseAdmin.ts`) and enforce role and ownership checks in their own middleware and routes. Every illegal status transition is rejected by the backend with `409` (AGENTS.md section 3). See D10.

### D5. An Express API gateway as the single entry point (revised)

A small `gateway-service` (Express 5 with `http-proxy-middleware`, port 4000). It verifies the JWT once with the shared `JWT_SECRET`, lets only `/api/auth/signup`, `/api/auth/login` and `/health` through without a token, and proxies by path prefix:

| Prefix | Service |
|---|---|
| `/api/auth`, `/api/users` | user-service |
| `/api/events` | events-service |
| `/api/venues` | venue-service |
| `/api/equipment-requests` | equipment-service |
| `/api/registrations` | registration-service |
| `/api/notifications` | notification-service |

The original `Authorization` header is forwarded, and each service still verifies the token and checks the role (defence in depth).

**Rationale:** the web app currently needs five base URLs, and CORS and token checks are repeated in every service. One front door fixes both.

**Alternatives rejected:** Kong or Traefik (another runtime to install and configure, for routing six prefixes); Nginx (routes but cannot check the JWT without extra modules); the Vite dev-server proxy (development only, so not a gateway in production).

**Consequence:** a single point of failure for all API traffic, and one more process in `npm run dev`.

### D6. RabbitMQ topic exchange for asynchronous events (revised)

Exchange `connectsphere.events`. Events, venue, equipment and registration services publish. Notification, events, venue, equipment and registration services consume. The full message catalogue, the requirement each message serves, the queue bindings and the message envelope are in [`RabbitMQ.md`](RabbitMQ.md); the rules every publisher and consumer follows are in section 4 below.

**Rationale:** E7-2 has notification triggers in every epic. Without a broker, every service needs a synchronous dependency on notification-service. Cancellation (E3-6) fans out to venues, equipment and registrations at once, and a venue becoming unavailable (change 2) must send the event back for re-review.

**Change in 2.1:** on cancellation, venue-, equipment- and registration-service each release what they hold, then announce it (`booking.withdrawn`, `equipment.released`, `registration.cancelled_by_event`) with the recipients they know. notification-service never looks up attendees or venue staff in another service. The rejected alternatives were notification-service calling those services for recipients, and events-service collecting every recipient before publishing; the second would make cancellation fail whenever one of them is down.

**Consequence:** eventual consistency on notifications and released resources, plus a broker to run locally. Not built yet; see 1.1.

### D7. Synchronous REST only for live cross-service reads (revised)

| Caller | Owner | Purpose |
|---|---|---|
| events | user | Active coordinators for assignment and reassignment (E2-12, E2-13) |
| events | venue | Booking status before safety review, and change impact (E3-4, E3-10) |
| events | equipment | Reservation status before safety review, and change impact (E3-4, E3-10) |
| events | registration | Registered counts against proposed capacity (E3-10) |
| venue | events | Event date, times, attendance and status for occupied windows (E4-6 to E4-11) |
| equipment | events | Event timing to scope availability (E5-4) |
| registration | events | Event details and status (E6-1, E6-2) |
| registration | venue | Capacity of the approved bookings (E6-1, E6-6) |
| notification | user | Role-based recipients such as coordinator leads and safety officers (E7-2) |

The caller forwards the user's bearer token, so the owner's access rules apply.

**Consequence:** runtime coupling on these paths. A venue-service outage blocks submission for safety review.

### D8. Model the target, tag what exists (superseded)

The diagrams now show the finished Release 1 product without Existing or Planned tags. Section 1 of this record tracks what is not built.

### D9. Component views for the gateway, events and venue services (revised)

The gateway because it is new infrastructure; events and venue because they carry most of the Week 7 logic (unassigned queue, Safety Review, re-review, setup and turnaround, unavailability, multi-venue bookings, expiring holds). Component technology names the real file where one exists.

### D10. user-service issues the JWT (new)

user-service signs a JWT carrying the caller's id and role; every other service, and the gateway, only verifies it with the shared `JWT_SECRET` (AGENTS.md section 5). Supabase Auth is not used, so C1 shows no external systems. Issue #63 confirms there is no integration with other tools, and E7-1 fixes notification delivery as in-app only.

### D11. Safety Review lives in the events service (new)

The Operational Safety Check (Week 7 change 6) moves an event between `Planning`, `Safety Review` and `Confirmed`. The service that owns the status machine owns the check, so the transition rules stay in one place. Outcomes are stored in `event_safety_reviews`.

### D12. Attendee registration is its own service (new)

Registrations are a separate entity with their own data and roles (attendee, organiser), so AGENTS.md section 1 gives them their own service rather than adding them to events-service.

### D13. One C2 view that includes every role (new)

1.0 had two C2 views. C2-EventPath showed only the broker and services, without the people or the web app, so it did not show how anyone uses the system. 2.0 has one view: the seven roles, the web app, the gateway, the six services, the broker and the database.

---

## 3. Assumptions

### Resolved since 1.0

| ID | 1.0 assumption | Now |
|---|---|---|
| A1 | Role resolution happens once, at the gateway | Revised. The role is a claim in the JWT (D10). The gateway verifies the token; each service checks the role it needs. |
| A2 | Identity service wraps Supabase Auth | Superseded by D10. |
| A3 | Single-session events only | Superseded by Week 7 change 3: an event can have several venue bookings, all sharing the event's date and times (AGENTS.md section 3a). |
| A4 | Round-robin coordinator assignment | Superseded by Week 7 change 5: the coordinator lead assigns from an unassigned queue. |
| A5 | E2-12 reassignment is in scope | Confirmed by Week 7 change 5: the coordinator lead reassigns. |
| A6 | Notification delivery is in-app only | Confirmed (E7-1). |
| A7 | The assigned coordinator actions an Organiser's cancellation | Superseded by the customer's answer to Q2: cancellation is automatic, and the coordinator is notified. |
| A8 | Venue and equipment are the only gates before confirmation | Superseded by Week 7 change 6: the Operational Safety Check sits between them and `Confirmed`. |

### Week 7 assumptions (not yet confirmed with the customer)

| ID | Assumption | Confirm with |
|---|---|---|
| A9 | A `Safety Review` or `Confirmed` event returns to `Planning` when a booking becomes `Replacement Required` or an approved change affects its venues or equipment, and must pass safety review again | Customer |
| A10 | A safety rejection returns the event to `Planning`; it does not end the event | Customer |
| A11 | A tentative hold lasts a fixed 72 hours from when Venue Staff place it | Customer |
| A12 | The action that stops a hold expiring is a Venue Staff approve or reject decision | Customer |
| A13 | One safety check covers the whole event, including all its venues | Customer |
| A14 | Coordinators can view every event but manage only those assigned to them | Customer |
| A15 | Coordinator lead and safety officer accounts are seeded like other internal accounts, since there is no administrator | Group |
| A16 | Week 7 change 2's "affected bookings" includes pending ones: a `Requested` or `On Hold` booking that clashes with new unavailability keeps its status, but its coordinator is notified (`booking.unavailability_clash`) | Group (decided 2026-10-10) |
| A17 | Three notifications go beyond Week 4 Area 20 and Week 7, and are kept because the backlog commits to them: an Organiser's edit to the coordinator (E2-7), a booking withdrawal to Venue Staff (E4-9), and an equipment amendment or cancellation to Technical Support (E5-2) | Group (decided 2026-10-10) |

A9 and A10 come from AGENTS.md section 3, A11 and A12 from section 3a. A9 has the most impact: without it, a confirmed event whose venue becomes unavailable has no way back to safety review.

---

## 4. Messaging rules

Every publisher and consumer on `connectsphere.events` follows these. Which messages exist, who sends them and who receives them is in [`RabbitMQ.md`](RabbitMQ.md).

| ID | Rule | Why |
|---|---|---|
| M1 | **One topic exchange; the routing key is the message type**, named `<entity>.<what_happened>` in the past tense (`booking.withdrawn`). Any change to a message's meaning gets a new name, never a reused one. | Consumers bind by name, so a reused name would silently change what they receive. |
| M2 | **One durable queue per consuming service, bound only to the keys it acts on.** Messages are published as persistent. | A service that is down misses nothing; its messages wait in its queue until it restarts. |
| M3 | **Publish only after the service's own database write has committed.** | Never announce something that then fails to save. |
| M4 | **A consumer acknowledges a message only after its own database write succeeds.** On failure it rejects the message, which is retried a few times and then moved to the service's dead-letter queue (`<queue>.dlq`) for inspection. | A crash mid-way leaves the message to be redelivered, not lost. |
| M5 | **Consumers must handle the same message twice.** State changes are no-ops if already applied (withdrawing an already-`Withdrawn` booking does nothing and announces nothing). notification-service records each `messageId` and skips one it has seen. | RabbitMQ delivers at least once, so redelivery is normal. |
| M6 | **A failed publish of a message that releases resources is retried and logged, never dropped.** This covers `event.cancelled` and `booking.replacement_required`. Other notification-only messages are best effort after the write, as notifications are today. | A lost `event.cancelled` leaves venues blocked and equipment reserved; a lost notification only means someone is not told. |
| M7 | **Every message carries the recipient IDs its publisher already knows** (organiser, assigned coordinator, a venue's staff member, attendees). Whole role groups (coordinator leads, safety officers, Technical Support) are named by role and resolved by notification-service through user-service. | notification-service never needs another service's data to decide who to tell. |
| M8 | **The service that changes something announces it.** On cancellation, venue-, equipment- and registration-service each release what they hold, then publish their own message (D6). | Only the owner knows who is affected, and people are told only after the release has happened. |
| M9 | **"Assigned coordinator" means the one assigned when the message is published;** if the event is `Unassigned`, the coordinator leads receive it instead (E7-2 AC4, AC5). | A reassigned coordinator must stop receiving the event's notifications. |
| M10 | **Messages never replace a live read.** Anything that must answer from current state, such as the safety-review gate (E3-4), calls the owning service's REST API (D7). | Messages arrive slightly late; a gate must not decide on stale data. |
| M11 | **Known race, accepted.** The safety officer may approve an event in the moment between a booking becoming `Replacement Required` and events-service receiving the message. The event goes to `Confirmed`, then the re-review returns it to `Planning`. | The lifecycle allows `Confirmed → Planning` for exactly this case (AGENTS.md section 3), so the event always ends in the right state. |
| M12 | **Each service publishes through one small module that unit tests replace with a fake**, so `npm test` never needs a running broker. | Keeps tests fast and runnable anywhere, including CI. |
