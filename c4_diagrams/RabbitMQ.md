# RabbitMQ messaging: ConnectSphere

**Version 1.0** | 2026-10-10 | Tricia Lee (@triciaa-leee)

The message catalogue behind the broker in `c2-containers.dsl` and the publishers and consumers in `c3-components.dsl`. It traces every notification requirement to the message that delivers it. The rules every publisher and consumer must follow are in `ArchitectureDecisionRecord.md` section 4; the decision to use RabbitMQ is D6 there.

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
| `events-service` | `booking.replacement_required` | Returns a `Safety Review` or `Confirmed` event to `Planning` (AGENTS.md section 3, re-review) |
| `venue-service` | `event.cancelled` | Withdraws every active booking of the event (E3-6) |
| `equipment-service` | `event.cancelled`, `change.decided` | Releases reservations (E3-6) or re-checks them after a date, time or duration change (E5-6 AC3) |
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
| 11 | Event returns to `Planning` for re-review | `event.rereview` | Assigned coordinator, Organiser; safety officers if it was in `Safety Review` | Wk4 A20 "important event changes"; AGENTS.md section 3 (assumption A9) |
| 12 | Organiser raises a change request | `change.requested` | Assigned coordinator | Wk4 A20 "important event changes"; E3-9 AC1 |
| 13 | Coordinator decides a change request | `change.decided` | Organiser; venue staff of affected bookings and Technical Support if venue or equipment is affected | E3-11 AC1 to AC4 |
| 14 | Organiser cancels the event | `event.cancelled` (with reason) | Organiser (confirmation); assigned coordinator with the reason (leads if `Unassigned`) | Wk4 A20 "cancellation"; E3-6 AC1 |

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

### 3.4 Equipment (equipment-service)

| # | Trigger | Message | Recipients | Source |
|---|---|---|---|---|
| 26 | Coordinator raises an equipment request | `equipment.requested` | Technical Support | E5-1 AC1 |
| 27 | Coordinator amends types or quantities | `equipment.amended` (what changed) | Technical Support | E5-2 AC1 (Team; not in Wk4 or Wk7) |
| 28 | Technical Support changes the request's status, including reserving or partly fulfilling it | `equipment.status_changed` | Assigned coordinator | E5-3 AC1, AC2 |
| 29 | Item marked unusable while reserved | `equipment.unusable` | Assigned coordinator | E5-5 AC2 |
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
| 33 | Bookings withdrawn because the event was cancelled | `booking.withdrawn` (`reason: event_cancelled`) | The venue's staff member | Wk4 A20 "cancellation"; E3-6 AC2; E7-2 |
| 34 | Reservations released because the event was cancelled | `equipment.released` (`reason: event_cancelled`) | Technical Support | Wk4 A20 "cancellation"; E3-6 AC3; E7-2 |
| 35 | Registrations cancelled because the event was cancelled | `registration.cancelled_by_event` | Every registered attendee | Wk4 A20 "cancellation"; E3-6 AC4; E7-2 |

An event with no bookings, equipment or registrations produces only `event.cancelled`.

## 4. Messages consumed for something other than notifications

| Message | Consumer | What it does |
|---|---|---|
| `booking.replacement_required` | events-service | Moves a `Safety Review` or `Confirmed` event back to `Planning`, then publishes `event.rereview` (#11) |
| `event.cancelled` | venue-service | Withdraws every active booking, then publishes #33 |
| `event.cancelled` | equipment-service | Releases reservations, then publishes #34 |
| `event.cancelled` | registration-service | Cancels registrations, then publishes #35 |
| `change.decided` | equipment-service | Re-checks reservations when the date, time or duration changed (E5-6 AC3); a reservation that no longer holds is published as `equipment.status_changed` |

## 5. Backlog alignment

Every message above traces to an acceptance criterion or an E7-2 matrix row. The last gaps were closed on 2026-10-10: E7-2 (#62) gained rows for booking withdrawals, cancelled equipment requests, attendee withdrawals and pending bookings hit by unavailability, and E6-4 (#57) gained the withdrawal notification criterion.

## 6. Running it locally

```bash
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 rabbitmq:3-management
```

The management UI is at `http://localhost:15672` (guest / guest), where queues, bindings and dead-lettered messages can be inspected. Per AGENTS.md section 5, adding `RABBITMQ_URL` means updating `backend/.env.example` and `backend/README.md` in the same change.
