/*
 * ConnectSphere end-to-end scenarios: the single source for every swimlane page.
 *
 * Each step names the lane (role) that acts, the status it changes, the
 * microservices behind it, the important notifications, and the Playwright
 * tests (frontend/e2e) that exercise it. Steps were derived from the code and
 * AGENTS.md, not from the tests; tests were then mapped onto them, so a step
 * with no test is a real coverage gap.
 *
 * How steps become a BPMN diagram (assets/render.js):
 *   steps follow each other in order unless they say otherwise;
 *   after: null      - starts a new flow from its own start event (startLabel)
 *   after: "<id>"    - follows that step instead; if it already has a next step,
 *                      an exclusive gateway is drawn (its question is the source
 *                      step's `decision`, its paths the phases' `label`)
 *   alongside: "<id>" - a new flow drawn beside that step rather than after everything
 *   parallel: true   - the phase's steps sit between a parallel split and join
 *   endLabel         - text under the end event (default: the status reached)
 *
 * Test modes:
 *   ui    - the browser performs this step's action
 *   check - the action goes through the API (e2e/support/backend.ts) and the
 *           browser only checks what the user sees afterwards
 *   api   - REST calls only, no browser
 */
window.SWIMLANE_DATA = {
  lanes: {
    guest: { label: "Guest", note: "Not signed in" },
    attendee: { label: "Attendee", note: "Self-registers" },
    organiser: { label: "Organiser", note: "Self-registers" },
    lead: { label: "Event Coordinator Lead", note: "Assigns work" },
    coordinator: { label: "Event Coordinator", note: "Assigned to the event" },
    venue_staff: { label: "Venue Staff", note: "Looks after venues" },
    technical_support: { label: "Technical Support", note: "Looks after equipment" },
    safety_officer: { label: "Safety Officer", note: "Operational safety check" },
    system: { label: "ConnectSphere Online", note: "Automatic steps" },
  },
  laneOrder: [
    "organiser",
    "lead",
    "coordinator",
    "venue_staff",
    "technical_support",
    "safety_officer",
    "attendee",
    "guest",
    "system",
  ],

  // Every Playwright test in frontend/e2e (screenshots.e2e.ts is a capture
  // script, not a test, so it is left out).
  tests: {
    "auth.landing": { spec: "auth.e2e.ts", name: "Login lands every role on its own page (one test per role, 7 tests)", mode: "ui" },
    "auth.wrong": { spec: "auth.e2e.ts", name: "a wrong password is rejected with a generic error, not a field-specific one", mode: "ui" },
    "auth.protected": { spec: "auth.e2e.ts", name: "visiting a protected route while signed out redirects to login", mode: "ui" },
    "auth.already": { spec: "auth.e2e.ts", name: "signing in already-authenticated and visiting /login redirects to the role's landing page", mode: "ui" },
    "roles.guard": { spec: "role-access.e2e.ts", name: "<role> visiting <path> is redirected away, not shown the page (21 routes)", mode: "ui" },

    "draft.form": { spec: "drafts.e2e.ts", name: "saving a draft from the form skips validation and lands it on the Drafts tab", mode: "ui" },
    "draft.private": { spec: "drafts.e2e.ts", name: "only its organiser can see a draft — not a coordinator, not the Lead", mode: "api" },
    "draft.submit": { spec: "drafts.e2e.ts", name: "submitting a draft validates it, then moves it into Unassigned", mode: "api" },
    "draft.delete": { spec: "drafts.e2e.ts", name: "a deleted draft is gone, and only its organiser can delete it", mode: "api" },

    "form.submit": { spec: "event-request-form.e2e.ts", name: "organiser submits a request through the form; it lands in Unassigned and in the Lead's queue", mode: "ui" },
    "form.empty": { spec: "event-request-form.e2e.ts", name: "submitting an empty form shows required-field errors and creates nothing", mode: "ui" },
    "form.times": { spec: "event-request-form.e2e.ts", name: "an end time before the start time is refused with a message on the end time", mode: "ui" },

    "life.happy": { spec: "event-lifecycle.e2e.ts", name: "submit -> assign -> approve -> safety review -> confirm, each visible in the right place", mode: "check" },
    "life.reject": { spec: "event-lifecycle.e2e.ts", name: "coordinator rejects a request -> Rejected, visible on the event page", mode: "check" },

    "rules.stranger-read": { spec: "lifecycle-rules.e2e.ts", name: "another organiser can't read someone else's event", mode: "api" },
    "rules.unassigned-approve": { spec: "lifecycle-rules.e2e.ts", name: "a coordinator can't approve before the Lead assigns anyone", mode: "api" },
    "rules.only-assigned": { spec: "lifecycle-rules.e2e.ts", name: "only the assigned coordinator can act, not another coordinator", mode: "api" },
    "rules.stranger-cancel": { spec: "lifecycle-rules.e2e.ts", name: "another organiser can't cancel someone else's event", mode: "api" },
    "rules.skip-safety": { spec: "lifecycle-rules.e2e.ts", name: "Planning can't skip Safety Review, and can't be submitted for it without a venue", mode: "api" },
    "rules.rejected-terminal": { spec: "lifecycle-rules.e2e.ts", name: "Rejected is terminal: it can't be approved or cancelled afterwards", mode: "api" },
    "rules.clarify-block": { spec: "lifecycle-rules.e2e.ts", name: "a coordinator can't approve while a clarification is outstanding", mode: "api" },
    "rules.reasons": { spec: "lifecycle-rules.e2e.ts", name: "cancelling and safety rejection both need a reason", mode: "api" },
    "rules.clarify-requested": { spec: "lifecycle-rules.e2e.ts", name: "asked during Requested: the organiser's answer puts it back to Requested", mode: "api" },
    "rules.clarify-planning": { spec: "lifecycle-rules.e2e.ts", name: "asked during Planning: the answer puts it back to Planning, not Requested", mode: "api" },
    "rules.edit-unassigned": { spec: "lifecycle-rules.e2e.ts", name: "the organiser can edit while Unassigned, and the edit is stored", mode: "api" },
    "rules.edit-invalid": { spec: "lifecycle-rules.e2e.ts", name: "an invalid edit is refused and changes nothing", mode: "api" },
    "rules.coord-edit-early": { spec: "lifecycle-rules.e2e.ts", name: "the coordinator can't edit before Planning", mode: "api" },
    "rules.edit-confirmed": { spec: "lifecycle-rules.e2e.ts", name: "nobody can edit a Confirmed event directly", mode: "api" },
    "rules.reassign": { spec: "lifecycle-rules.e2e.ts", name: "moves the event to the new coordinator without changing its status, and records who it was", mode: "api" },
    "rules.reassign-closed": { spec: "lifecycle-rules.e2e.ts", name: "closed events can't be reassigned", mode: "api" },

    "notif.assign": { spec: "notifications.e2e.ts", name: "Lead assigning a coordinator notifies that coordinator, visible in their feed", mode: "check" },

    "chat.flow": { spec: "chat.e2e.ts", name: "organiser and coordinator chat; unread counts and the other side's notification follow", mode: "api" },
    "chat.private": { spec: "chat.e2e.ts", name: "nobody outside the event can read or post in its chat", mode: "api" },

    "venue.ui": { spec: "venue-booking.e2e.ts", name: "coordinator requests a venue through the search page, then Venue Staff approves it", mode: "ui" },
    "venue.conflict": { spec: "venue-booking.e2e.ts", name: "approving one of two overlapping requests auto-rejects the other, and blocks new ones", mode: "api" },
    "hold.block": { spec: "venue-holds.e2e.ts", name: "a hold blocks the venue for 72 hours and auto-rejects the overlapping request; it can then be approved", mode: "api" },
    "hold.expire": { spec: "venue-holds.e2e.ts", name: "a lapsed hold is Expired, can't be approved, and no longer blocks the venue", mode: "api", local: true },

    "equip.form": { spec: "equipment.e2e.ts", name: "coordinator records equipment requirements via the form; Technical Support sees the request", mode: "ui" },
    "equip.reserve": { spec: "equipment-reservation.e2e.ts", name: "safety review waits for equipment to be reserved; reserving takes it out of stock", mode: "api" },
    "equip.toomany": { spec: "equipment-reservation.e2e.ts", name: "reserving more than is in stock is refused and takes nothing", mode: "api" },
    "equip.cancel": { spec: "equipment-reservation.e2e.ts", name: "cancelling an event returns its reserved equipment to stock", mode: "api" },

    "safety.changes": { spec: "safety-changes.e2e.ts", name: "requesting changes flags the named booking, returns the event to Planning, and the flag clears once it's addressed", mode: "api" },
    "safety.invalid": { spec: "safety-changes.e2e.ts", name: "requesting changes is refused without an arrangement, without a note, or for another event's booking", mode: "api" },
    "safety.reject": { spec: "safety-changes.e2e.ts", name: "rejecting the safety arrangement needs a reason and returns the event to Planning", mode: "api" },

    "arr.confirmed": { spec: "arrangements-changed.e2e.ts", name: "blocking out a Confirmed event's venue cancels the booking and sends the event to Needs Review", mode: "api" },
    "arr.review": { spec: "arrangements-changed.e2e.ts", name: "blocking out the venue of an event under Safety Review sends it back to Planning", mode: "api" },
    "arr.otherday": { spec: "arrangements-changed.e2e.ts", name: "a block-out on another day leaves the booking and the event alone", mode: "api" },

    "cr.noncritical": { spec: "change-requests.e2e.ts", name: "a non-critical change applies at once and the event stays Confirmed", mode: "api" },
    "cr.reject": { spec: "change-requests.e2e.ts", name: "a critical change is held, moves the event to Needs Review, and a rejection restores Confirmed unchanged", mode: "api" },
    "cr.approve": { spec: "change-requests.e2e.ts", name: "approving a critical change applies it, and the event must pass safety review again", mode: "api" },
    "cr.refused": { spec: "change-requests.e2e.ts", name: "change requests are refused before Confirmed and from anyone but the owner", mode: "api" },

    "complete.early": { spec: "completion.e2e.ts", name: "an event can't be completed before it ends", mode: "api" },
    "complete.after": { spec: "completion.e2e.ts", name: "once it has ended, only its coordinator can complete it; it's then terminal and keeps its booking", mode: "api", local: true },

    "cancel.ui": { spec: "cancellation.e2e.ts", name: "organiser cancels a Confirmed event; bookings, registrations and notifications all follow", mode: "ui" },
    "rejectrel": { spec: "reject-releases-arrangements.e2e.ts", name: "rejecting a Planning event through a clarification releases its venue booking and equipment", mode: "api" },

    "reg.ui": { spec: "attendee-registration.e2e.ts", name: "attendee discovers a Confirmed, registration-open event and registers for it", mode: "ui" },
    "reg.rules": { spec: "attendee-registration.e2e.ts", name: "registration refuses not-yet-open, duplicate and over-capacity sign-ups; a withdrawal frees the place", mode: "api" },

    "public.guest": { spec: "public-pages.e2e.ts", name: "a guest sees an open event and is sent to sign up to register; unlisted events stay hidden", mode: "ui" },
    "public.venues": { spec: "public-pages.e2e.ts", name: "a signed-out visitor can browse venues without an account", mode: "ui" },
  },

  // Tests that check a rule across every scenario rather than one step.
  crossCutting: {
    "auth.wrong": "Sign-in security: applies to every role's first step.",
    "auth.protected": "Route guard: every signed-in page in every scenario.",
    "auth.already": "Route guard: every signed-in page in every scenario.",
    "roles.guard": "Route guard: each role only reaches its own screens, in every scenario.",
    "rules.stranger-read": "Ownership: an Organiser only ever sees their own events.",
  },

  scenarios: [
    // ---------------------------------------------------------------- 1
    {
      id: "s1",
      file: "scenario-1-happy-path.html",
      title: "From setup to a completed event",
      short: "Happy path",
      summary:
        "The full journey with nothing going wrong: staff set up venues and equipment, an Organiser requests an event, it is assigned, planned, passes the safety check, attendees register, and the coordinator closes it after it runs.",
      starts: "No event yet",
      ends: "Completed",
      phases: [
        {
          title: "Setup (done once, before any event)",
          note: "These three happen independently of each other.",
          parallel: true,
          steps: [
            {
              lane: "organiser",
              after: null,
              title: "Sign up and sign in",
              detail:
                "Only Organisers and Attendees can sign up. Coordinator, Lead, Venue Staff, Technical Support and Safety Officer accounts are created for them. Each role lands on its own home page after signing in.",
              services: ["user-service"],
              tests: [{ t: "auth.landing" }],
              flags: [
                { kind: "gap", text: "Every test creates its Organiser through the sign-up API; the sign-up form itself is never filled in by Playwright." },
              ],
            },
            {
              lane: "venue_staff",
              after: null,
              title: "Add a venue to the catalogue",
              detail:
                "Venue catalogue: capacity, layouts, facilities, accessibility, and setup and turnaround minutes. The venue's own staff member is the only person who can decide its bookings.",
              services: ["venue-service"],
              tests: [],
            },
            {
              lane: "technical_support",
              after: null,
              title: "Add equipment to the inventory",
              detail:
                "Equipment inventory: create a catalog item and add stock (physical units). Available stock is worked out per day from the units reserved that day.",
              services: ["equipment-service"],
              tests: [],
            },
          ],
        },
        {
          title: "Request and assignment",
          steps: [
            {
              lane: "organiser",
              title: "Save the request as a draft",
              state: { event: ["—", "Draft"] },
              detail:
                "New request form → Save as Draft. Not validated yet. Only the Organiser can see it, and it can be edited or deleted. Drafts sit outside the lifecycle.",
              services: ["events-service"],
              tests: [{ t: "draft.form" }, { t: "draft.private" }, { t: "draft.delete" }],
            },
            {
              lane: "organiser",
              title: "Submit the request",
              state: { event: ["Draft", "Unassigned"] },
              detail:
                "Full validation on submit (required fields, end time after start time). Submitting without a draft also lands in Unassigned. Nobody is assigned automatically.",
              notifies: ["Event Coordinator Lead (new request)", "Organiser (receipt)"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "form.submit" }, { t: "form.empty" }, { t: "form.times" }, { t: "draft.submit" }],
            },
            {
              lane: "lead",
              title: "Assign a coordinator",
              state: { event: ["Unassigned", "Requested"] },
              detail:
                "Lead dashboard → Unassigned queue → Assign to an active coordinator. Refused if the event already has one. A coordinator cannot act before this.",
              notifies: ["Assigned coordinator", "Organiser"],
              services: ["events-service", "user-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "life.happy", mode: "check" }, { t: "notif.assign" }, { t: "rules.unassigned-approve" }],
            },
            {
              lane: "coordinator",
              id: "s1-approve",
              title: "Review and approve the request",
              state: { event: ["Requested", "Planning"] },
              detail:
                "My workload → event page → Approve. Only the assigned coordinator can approve, reject or ask for clarification.",
              notifies: ["Organiser (approved)"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "life.happy", mode: "check" }, { t: "rules.only-assigned" }],
            },
          ],
        },
        {
          title: "Planning: venue and equipment",
          steps: [
            {
              lane: "organiser",
              id: "s1-chat",
              after: null,
              alongside: "s1-approve",
              startLabel: "Event in Planning",
              endLabel: "Chat stays open",
              title: "Chat with the coordinator (any time from here)",
              detail:
                "A private chat between the Organiser and the assigned coordinator, open in Planning, Confirmed and Needs Review. Nobody else can read it, not even the Lead.",
              notifies: ["The other party (new message)"],
              services: ["chat-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "chat.flow" }, { t: "chat.private" }],
            },
            {
              lane: "coordinator",
              after: "s1-approve",
              title: "Find and request a venue",
              state: { booking: ["—", "Requested"] },
              detail:
                "Venue search opened from the event: suitability for the booking's purpose and headcount, plus an availability calendar. A Requested booking does not block the venue, so others can request the same slot.",
              notifies: ["That venue's Venue Staff"],
              services: ["venue-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "venue.ui" }],
            },
            {
              lane: "venue_staff",
              title: "Approve the booking",
              state: { booking: ["Requested", "Approved"] },
              detail:
                "Venue schedule → Requests tab → Approve. Conflicts and block-outs are checked again first. (Hold and reject: Scenario 3.)",
              notifies: ["Coordinator"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "venue.ui" }],
            },
            {
              lane: "coordinator",
              title: "Record equipment requirements",
              state: { equipment: ["—", "Requested"] },
              detail:
                "Event page → Arrangements → Add Equipment Request: catalog item and quantity. Only allowed in Planning or Needs Review.",
              notifies: ["Technical Support"],
              services: ["equipment-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "equip.form" }],
            },
            {
              lane: "technical_support",
              title: "Reserve the equipment",
              state: { equipment: ["Requested", "Arranged"] },
              detail:
                "Equipment requests → event → Arranged reserves units for the event's time window, so that day's available stock drops. Asking for more than is in stock is refused and reserves nothing. Partially Fulfilled needs a note.",
              notifies: ["Coordinator"],
              services: ["equipment-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "equip.form", mode: "ui" }, { t: "equip.reserve" }, { t: "equip.toomany" }],
            },
            {
              lane: "system",
              title: "Check the event is ready for safety review",
              detail:
                "Submitting is refused, naming what is outstanding, until every venue booking is Approved and all requested equipment is reserved. Equipment counts as requested whenever the Organiser's equipment field isn't NA or None.",
              services: ["events-service", "venue-service", "equipment-service"],
              tests: [{ t: "rules.skip-safety" }, { t: "equip.reserve" }],
            },
            {
              lane: "coordinator",
              title: "Submit for safety review",
              state: { event: ["Planning", "Safety Review"] },
              detail:
                "Required safety notes: equipment placement, crowd movement, emergency access and venue restrictions.",
              notifies: ["Safety Officers", "Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "life.happy", mode: "api" }],
            },
          ],
        },
        {
          title: "Safety review",
          steps: [
            {
              lane: "safety_officer",
              title: "Approve the safety arrangements",
              state: { event: ["Safety Review", "Confirmed"] },
              detail:
                "Safety review queue → Approve. Records who approved and when. There is no way from Planning to Confirmed that skips this. (Request changes or reject: Scenario 2.)",
              notifies: ["Coordinator", "Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "life.happy", mode: "check" }, { t: "rules.skip-safety" }],
            },
          ],
        },
        {
          title: "Registration and the event",
          steps: [
            {
              lane: "coordinator",
              title: "Set the registration open date",
              detail:
                "For Confirmed events that need registration. The date must fall before the 5-day cutoff. Until it arrives, attendees and guests can't see the event.",
              services: ["events-service"],
              tests: [{ t: "reg.ui", mode: "api" }, { t: "public.guest", mode: "api" }],
            },
            {
              lane: "guest",
              title: "Browse public events and sign up",
              detail:
                "Explore events → event → Sign up to register → sign-up page, then back to the event. Unopened or unconfirmed events look exactly like ones that don't exist. Venues can be browsed too.",
              services: ["events-service", "venue-service", "user-service"],
              tests: [{ t: "public.guest" }, { t: "public.venues" }],
            },
            {
              lane: "attendee",
              title: "Discover the event and register",
              state: { registration: ["—", "Registered"] },
              detail:
                "Discover → event page → Register. Places are counted under a per-event lock so two attendees can't take the last place. The event then shows under My events.",
              notifies: ["Attendee (confirmation)"],
              services: ["registration-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "reg.ui" }],
            },
            {
              lane: "system",
              title: "Close registration; the event takes place",
              detail:
                "Registration state is worked out on every read, not scheduled: it closes 5 days before the start (Singapore time) and always at the start.",
              services: ["events-service", "registration-service"],
              tests: [],
            },
            {
              lane: "coordinator",
              title: "Mark the event completed",
              state: { event: ["Confirmed", "Completed"] },
              detail:
                "Mark as completed is only allowed once the end time has passed (Singapore time), and never happens automatically. Bookings, reservations, registrations and history are all kept. Terminal.",
              services: ["events-service"],
              tests: [{ t: "complete.early" }, { t: "complete.after" }],
            },
          ],
        },
      ],
    },

    // ---------------------------------------------------------------- 2
    {
      id: "s2",
      file: "scenario-2-before-confirmation.html",
      title: "Getting it right before confirmation",
      short: "Clarifications, reassignment and safety pushback",
      summary:
        "The loops an event can go through before it is Confirmed: the coordinator asks questions (before and after approving), the Lead hands the event to another coordinator, a date change invalidates a booking, and the Safety Officer pushes back twice.",
      starts: "Unassigned",
      ends: "Confirmed",
      phases: [
        {
          title: "Clarification while Requested",
          steps: [
            {
              lane: "organiser",
              after: null,
              startLabel: "Organiser needs an event",
              title: "Submit the request",
              state: { event: ["—", "Unassigned"] },
              detail: "As in Scenario 1. The Organiser can still edit it directly while Unassigned or Requested.",
              services: ["events-service"],
              tests: [{ t: "rules.edit-unassigned" }, { t: "rules.edit-invalid" }],
            },
            {
              lane: "lead",
              title: "Assign Coordinator One",
              state: { event: ["Unassigned", "Requested"] },
              detail: "Lead dashboard → Unassigned queue → Assign.",
              notifies: ["Coordinator One", "Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "rules.clarify-requested" }],
            },
            {
              lane: "coordinator",
              title: "Ask the Organiser for clarification",
              state: { event: ["Requested", "Clarification Requested"] },
              detail:
                "Request clarification with a message. The event remembers it came from Requested. More questions can be added to the thread; Approve is blocked while any is unresolved.",
              notifies: ["Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "rules.clarify-requested" }, { t: "rules.clarify-block" }],
            },
            {
              lane: "organiser",
              title: "Edit and respond",
              state: { event: ["Clarification Requested", "Requested"] },
              detail:
                "Edit & respond saves the changed details, posts them as a reply in the thread, and returns the event to the status it came from.",
              notifies: ["Coordinator"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "rules.clarify-requested" }],
              flags: [
                {
                  kind: "spec",
                  text:
                    "The code has a second way out: once the coordinator marks every question resolved, Approve is enabled and moves the event straight from Clarification Requested to Planning, even when it came from Requested and the Organiser never responded (events-service review.ts approve route; EventDetailView.vue). AGENTS.md §3 says Clarification Requested must return to the status it came from. No Playwright test covers this path.",
                },
              ],
            },
          ],
        },
        {
          title: "Reassignment",
          steps: [
            {
              lane: "lead",
              title: "Reassign to Coordinator Two",
              state: { event: ["Requested", "Requested"] },
              detail:
                "Event page → Reassign. Status is unchanged; only the coordinator changes. Allowed in every status except Rejected, Cancelled and Completed. Reassigning to the same coordinator is refused. History records the old and new coordinator.",
              notifies: ["Organiser", "Previous coordinator", "New coordinator"],
              services: ["events-service", "user-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "rules.reassign" }, { t: "rules.reassign-closed" }],
            },
            {
              lane: "coordinator",
              title: "Coordinator Two approves",
              state: { event: ["Requested", "Planning"] },
              detail: "Coordinator One is now refused (403) for every action on this event.",
              notifies: ["Organiser (approved)"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "rules.reassign" }, { t: "rules.only-assigned" }],
            },
          ],
        },
        {
          title: "Planning: follow-up question and a date change",
          steps: [
            {
              lane: "coordinator",
              title: "Ask a follow-up question",
              state: { event: ["Planning", "Clarification Requested"] },
              detail: "Same as before, but the event now remembers it came from Planning.",
              notifies: ["Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "rules.clarify-planning" }],
            },
            {
              lane: "organiser",
              title: "Respond",
              state: { event: ["Clarification Requested", "Planning"] },
              detail: "Back to Planning, not Requested.",
              notifies: ["Coordinator"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "rules.clarify-planning" }],
            },
            {
              lane: "coordinator",
              title: "Arrange a venue and equipment",
              state: { booking: ["—", "Approved"], equipment: ["—", "Arranged"] },
              detail: "As in Scenario 1, steps 9–12.",
              services: ["venue-service", "equipment-service"],
              tests: [{ t: "venue.ui" }, { t: "equip.reserve" }],
            },
            {
              lane: "coordinator",
              title: "Change the event's date and time",
              state: { event: ["Planning", "Planning"] },
              detail:
                "In Planning both the Organiser and the assigned coordinator can edit any field (the coordinator can't before Planning). Every change goes into the event history.",
              services: ["events-service", "RabbitMQ"],
              tests: [{ t: "rules.coord-edit-early" }],
            },
            {
              lane: "system",
              title: "Re-check the bookings and equipment",
              state: { booking: ["Approved", "Replacement Required"] },
              detail:
                "A date, time or attendance change is announced to the other services. venue-service turns an Approved booking that no longer fits (block-out, clash or capacity) into Replacement Required; pending bookings are only reported. equipment-service flags reservations that now clash. The edit itself always saves.",
              notifies: ["Coordinator (booking no longer fits)", "Technical Support and coordinator (equipment clash)"],
              services: ["events-service", "RabbitMQ", "venue-service", "equipment-service", "notification-service"],
              tests: [],
            },
            {
              lane: "coordinator",
              title: "Request a replacement venue and release the old booking",
              state: { booking: ["Replacement Required", "Withdrawn"] },
              detail:
                "Find replacement → request another venue (Venue Staff approve it as usual) → release the flagged booking. The released row stays on the event for history.",
              notifies: ["Venue Staff (booking released)"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [],
            },
          ],
        },
        {
          title: "Safety pushback",
          steps: [
            {
              lane: "coordinator",
              title: "Submit for safety review",
              state: { event: ["Planning", "Safety Review"] },
              detail: "With the four required safety notes.",
              notifies: ["Safety Officers", "Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "safety.changes" }],
            },
            {
              lane: "safety_officer",
              title: "Request changes",
              state: { event: ["Safety Review", "Planning"] },
              detail:
                "Pick at least one of this event's venue bookings or equipment items, each with a note on what must change, plus an optional general note. Each one is flagged for the coordinator.",
              notifies: ["Coordinator"],
              services: ["events-service", "venue-service", "equipment-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "safety.changes" }, { t: "safety.invalid" }],
            },
            {
              lane: "coordinator",
              title: "Address the flagged arrangements",
              detail:
                "For example, release the flagged booking and book another room. A flag clears once its arrangement no longer matches. Open flags don't block resubmitting; the Safety Officer sees which were addressed.",
              services: ["venue-service", "events-service"],
              tests: [{ t: "safety.changes" }],
            },
            {
              lane: "coordinator",
              title: "Resubmit for safety review",
              state: { event: ["Planning", "Safety Review"] },
              detail: "Same checks and notes as the first submission.",
              notifies: ["Safety Officers", "Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "safety.reject" }],
            },
            {
              lane: "safety_officer",
              title: "Reject the safety arrangement",
              state: { event: ["Safety Review", "Planning"] },
              detail: "The other non-approve outcome. A reason is required. The event becomes editable again.",
              notifies: ["Coordinator"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "safety.reject" }],
            },
            {
              lane: "coordinator",
              title: "Fix and resubmit",
              state: { event: ["Planning", "Safety Review"] },
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [],
            },
            {
              lane: "safety_officer",
              title: "Approve",
              state: { event: ["Safety Review", "Confirmed"] },
              notifies: ["Coordinator", "Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "life.happy", mode: "api" }],
            },
          ],
        },
      ],
    },

    // ---------------------------------------------------------------- 3
    {
      id: "s3",
      file: "scenario-3-venue-contention.html",
      title: "Competing for a venue",
      short: "Holds, auto-rejection and expiry",
      summary:
        "Three events in Planning want the same room at the same time. Shows the rule that the first booking to reach On Hold or Approved wins, the 72-hour hold, what happens when a hold lapses, and how a venue's own changes affect existing bookings.",
      starts: "Three events in Planning",
      ends: "One booking Approved (or the hold Expired)",
      phases: [
        {
          title: "Venue Staff change a venue",
          steps: [
            {
              lane: "venue_staff",
              after: null,
              startLabel: "Venue details change",
              endLabel: "Clashes flagged",
              title: "Change setup/turnaround time or capacity",
              detail:
                "Venue catalogue → edit, with a preview first. Bookings that now clash under the longer occupied window (start − setup to end + turnaround) are flagged, never removed. A capacity cut below an event's attendance warns its coordinator.",
              notifies: ["Venue Staff and coordinator (setup clash)", "Coordinator (capacity reduced)"],
              services: ["venue-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [],
            },
          ],
        },
        {
          title: "Three events want the same room",
          steps: [
            {
              lane: "coordinator",
              after: null,
              title: "Request the same venue for Events A and B",
              state: { booking: ["—", "Requested (A and B)"] },
              detail:
                "Venue availability calendar → request. Requested bookings don't block the venue, so both are accepted.",
              notifies: ["Venue Staff"],
              services: ["venue-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "hold.block" }, { t: "venue.conflict" }],
            },
            {
              lane: "venue_staff",
              title: "Put Event A's booking on hold",
              state: { booking: ["Requested", "On Hold"] },
              detail:
                "Only if the venue is free for the window and the event is in Planning or Needs Review. The hold lasts a fixed 72 hours.",
              notifies: ["Coordinator"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "hold.block" }],
            },
            {
              lane: "system",
              title: "Auto-reject the overlapping request",
              state: { booking: ["Requested (B)", "Rejected"] },
              detail:
                "Reason: \"Venue no longer available for this period\". Decisions on one venue are made one at a time and re-checked after writing, so of two simultaneous decisions only the first succeeds.",
              notifies: ["Event B's coordinator (request another venue or time)"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "hold.block" }, { t: "venue.conflict" }],
              flags: [{ kind: "gap", text: "The \"two decisions at the same moment\" race has no Playwright test." }],
            },
            {
              lane: "coordinator",
              id: "s3-c",
              decision: "Hold decided within 72 hours?",
              title: "Request the same venue for Event C",
              detail: "Refused at submission (409), showing the conflicting window.",
              services: ["venue-service", "events-service"],
              tests: [{ t: "hold.block" }, { t: "venue.conflict" }],
            },
          ],
        },
        {
          title: "Branch A: the hold is confirmed in time",
          label: "yes",
          steps: [
            {
              lane: "venue_staff",
              id: "s3-approve",
              title: "Approve the held booking",
              state: { booking: ["On Hold", "Approved"] },
              detail: "The expiry time is cleared. Approving straight from Requested is also allowed when there's no conflict.",
              notifies: ["Coordinator"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "hold.block" }, { t: "venue.conflict" }],
            },
          ],
        },
        {
          title: "Branch B: the hold lapses",
          label: "no",
          steps: [
            {
              lane: "system",
              after: "s3-c",
              title: "Warn the coordinator before the hold expires",
              detail: "venue-service runs a periodic sweep over holds that are about to lapse.",
              notifies: ["Coordinator (hold expiring)"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [],
            },
            {
              lane: "system",
              title: "Expire the hold",
              state: { booking: ["On Hold", "Expired"] },
              detail:
                "Applied on any read as well as by the sweep, so a lapsed hold never blocks the venue. Requests it auto-rejected (Event B) are not revived.",
              notifies: ["Coordinator (hold expired)"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "hold.expire" }],
            },
            {
              lane: "venue_staff",
              title: "Try to approve the expired booking",
              detail: "Refused (409): an Expired booking can't be approved, held or rejected.",
              services: ["venue-service"],
              tests: [{ t: "hold.expire" }],
            },
            {
              lane: "coordinator",
              endLabel: "Event C requested",
              title: "Request the venue again for Event C",
              state: { booking: ["—", "Requested"] },
              detail: "Accepted now that nothing blocks the window.",
              services: ["venue-service", "events-service"],
              tests: [{ t: "hold.expire" }],
            },
          ],
        },
        {
          title: "Other ways a booking ends",
          note: "Independent of the branches above.",
          steps: [
            {
              lane: "coordinator",
              after: null,
              startLabel: "Booking no longer needed",
              title: "Withdraw a request or release an approved booking",
              state: { booking: ["Requested / On Hold / Approved", "Withdrawn"] },
              detail: "The event's other bookings are untouched. The row stays for history.",
              notifies: ["Venue Staff"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "safety.changes" }],
            },
            {
              lane: "venue_staff",
              after: null,
              startLabel: "Venue can't take it",
              title: "Reject a request with a reason",
              state: { booking: ["Requested / On Hold", "Rejected"] },
              detail: "A reason is required. There is no coordinator override; to try again the coordinator makes a new request.",
              notifies: ["Coordinator"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [],
            },
          ],
        },
      ],
    },

    // ---------------------------------------------------------------- 4
    {
      id: "s4",
      file: "scenario-4-after-confirmation.html",
      title: "After confirmation",
      short: "Change requests and lost arrangements",
      summary:
        "A Confirmed event can no longer be edited directly. Shows the Organiser's change requests, a venue that becomes unavailable, and equipment that breaks — each moves the event to Needs Review until the coordinator settles it and it passes safety review again.",
      starts: "Confirmed",
      ends: "Confirmed",
      phases: [
        {
          title: "Non-critical change",
          steps: [
            {
              lane: "organiser",
              after: null,
              title: "Request a change to a non-critical field",
              state: { event: ["Confirmed", "Confirmed"] },
              detail:
                "Event page → Request a change (direct edits are refused once past Planning). Non-critical fields such as purpose or description apply at once. Only the owner can raise one, and only on a Confirmed or Needs Review event.",
              services: ["events-service"],
              tests: [{ t: "cr.noncritical" }, { t: "rules.edit-confirmed" }, { t: "cr.refused" }],
            },
          ],
        },
        {
          title: "Critical change",
          steps: [
            {
              lane: "organiser",
              title: "Request a change to a critical field",
              state: { event: ["Confirmed", "Needs Review"] },
              detail:
                "Date/time, attendance, venue, equipment or accessibility are held for the coordinator, not applied. While in Needs Review, registration closes and the event leaves Discover; existing registrations are kept.",
              notifies: ["Coordinator"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "cr.reject" }, { t: "cr.approve" }],
              flags: [
                { kind: "assumption", text: "Confirmed → Needs Review is marked as an assumption in AGENTS.md §3 (Week 7 changes 2, 3 and 6), not yet confirmed with the customer." },
                { kind: "gap", text: "No test checks that registration closes while the event is in Needs Review." },
              ],
            },
            {
              lane: "coordinator",
              id: "s4-impact",
              decision: "Approve the change?",
              title: "Review the impact",
              detail: "Shows the bookings, equipment reservations and registrations the change would affect, and any capacity conflict.",
              services: ["events-service", "venue-service", "equipment-service", "registration-service"],
              tests: [],
            },
          ],
        },
        {
          title: "Branch A: the coordinator rejects it",
          label: "reject",
          steps: [
            {
              lane: "coordinator",
              title: "Reject the change request",
              state: { event: ["Needs Review", "Confirmed"] },
              detail:
                "A reason is required. Goes straight back to Confirmed because nothing the Safety Officer approved has changed. Nothing is applied.",
              notifies: ["Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "cr.reject" }],
            },
          ],
        },
        {
          title: "Branch B: the coordinator approves it",
          label: "approve",
          steps: [
            {
              lane: "coordinator",
              after: "s4-impact",
              title: "Approve the change (all or some fields)",
              state: { event: ["Needs Review", "Needs Review"], booking: ["Approved", "Replacement Required"] },
              detail:
                "Approved fields are applied and written to history, and the safety approval no longer holds. A booking the change invalidates (e.g. attendance now over capacity) becomes Replacement Required. Equipment requests are flagged for Technical Support to reassess.",
              notifies: ["Organiser", "Venue Staff (rebooking)", "Technical Support (reassess)"],
              services: ["events-service", "venue-service", "equipment-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "cr.approve" }],
              flags: [{ kind: "gap", text: "Approving only some fields, and the booking / equipment flags, have no Playwright test." }],
            },
            {
              lane: "coordinator",
              title: "Replace the venue and settle the equipment",
              detail:
                "Request a new venue (Venue Staff approve it), release the Replacement Required booking, and amend the equipment request if needed.",
              services: ["venue-service", "equipment-service"],
              tests: [],
            },
            {
              lane: "coordinator",
              title: "Resubmit for safety review",
              state: { event: ["Needs Review", "Safety Review"] },
              detail:
                "Only once every change request is decided and all bookings and equipment are settled. Safety notes are required again.",
              notifies: ["Safety Officers", "Organiser"],
              services: ["events-service", "venue-service", "equipment-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "cr.approve" }],
            },
            {
              lane: "safety_officer",
              title: "Approve again",
              state: { event: ["Safety Review", "Confirmed"] },
              detail: "Registration opens again.",
              notifies: ["Coordinator", "Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [],
            },
          ],
        },
        {
          title: "The venue becomes unavailable",
          steps: [
            {
              lane: "venue_staff",
              after: null,
              title: "Block out the venue for a period",
              detail:
                "Venue schedule → block-out, with a reason (maintenance, equipment failure, renovation, safety, other): all day, or the same hours each day. A preview shows the affected bookings first. A block-out on another day changes nothing.",
              services: ["venue-service"],
              tests: [{ t: "arr.confirmed" }, { t: "arr.otherday" }],
            },
            {
              lane: "system",
              title: "Cancel the clashing booking and flag the event",
              state: { booking: ["Approved", "Cancelled"], event: ["Confirmed", "Needs Review"] },
              detail:
                "The event itself is never cancelled. If it was still in Safety Review it goes back to Planning instead, and the Safety Officer is told too. Pending bookings keep their status.",
              notifies: ["Coordinator (replacement needed)", "Organiser"],
              services: ["venue-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "arr.confirmed" }, { t: "arr.review" }],
              flags: [{ kind: "assumption", text: "Both moves (Confirmed → Needs Review, Safety Review → Planning) are marked as assumptions in AGENTS.md §3." }],
            },
            {
              lane: "coordinator",
              title: "Find a replacement venue",
              state: { booking: ["—", "Requested"] },
              detail:
                "The Cancelled booking stays on the event with its reason and a Find replacement button. The blocked venue is refused (409) for that window.",
              notifies: ["Venue Staff"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "arr.confirmed" }],
            },
            {
              lane: "venue_staff",
              title: "Approve the replacement",
              state: { booking: ["Requested", "Approved"] },
              notifies: ["Coordinator"],
              services: ["venue-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "arr.confirmed" }],
            },
            {
              lane: "coordinator",
              title: "Resubmit for safety review",
              state: { event: ["Needs Review", "Safety Review"] },
              detail: "Then the Safety Officer approves and the event is Confirmed again, as in Branch B.",
              notifies: ["Safety Officers", "Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "arr.confirmed" }],
            },
          ],
        },
        {
          title: "Equipment becomes unusable",
          steps: [
            {
              lane: "technical_support",
              after: null,
              title: "Mark units damaged or under maintenance",
              detail:
                "Equipment maintenance: choose the type and how many units, preview which units and events are affected, then confirm. Those units are never offered for that period.",
              notifies: ["Coordinator of each affected event"],
              services: ["equipment-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [],
            },
            {
              lane: "system",
              title: "Flag the event",
              state: { event: ["Confirmed", "Needs Review"] },
              detail: "equipment-service reports the lost arrangement to events-service. The reservation is flagged for Technical Support to re-arrange.",
              notifies: ["Coordinator", "Organiser"],
              services: ["equipment-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [],
              flags: [{ kind: "assumption", text: "Same AGENTS.md §3 assumption as the venue case." }],
            },
            {
              lane: "technical_support",
              endLabel: "Ready to resubmit",
              title: "Re-arrange with other units",
              detail: "Then the coordinator resubmits for safety review as above.",
              services: ["equipment-service"],
              tests: [],
            },
          ],
        },
      ],
    },

    // ---------------------------------------------------------------- 5
    {
      id: "s5",
      file: "scenario-5-ending-early.html",
      title: "Ending early, and the attendee's side",
      short: "Rejection, registration rules and cancellation",
      summary:
        "The ways an event stops before it runs — rejected by the coordinator, or cancelled by the Organiser — and what the system releases and who it tells. Also the registration rules attendees run into on a Confirmed event.",
      starts: "Requested, Planning or Confirmed",
      ends: "Rejected or Cancelled",
      phases: [
        {
          title: "Rejected at review",
          steps: [
            {
              lane: "coordinator",
              after: null,
              startLabel: "Request under review",
              title: "Reject the request",
              state: { event: ["Requested", "Rejected"] },
              detail:
                "A reason is required. Terminal: no approving, cancelling or reassigning afterwards. There is no direct Planning → Rejected.",
              notifies: ["Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "life.reject" }, { t: "rules.rejected-terminal" }, { t: "rules.reassign-closed" }],
            },
          ],
        },
        {
          title: "Rejected through a clarification during Planning",
          steps: [
            {
              lane: "coordinator",
              after: null,
              title: "Ask a question on a Planning event that already holds a venue and equipment",
              state: { event: ["Planning", "Clarification Requested"] },
              notifies: ["Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "rejectrel" }],
            },
            {
              lane: "coordinator",
              title: "Reject it",
              state: { event: ["Clarification Requested", "Rejected"] },
              detail: "For when the answer shows the event can't go ahead. The reason goes into the event history.",
              notifies: ["Organiser"],
              services: ["events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "rejectrel" }],
            },
            {
              lane: "system",
              endLabel: "Arrangements released",
              title: "Release everything the event held",
              state: { booking: ["Approved", "Withdrawn"], equipment: ["Reserved units", "Returned to stock"] },
              detail: "venue-service and equipment-service each act on the event.rejected message. Rows are kept for history.",
              notifies: ["Venue Staff", "Technical Support"],
              services: ["events-service", "RabbitMQ", "venue-service", "equipment-service", "notification-service"],
              tests: [{ t: "rejectrel" }],
            },
          ],
        },
        {
          title: "Registration rules on a Confirmed event",
          steps: [
            {
              lane: "attendee",
              after: null,
              title: "Try to register before registration opens",
              detail: "Refused (409) until the coordinator's open date arrives.",
              services: ["registration-service", "events-service"],
              tests: [{ t: "reg.rules" }],
            },
            {
              lane: "coordinator",
              title: "Set the open date",
              services: ["events-service"],
              tests: [{ t: "reg.rules" }],
            },
            {
              lane: "attendee",
              title: "Register",
              state: { registration: ["—", "Registered"] },
              detail:
                "Registering twice is refused. Once the number registered reaches the expected attendance, the event is full and further sign-ups are refused.",
              notifies: ["Attendee"],
              services: ["registration-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "reg.rules" }],
            },
            {
              lane: "attendee",
              title: "Withdraw",
              state: { registration: ["Registered", "Withdrawn"] },
              detail:
                "Any time before the start. The place frees at once and another attendee can take it, but inside the last 5 days registration stays closed unless the coordinator forces it open. After the start: refused.",
              notifies: ["Attendee"],
              services: ["registration-service", "events-service", "RabbitMQ", "notification-service"],
              tests: [{ t: "reg.rules" }],
            },
            {
              lane: "coordinator",
              endLabel: "Registration managed",
              title: "Force registration open or closed, or back to automatic",
              detail: "Confirmed events only. The event start always closes registration, even when forced open.",
              services: ["events-service"],
              tests: [],
            },
          ],
        },
        {
          title: "The Organiser cancels",
          steps: [
            {
              lane: "organiser",
              after: null,
              title: "Cancel the event with a reason",
              state: { event: ["Confirmed", "Cancelled"] },
              detail:
                "Event page → Cancel event. Allowed from any active status, with no approval needed. Confirm stays disabled until a reason is typed. Only the owner can cancel. Terminal: no edits, change requests or completion afterwards.",
              services: ["events-service", "RabbitMQ"],
              tests: [{ t: "cancel.ui" }, { t: "rules.reasons" }, { t: "rules.stranger-cancel" }, { t: "complete.after" }],
            },
            {
              lane: "system",
              endLabel: "Event Cancelled",
              title: "Release everything and tell everyone",
              state: { booking: ["Approved", "Withdrawn"], registration: ["Registered", "Cancelled"] },
              detail:
                "One event.cancelled message: venue-service withdraws the bookings, equipment-service returns the units to stock, and registration-service marks every registration Cancelled (not Withdrawn — the attendee didn't give it up).",
              notifies: ["Coordinator, with the reason (the Lead if still Unassigned)", "Registered attendees", "Venue Staff", "Technical Support"],
              services: ["events-service", "RabbitMQ", "venue-service", "equipment-service", "registration-service", "notification-service"],
              tests: [{ t: "cancel.ui", mode: "api" }, { t: "equip.cancel" }],
              flags: [{ kind: "gap", text: "The tests check the coordinator's and attendee's notifications, but not Venue Staff's or Technical Support's." }],
            },
          ],
        },
      ],
    },
  ],
};
