# RabbitMQ messaging: ConnectSphere

**Version 1.1** | 2026-10-31 | Tricia Lee (@triciaa-leee)

The message catalogue behind the broker in `c4_diagrams/c2-containers.dsl` and the publishers and consumers in the per-service component views in `c4_diagrams/c3/` (`c3-<service>.dsl`). It traces every notification requirement to the message that delivers it. The rules every publisher and consumer must follow are in `c4_diagrams/ArchitectureDecisionRecord.md` section 4; the decision to use RabbitMQ is D6 there.

## 1. Topology

| Item | Value |
|---|---|
| Exchange | `connectsphere.events`, type `topic`, durable |
| Routing key | The message type, `<entity>.<what_happened>` in the past tense, e.g. `booking.withdrawn` |
| Dead-letter exchange | `connectsphere.dlx`; each queue has a matching `<queue>.dlq` |
| Connection | `RABBITMQ_URL` in `backend/.env` (e.g. `amqp://guest:guest@localhost:5672`) |

One durable queue per consuming service, bound only to the routing keys it acts on:

| Queue | Bindings | Why |
|---|---|---|
| `notification-service` | `#` (everything) | Every message names people to notify |
| `events-service` | `booking.replacement_required` | Moves a `Confirmed` event to `Needs Review`, or a `Safety Review` event to `Planning` (AGENTS.md section 3). Today venue-service reports it over REST (`POST /api/events/:id/arrangements-changed`, internal token) after the booking write commits |
| `venue-service` | `event.cancelled`, `event.rejected`, `event.rescheduled`, `event.attendance_changed` | Withdraws every active booking of the event (E3-6, or when a `Planning` event is rejected through a clarification), or reviews its bookings after a Planning edit to its date, time or expected attendance (AGENTS.md section 3a) |
| `equipment-service` | `event.cancelled`, `event.rejected`, `event.rescheduled` | Releases reservations (E3-6, or when a `Planning` event is rejected through a clarification), or moves each reserved unit's stored booking window when the event's date, start time or end time changes and re-checks the reservations against it (E5-6 AC3) |
| `registration-service` | `event.cancelled` | Closes registration and cancels every place (E3-6) |

## 2. Message envelope

Every message has the same outer shape, so notification-service can route any of them without knowing the publisher.

```json
{
  "messageId": "6f1c2a1e-…",
  "type": "booking.withdrawn",
  "occurredAt": "2026-10-10T08:15:00Z",
  "publisher": "venue-service",
  "actorId": "COORD-0003",
  "eventId": 42,
  "recipients": {
    "userIds": ["VEN-0001"],
    "roles": []
  },
  "data": {
    "bookingId": 118,
    "venueName": "Auditorium A",
    "reason": "event_cancelled"
  }
}
```

| Field | Rule |
|---|---|
| `messageId` | UUID set by the publisher. notification-service stores it and skips a message it has already handled. |
| `actorId` | The user who caused it, or `null` when the system did (an auto-rejection, an expiry). |
| `recipients.userIds` | The people the publisher already knows from its own data: organiser, assigned coordinator, a venue's staff member, attendees. |
| `recipients.roles` | Whole role groups (`coordinator_lead`, `safety_officer`, `technical_support`), which notification-service resolves through user-service. |
| `data.reason` | Present on every message with more than one cause (`booking.withdrawn`, `equipment.released`, `booking.decided`, `safety.decided`), so the notification can say why. |

"Assigned coordinator" always means the coordinator assigned when the message is published. If the event is `Unassigned`, the publisher puts `coordinator_lead` in `recipients.roles` instead (E7-2 AC4).

## 3. Requirements and their messages

**Source key:**
- **Wk4 A20:** Week 4 Project Instructions, Area 20 (Notification System). These are customer requirements.
- **Wk7 Cn:** Week 7 Customer Changes, change *n*. Also customer requirements.
- **Story numbers (e.g. E4-9):** the backlog acceptance criterion that commits the team to the notification.
- **E7-2:** the E7-2 trigger-to-recipient matrix.
- **Team:** the team's own decision rather than a customer requirement.

### 3.1 Event request and assignment (events-service)

| # | Trigger | Message | Recipients | Source |
|---|---|---|---|---|
| 1 | Organiser submits a request (it enters the unassigned queue) | `request.submitted` | Organiser (confirmation); all coordinator leads | Wk4 A20 "event submission"; E2-14 AC1; E7-2 |
| 2 | Organiser edits a submitted request | `request.edited` | Assigned coordinator (leads if `Unassigned`) | E2-7 AC1 (Team; not in Wk4 or Wk7) |
| 3 | Lead assigns a coordinator | `coordinator.assigned` | Assigned coordinator, Organiser | Wk4 A20 "coordinator assignment"; Wk7 C5; E2-13 AC1 |
| 4 | Lead reassigns | `coordinator.reassigned` | New coordinator, previous coordinator, Organiser | Wk7 C5; E2-12 AC5 |
| 5 | Coordinator requests clarification | `clarification.requested` | Organiser | Wk4 A20 "clarification requests"; E2-9 AC1 |
| 6 | Organiser answers it | `clarification.answered` | Assigned coordinator | E2-10 AC2 |
| 7 | Coordinator approves or rejects the request | `request.decided` (`data.decision`, `data.reason`) | Organiser | Wk4 A20 "approval or rejection"; E2-11 AC1, AC2 |

### 3.2 Safety review and lifecycle (events-service)

| # | Trigger | Message | Recipients | Source |
|---|---|---|---|---|
| 8 | Coordinator submits for safety review | `safety.submitted` | All safety officers, Organiser | E3-4 AC8 |
| 9 | Safety officer approves (event `Confirmed`) | `safety.decided` (`outcome: approved`) | Assigned coordinator, Organiser | Wk4 A20 "confirmation"; E3-12; E7-2 |
| 10 | Safety officer rejects or requests changes | `safety.decided` (`outcome: rejected` or `changes_requested`, with reason) | Assigned coordinator | E3-13 AC1; E7-2 |
| 11 | Event moves to `Needs Review` (was `Confirmed`) or returns to `Planning` (was `Safety Review`) when an approved arrangement is lost (a booking `Cancelled` by a block-out, or `Replacement Required`) | `event.needs_review` / `event.returned_to_planning` | Assigned coordinator, Organiser; safety officers if it was in `Safety Review` | Wk4 A20 "important event changes"; AGENTS.md section 3 (assumption A9) |
| 12 | Organiser raises a change request | `change.requested` | Assigned coordinator | Wk4 A20 "important event changes"; E3-9 AC1 |
| 13 | Coordinator decides a change request | `change.decided` | Organiser; venue staff of affected bookings and Technical Support if venue or equipment is affected | E3-11 AC1 to AC4 |
| 14 | Organiser cancels the event | `event.cancelled` (with reason) | Organiser (confirmation); assigned coordinator with the reason (leads if `Unassigned`) | Wk4 A20 "cancellation"; E3-6 AC1 |
| 14a | An event's date, start time or end time changes (an edit in `Planning`, or an approved change request) | `event.rescheduled` (`proposedDate`, `startTime`, `endTime`, `coordinatorId`) | None. Consumed by equipment-service and venue-service (section 4); notification-service skips it without a warning | Keeps equipment booking windows in step with the event (E5-6); has venue bookings re-checked (§3a) |
| 14b | An event's expected attendance changes (an edit in `Planning`, or an approved change request) | `event.attendance_changed` (`expectedAttendance`, `coordinatorId`) | None. Consumed by venue-service (section 4); notification-service skips it without a warning | Has venue bookings checked against the new attendance (§3a) |
| 14c | The coordinator rejects an event, including a `Planning` event rejected while a clarification is open (AGENTS.md section 3) | `event.rejected` (`eventName`, `reason`) | None. Consumed by venue-service and equipment-service (section 4), which release what the event holds; the Organiser is told by `request.decided`, and notification-service skips it without a warning | Releases the venue bookings and equipment reservations of a rejected event |

### 3.3 Venue bookings (venue-service)

| # | Trigger | Message | Recipients | Source |
|---|---|---|---|---|
| 15 | Coordinator requests a booking | `booking.requested` | The venue's staff member | E4-8 AC1; E7-2 |
| 16 | Venue staff place on hold, approve or reject | `booking.decided` (`decision: on_hold`, `approved` or `rejected`, with reason) | Assigned coordinator | Wk4 A20 "venue booking decisions"; E4-10 AC3, AC4 |
| 17 | A request is auto-rejected because another booking reached `On Hold` or `Approved` first | `booking.decided` (`decision: auto_rejected`, fixed reason) | Assigned coordinator | Wk4 A20 "venue booking decisions"; E4-11 AC4 |
| 18 | Coordinator withdraws a request or hold, or releases an approved booking | `booking.withdrawn` (`reason: coordinator_withdrew` or `coordinator_released`) | The venue's staff member | E4-9 AC1 (Team; not in Wk4 or Wk7) |
| 19 | Coordinator releases a `Replacement Required` booking after finding a replacement | `booking.withdrawn` (`reason: replaced`) | The venue's staff member | E4-15 |
| 20 | Hold nears its expiry | `hold.expiring` | Assigned coordinator | Wk7 C4 "before … the hold expires"; E4-12 AC5 |
| 21 | Hold expires | `hold.expired` | Assigned coordinator | Wk7 C4 "or when the hold expires"; E4-12 AC5 |
| 22 | An `Approved` booking clashes with new unavailability | `booking.replacement_required` | Assigned coordinator | Wk7 C2; E4-3 AC2; E4-14 AC1 |
| 23 | A `Requested` or `On Hold` booking clashes with new unavailability (status unchanged) | `booking.unavailability_clash` | Assigned coordinator | Wk7 C2, read as covering pending bookings (Team decision; AGENTS.md section 3a) |
| 24 | A setup or turnaround change makes two bookings overlap | `booking.setup_conflict` | The venue's staff member; assigned coordinator of each event | Wk7 C1 "identified rather than silently removed"; E4-13; E7-2 |
| 25 | Venue capacity reduced below a booked event's attendance | `venue.capacity_reduced` | Assigned coordinator of each affected event | E4-1 AC5 |
| 25a | An edit to an event's date, time or expected attendance leaves one of its bookings invalid (the venue is blocked out, another event holds it, or it is too small) | `booking.invalidated_by_edit` (`venueName`, `reason`, `status`) | Assigned coordinator (leads if none) | §3a: identified and flagged, never silently removed |

### 3.4 Equipment (equipment-service)

| # | Trigger | Message | Recipients | Source |
|---|---|---|---|---|
| 26 | Coordinator raises an equipment request | `equipment.requested` | Technical Support | E5-1 AC1 |
| 27 | Coordinator amends types or quantities | `equipment.amended` (what changed) | Technical Support | E5-2 AC1 (Team; not in Wk4 or Wk7) |
| 28 | Technical Support changes the request's status, including reserving or partly fulfilling it | `equipment.status_changed` | Assigned coordinator | E5-3 AC1, AC2 |
| 29 | Item marked unusable while reserved | `equipment.unusable` | Assigned coordinator | E5-5 AC2 |
| 29a | An event was rescheduled and units reserved for it now clash with another event's booking or an out-of-use period | `equipment.reservation_clash` (`units`) | Assigned coordinator; Technical Support | E5-6 AC3 |
| 30 | Coordinator cancels an equipment request | `equipment.released` (`reason: coordinator_cancelled`) | Technical Support | E5-2 AC3 (Team; not in Wk4 or Wk7) |

### 3.5 Registration (registration-service)

| # | Trigger | Message | Recipients | Source |
|---|---|---|---|---|
| 31 | Attendee registers | `registration.confirmed` | Attendee | Wk4 A20 "registration updates"; E6-3 AC1 |
| 32 | Attendee withdraws | `registration.withdrawn` | Attendee (confirmation) | Wk4 A20 "registration updates"; E6-4 AC4; E7-2 |

### 3.6 Cancellation fan-out

Each service that holds something for the event releases it, then announces its own release. Only that service knows who to tell, and people are told only once the release has happened.

```
Organiser cancels
  └─ events-service: status → Cancelled, publishes event.cancelled ............ #14
       ├─ notification-service: Organiser, coordinator (or leads)
       ├─ venue-service: every active booking → Withdrawn
       │     └─ publishes booking.withdrawn per booking (reason event_cancelled) → that venue's staff member   #33
       ├─ equipment-service: reservations released to inventory
       │     └─ publishes equipment.released (reason event_cancelled) → Technical Support                     #34
       └─ registration-service: registration closed, every place cancelled
             └─ publishes registration.cancelled_by_event (attendee IDs) → each attendee                      #35
```

| # | Trigger | Message | Recipients | Source |
|---|---|---|---|---|
| 33 | Bookings withdrawn because the event was cancelled or rejected | `booking.withdrawn` (`reason: event_cancelled` or `event_rejected`) | The venue's staff member | Wk4 A20 "cancellation"; E3-6 AC2; E7-2 |
| 34 | Reservations released because the event was cancelled or rejected | `equipment.released` (`reason: event_cancelled` or `event_rejected`) | Technical Support | Wk4 A20 "cancellation"; E3-6 AC3; E7-2 |
| 35 | Registrations cancelled because the event was cancelled | `registration.cancelled_by_event` | Every registered attendee | Wk4 A20 "cancellation"; E3-6 AC4; E7-2 |

An event with no bookings, equipment or registrations produces only `event.cancelled`.

### 3.7 Chat (chat-service)

| # | Trigger | Message | Recipients | Source |
|---|---|---|---|---|
| 36 | New chat message | `message.sent` | The other party (coordinator if the organiser sent it, organiser if the coordinator sent it) | E2-15 |

## 4. Messages consumed for something other than notifications

| Message | Consumer | What it does |
|---|---|---|
| `booking.replacement_required` | events-service | Moves a `Confirmed` event to `Needs Review` or a `Safety Review` event back to `Planning`, then publishes `event.needs_review` / `event.returned_to_planning` (#11) |
| `event.cancelled` | venue-service | Withdraws every active booking, then publishes #33 |
| `event.rejected` | venue-service | Withdraws every active booking, then publishes #33 with `reason: event_rejected` |
| `event.rescheduled`, `event.attendance_changed` | venue-service | Checks the event's `Requested`, `On Hold` and `Approved` bookings against the new time (block-outs and other bookings, setup and turnaround included) or attendance (whole-attendance bookings only). An `Approved` one that no longer fits becomes `Replacement Required`; a pending one keeps its status. Publishes #25a, and tells events-service the arrangements changed if an Approved booking was flagged (a `Confirmed` event moves to `Needs Review`, one in `Planning` is left as it is). Safe to process twice |
| `event.cancelled` | equipment-service | Releases reservations, then publishes #34 |
| `event.rejected` | equipment-service | Releases reservations, then publishes #34 with `reason: event_rejected` |
| `event.cancelled` | registration-service | Cancels registrations, then publishes #35 |
| `event.rescheduled` | equipment-service | Sets the stored window (`window_start_ms`, `window_end_ms`) on every `Reserved` booking of the event to the new date and time, then checks them for clashes. If any unit now clashes, tells events-service the arrangements changed (a `Confirmed` event moves to `Needs Review`, one in `Planning` is left as it is) and publishes #29a. Safe to process twice: the notification keeps one `messageId` |

### Reliable delivery for `event.cancelled` and `event.rescheduled`

The messages above are best effort: if the broker is down when a service publishes, the message is logged and dropped. That is fine for a notification. It is not fine for `event.cancelled`, which three services act on, so events-service stores it (and `event.rescheduled`, which equipment-service must also act on) in its own `event_outbox` table (migration `0045`) right after the cancellation, publishes it, and retries from a relay (every 10 seconds) until the broker confirms it. The publisher uses a confirm channel, so "published" means the broker accepted the message.

Delivery is at-least-once: a retry reuses the stored `messageId`, so every consumer of `event.cancelled` must be safe to run twice. Today they are (each only matches rows still active). The store is not in the same transaction as the cancellation, so a crash between the two can still lose the message; the window is far smaller than a broker outage.

### Known limitations

**Consumers never reconnect.** The four consuming services (notification, registration, venue and equipment) connect to RabbitMQ once, at startup. If RabbitMQ isn't accepting connections at that moment, or the connection drops later, the consumer stops for good. The team decided on 2026-10-31 not to fix this before the code freeze: writing reconnection code, or switching to a reconnecting library such as `amqp-connection-manager`, would mean retesting every service that uses RabbitMQ.

What happens, as tested with the full Docker stack on 2026-10-31:

| When | notification-service, registration-service | venue-service, equipment-service |
|---|---|---|
| RabbitMQ isn't accepting connections yet when the service starts | Logs `failed to connect to RabbitMQ, consumer idle` and never retries | Same |
| RabbitMQ shuts down normally (e.g. `docker compose restart rabbitmq`) | Nothing crashes and nothing is logged; the consumer stops | Same |
| The connection breaks abruptly (RabbitMQ is killed, or the network fails) | Logs the error and keeps running; the consumer stops | No `error` listener, so the process crashes. Docker's `restart: unless-stopped` restarts it, but if RabbitMQ isn't back yet it fails to connect and stays idle; under `npm run dev` it stays down |

In every case the REST API keeps answering and `/health` returns `{"ok":true}`, so neither a healthcheck nor Docker's restart policy notices, and no consumer comes back on its own. While a consumer is stopped nobody is notified, and a cancelled event's bookings, equipment and registrations are not released.

Publishers connect on their first publish. registration-service's and chat-service's reconnect on their next publish after a drop. events-service's, venue-service's and equipment-service's have no `error` listener, so an abrupt drop while one is connected ends that process too.

Workaround: once RabbitMQ is accepting connections again, restart all four consumers: `docker compose restart notification-service registration-service venue-service equipment-service`, or stop and rerun `npm run dev`. Queues are durable and messages are published as persistent, so whatever reached a queue while its consumer was stopped is processed after the restart. Messages published while RabbitMQ itself was down are dropped, except those events-service sends through its outbox (above).

**A failed role lookup holds back the whole notification.** A message can name users and roles together, e.g. `event.cancelled` for an event with no coordinator yet goes to the Organiser and to every `coordinator_lead`. notification-service asks user-service who holds each role before writing anything. If that lookup fails, the message goes to `notification-service.dlq` and nobody on it is notified, including the users it names. This is deliberate: before, a failed lookup was treated as "nobody holds this role" and the message was acked and lost. Nothing replays the DLQ automatically; dead-lettered messages can be inspected in the management UI (section 6).

## 5. Backlog alignment

Every message above traces to an acceptance criterion or an E7-2 matrix row. The last gaps were closed on 2026-10-10: E7-2 (#62) gained rows for booking withdrawals, cancelled equipment requests, attendee withdrawals and pending bookings hit by unavailability, and E6-4 (#57) gained the withdrawal notification criterion.

## 6. Running it locally

```bash
docker compose up -d rabbitmq
```

(from the repo root, using `docker-compose.yml`; `docker compose down` stops it, and a named volume keeps queue state across restarts.)

Wait until RabbitMQ is ready before starting the services, since a consumer that can't connect at startup never retries (Known limitations, section 4). It is ready once `docker logs connectsphere-rabbitmq` shows `Server startup complete`, a few seconds after the container starts.

The management UI is at `http://localhost:15672` (guest / guest), where queues, bindings and dead-lettered messages can be inspected. Per AGENTS.md section 5, adding `RABBITMQ_URL` means updating `backend/.env.example` and `backend/README.md` in the same change.
