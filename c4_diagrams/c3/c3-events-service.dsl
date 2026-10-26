workspace "ConnectSphere - C3 Events Service" "Level 3 of the C4 model. Components of the events service (E2, E3): the event, its status machine and everything that moves it." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly at its own base URL (VITE_EVENTS_API_URL for this one)." "Vue 3, TypeScript, Vite, Tailwind"

            user = container "User service" "E1. Accounts, login, the JWT and the role directory. Port 4002." "Express 5, TypeScript"

            venue = container "Venue service" "E4. Venues, unavailability and venue bookings. Port 4003." "Express 5, TypeScript"

            equipment = container "Equipment service" "E5. Equipment requests, inventory and reservations. Port 4005." "Express 5, TypeScript"

            registration = container "Registration service" "E6. Attendee registrations. Port 4007." "Express 5, TypeScript"

            chat = container "Chat service" "Organiser and coordinator chat. Port 4006." "Express 5, TypeScript"

            broker = container "Message broker" "Topic exchange connectsphere.events." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance; each service owns its own tables." "Supabase Postgres" "Database"

            # =================================================================
            # Events service (E2, E3), port 4001
            # Owns the event and every event status transition.
            # Publishes only; it has no broker queue of its own. Lost venue or
            # equipment arrangements are reported to it over REST instead.
            # =================================================================

            events = container "Events service" "E2 and E3. The event, its status machine and everything that moves it. Port 4001." "Express 5, TypeScript" {

                # --- Entry points -------------------------------------------

                authMiddleware = component "Auth middleware" "requireAuth verifies the bearer token with the shared JWT_SECRET and attaches the caller's id and role; every 401 carries a code so an expired session reads differently from a bad token. requireAuthOrInternal also admits a sibling service's internal token on GET /venue-booking-info. Routes check role and ownership themselves." "src/middleware/auth.ts, src/lib/jwt.ts" "Wide"

                internalGuard = component "Internal route guard" "requireInternal: admits only a sibling service's short-lived X-Internal-Auth token, signed with INTERNAL_SERVICE_SECRET (separate from JWT_SECRET). No end-user token is accepted." "src/middleware/internal.ts, src/lib/internalAuth.ts"

                publicController = component "Public events controller" "GET /api/events/public and /public/:id, no login. Confirmed events whose registration has opened, with the attendee whitelist minus capacity, so a guest can look before signing up." "src/routes/publicEvents.ts"

                requestsController = component "Requests controller" "POST / submits into Unassigned (organiser only), GET / and GET /:id by role (Lead sees every submitted event, read only), PATCH /:id within the edit rules (Organiser up to Planning, assigned coordinator every field in Planning, nobody after), which also submits a draft and answers a clarification, GET /:id/history. Denied direct-URL attempts are recorded in access_denials." "src/routes/events.ts" "Detailed"

                draftsController = component "Drafts controller" "POST /draft, PATCH /:id/draft and DELETE /:id/draft. Saves with relaxed validation and never assigns anyone; only the owning organiser, only while still Draft. Drafts are invisible to every internal role." "src/routes/events.ts"

                assignmentController = component "Assignment controller" "Coordinator Lead only. GET /unassigned (oldest first), POST /:id/assign (Unassigned to Requested) and POST /:id/reassign (any non-terminal status). Conditional updates mean two Leads acting at once give one success and one 409." "src/routes/events.ts" "Wide"

                reviewController = component "Review controller" "Assigned coordinator's review: POST /:id/request-clarification, the clarification threads (ask, reply, resolve), POST /:id/approve to Planning and POST /:id/reject with a required reason." "src/routes/events.ts"

                safetyController = component "Safety review controller" "POST /:id/submit-safety-review from Planning or Needs Review with required safety notes; GET /safety-review-queue for the Safety Officer; approve, reject and request-changes; GET /:id/safety-reviews and /:id/safety-changes. Each write is one Postgres function: submit_event_for_safety_review, approve_, reject_event_safety_review, request_event_safety_changes." "src/routes/events.ts" "Detailed"

                changeController = component "Change request controller" "POST and GET /:id/change-requests, approve and reject. Non-critical fields apply at once; critical ones are held and move a Confirmed event to Needs Review. The coordinator's view carries an impact assessment of affected bookings, reservations and registrations. Approving flags invalidated bookings and equipment in their own services; rejecting the last open request with no stale approval returns the event to Confirmed." "src/routes/events.ts" "Detailed"

                lifecycleController = component "Lifecycle controller" "POST /:id/cancel: the owning Organiser cancels from any active status with a required reason; nothing else is released here, the other services react to event.cancelled. POST /:id/complete: the assigned coordinator closes a Confirmed event once its end time has passed." "src/routes/events.ts" "Wide"

                registrationController = component "Registration settings controller" "Assigned coordinator only: PUT /:id/registration sets the opening date; POST /:id/registration/open, /close and /auto set the override (Confirmed only). GET /attendee-info and GET /open-for-registration return the attendee whitelist for registration-service (E6, AGENTS.md section 3b)." "src/routes/events.ts" "Wide"

                internalController = component "Arrangements-changed handler" "GET /venue-booking-info gives venue and equipment services each event's timing, attendance, status and coordinator. POST /:id/arrangements-changed (internal only): a lost venue or equipment arrangement moves Confirmed to Needs Review or Safety Review back to Planning, and sets safety_approval_stale." "src/routes/events.ts" "Wide"

                # --- Rules ----------------------------------------------------

                eventStatus = component "Event status constants" "The 11 statuses spelled as the event_status enum, and the closed (terminal) set. Each route checks the allowed from-status itself and writes with a conditional update on the current status, so an illegal or raced transition returns 409." "src/lib/eventStatus.ts"

                requestValidator = component "Request validator" "Mandatory fields, no past dates, end after start, attendance above zero; collects every field error in one pass. Also normalises a draft and checks route ids." "src/lib/validateEventRequest.ts, src/lib/validation.ts"

                historyDiff = component "Details differ" "Field-by-field diff of submitted_details: a readable summary posted as the organiser's clarification reply, and field, old value and new value rows for event_history." "src/lib/diffSubmittedDetails.ts"

                eventTiming = component "Event timing" "Reads an event's local date and times as Singapore time (UTC+8): when it starts and ends, and whether it has. Used by completion, withdrawal and registration." "src/lib/eventTiming.ts"

                safetyRules = component "Safety review gate" "What blocks entering Safety Review: no approved venue booking, bookings still Requested, On Hold or Replacement Required, or equipment not fully reserved, each named. Parses the four required safety notes." "src/lib/safetyReview.ts"

                safetyChangeRules = component "Safety change rules" "Request-changes flags: which live arrangements can be flagged, a snapshot of each, the combined reason, and when a flag has cleared because its booking or equipment item changed." "src/lib/safetyChanges.ts"

                changeRules = component "Change request rules" "The critical fields held for review (date and time, attendance, venue, equipment, accessibility), the committed baseline of a field, and the change_requests status values including Auto-Withdrawn." "src/lib/changeRequestFields.ts, src/lib/changeRequestStatus.ts"

                registrationPeriod = component "Registration period" "Derives NOT_OPEN, OPEN or CLOSED on every read from the open date and override: FORCE_CLOSED, then the event start, then FORCE_OPEN, then the 5-day cutoff. No stored state and no scheduler; registration-service turns OPEN into FULL." "src/lib/registrationPeriod.ts" "Wide"

                reschedule = component "Reschedule announcer" "Detects a change to the date, start or end time, or expected attendance, and announces event.rescheduled or event.attendance_changed through the outbox so venue and equipment services re-check their bookings." "src/lib/reschedule.ts" "Wide"

                # --- Outbound -------------------------------------------------

                outbox = component "Outbox relay" "Reliable publishing for messages another service must act on (event.cancelled, event.rescheduled, event.attendance_changed). Stores the message in event_outbox after the write it announces, publishes it, and a timer started in index.ts retries until the broker confirms. Retries reuse the message id." "src/lib/outbox.ts" "Wide"

                publisher = component "Event publisher" "Publishes to connectsphere.events after the write commits; best effort, never throws. Direct: request.submitted, request.edited, coordinator.assigned, coordinator.reassigned, clarification.requested, clarification.answered, request.decided, safety.submitted, safety.decided, change.requested, change.withdrawn, change.decided, event.needs_review, event.returned_to_planning." "src/lib/rabbitPublisher.ts, amqplib" "Detailed"

                usersClient = component "Users client" "Lists active coordinators for assign and reassign, forwarding the Lead's token." "src/lib/usersClient.ts"

                arrangementsClient = component "Arrangements client" "Reads the event's venue bookings and equipment requests, checks a booking against a proposed new schedule, and flags bookings for rebooking and equipment for reassessment after an approved change. Forwards the caller's token." "src/lib/arrangementsClient.ts" "Wide"

                registrationsClient = component "Registrations client" "Reads the event's registrations for a change request's capacity impact, forwarding the caller's token." "src/lib/registrationsClient.ts"

                dataAccess = component "Supabase client" "Service-role client; bypasses RLS, so routes enforce access. Tables: events, event_history, event_clarifications, event_safety_submissions, event_safety_reviews, event_safety_review_flags, change_requests, change_request_fields, event_outbox, access_denials. Event reads also embed the coordinator's and organiser's names through the users foreign keys." "src/lib/supabaseAdmin.ts, supabase-js" "Detailed"
            }
        }

        # =====================================================================
        # Callers
        # =====================================================================

        connectsphere.spa -> connectsphere.events.authMiddleware   "Calls /api/events with the user's bearer token" "JSON over HTTPS"
        connectsphere.spa -> connectsphere.events.publicController "Shows public events to guests, no token" "JSON over HTTPS"

        connectsphere.venue        -> connectsphere.events.authMiddleware "Reads an event and its booking info, forwarding the caller's token" "JSON over HTTP"
        connectsphere.venue        -> connectsphere.events.internalGuard  "Reports a lost venue booking (POST /:id/arrangements-changed)" "JSON over HTTP, internal token"
        connectsphere.venue        -> connectsphere.events.publicController "Reads public events for its public venue pages" "JSON over HTTP"
        connectsphere.equipment    -> connectsphere.events.authMiddleware "Reads an event and its booking info, forwarding the caller's token" "JSON over HTTP"
        connectsphere.equipment    -> connectsphere.events.internalGuard  "Reports a lost equipment reservation (POST /:id/arrangements-changed)" "JSON over HTTP, internal token"
        connectsphere.registration -> connectsphere.events.authMiddleware "Reads attendee-info, open-for-registration and single events" "JSON over HTTP"
        connectsphere.chat         -> connectsphere.events.authMiddleware "Reads an event and the caller's events for the chat inbox" "JSON over HTTP"

        # =====================================================================
        # Entry points to controllers
        # =====================================================================

        connectsphere.events.authMiddleware -> connectsphere.events.requestsController     "Passes the authenticated request"
        connectsphere.events.authMiddleware -> connectsphere.events.draftsController       "Passes the authenticated request"
        connectsphere.events.authMiddleware -> connectsphere.events.assignmentController   "Passes the authenticated request"
        connectsphere.events.authMiddleware -> connectsphere.events.reviewController       "Passes the authenticated request"
        connectsphere.events.authMiddleware -> connectsphere.events.safetyController       "Passes the authenticated request"
        connectsphere.events.authMiddleware -> connectsphere.events.changeController       "Passes the authenticated request"
        connectsphere.events.authMiddleware -> connectsphere.events.lifecycleController    "Passes the authenticated request"
        connectsphere.events.authMiddleware -> connectsphere.events.registrationController "Passes the authenticated request"
        connectsphere.events.authMiddleware -> connectsphere.events.internalController     "Passes GET /venue-booking-info, user or internal token"
        connectsphere.events.authMiddleware -> connectsphere.events.internalGuard          "Verifies an internal token on GET /venue-booking-info"
        connectsphere.events.internalGuard  -> connectsphere.events.internalController     "Passes POST /:id/arrangements-changed"

        # =====================================================================
        # Controllers to rules
        # =====================================================================

        connectsphere.events.requestsController -> connectsphere.events.requestValidator "Validates the request and a draft being submitted"
        connectsphere.events.requestsController -> connectsphere.events.eventStatus      "Checks the status allows this caller to edit"
        connectsphere.events.requestsController -> connectsphere.events.historyDiff      "Records each changed field and builds the clarification reply"
        connectsphere.events.requestsController -> connectsphere.events.reschedule       "Announces a Planning edit to date, time or attendance"
        connectsphere.events.requestsController -> connectsphere.events.publisher        "Emits request.submitted, request.edited, clarification.answered"

        connectsphere.events.draftsController -> connectsphere.events.requestValidator "Normalises the draft without enforcing mandatory fields"

        connectsphere.events.assignmentController -> connectsphere.events.usersClient "Checks the chosen coordinator is active"
        connectsphere.events.assignmentController -> connectsphere.events.eventStatus "Moves Unassigned to Requested; blocks closed events"
        connectsphere.events.assignmentController -> connectsphere.events.publisher   "Emits coordinator.assigned, coordinator.reassigned"

        connectsphere.events.reviewController -> connectsphere.events.eventStatus "Moves to Clarification Requested, Planning or Rejected"
        connectsphere.events.reviewController -> connectsphere.events.publisher   "Emits clarification.requested, request.decided"

        connectsphere.events.safetyController -> connectsphere.events.arrangementsClient "Reads live bookings and equipment before submitting or flagging"
        connectsphere.events.safetyController -> connectsphere.events.safetyRules        "Checks nothing is outstanding and parses the safety notes"
        connectsphere.events.safetyController -> connectsphere.events.safetyChangeRules  "Builds and clears request-changes flags"
        connectsphere.events.safetyController -> connectsphere.events.eventStatus        "Moves to Safety Review, Confirmed or Planning"
        connectsphere.events.safetyController -> connectsphere.events.publisher          "Emits safety.submitted, safety.decided"

        connectsphere.events.changeController -> connectsphere.events.changeRules         "Splits held critical fields from those applied at once"
        connectsphere.events.changeController -> connectsphere.events.arrangementsClient  "Assesses impact and flags invalidated bookings and equipment"
        connectsphere.events.changeController -> connectsphere.events.registrationsClient "Reads registrations against the proposed attendance"
        connectsphere.events.changeController -> connectsphere.events.eventStatus         "Moves Confirmed to Needs Review, or back to Confirmed"
        connectsphere.events.changeController -> connectsphere.events.reschedule          "Announces an approved change to date, time or attendance"
        connectsphere.events.changeController -> connectsphere.events.publisher           "Emits change.requested, change.withdrawn, change.decided"

        connectsphere.events.lifecycleController -> connectsphere.events.eventTiming "Checks the event has ended before completing"
        connectsphere.events.lifecycleController -> connectsphere.events.eventStatus "Moves to Cancelled or Completed"
        connectsphere.events.lifecycleController -> connectsphere.events.outbox      "Emits event.cancelled reliably"

        connectsphere.events.registrationController -> connectsphere.events.registrationPeriod "Derives the registration state and validates the open date"
        connectsphere.events.registrationController -> connectsphere.events.eventTiming        "Reports whether the event has started"
        connectsphere.events.publicController       -> connectsphere.events.registrationPeriod "Lists only events whose registration has opened"

        connectsphere.events.internalController -> connectsphere.events.eventStatus "Moves Confirmed to Needs Review or Safety Review to Planning"
        connectsphere.events.internalController -> connectsphere.events.publisher   "Emits event.needs_review, event.returned_to_planning"

        connectsphere.events.reschedule -> connectsphere.events.outbox    "Stores and relays the announcement"
        connectsphere.events.outbox     -> connectsphere.events.publisher "Publishes and waits for the broker's confirm"

        # =====================================================================
        # Persistence
        # =====================================================================

        connectsphere.events.requestsController     -> connectsphere.events.dataAccess "Reads and writes events, history and clarification replies"
        connectsphere.events.draftsController       -> connectsphere.events.dataAccess "Reads and writes drafts"
        connectsphere.events.assignmentController   -> connectsphere.events.dataAccess "Writes coordinator_id and the assignment history"
        connectsphere.events.reviewController       -> connectsphere.events.dataAccess "Writes the decision and clarification threads"
        connectsphere.events.safetyController       -> connectsphere.events.dataAccess "Calls the safety review Postgres functions"
        connectsphere.events.changeController       -> connectsphere.events.dataAccess "Reads and writes change requests and applied fields"
        connectsphere.events.lifecycleController    -> connectsphere.events.dataAccess "Writes the status and history"
        connectsphere.events.registrationController -> connectsphere.events.dataAccess "Writes the open date and override"
        connectsphere.events.publicController       -> connectsphere.events.dataAccess "Reads Confirmed events"
        connectsphere.events.internalController     -> connectsphere.events.dataAccess "Writes the status and safety_approval_stale"
        connectsphere.events.outbox                 -> connectsphere.events.dataAccess "Stores and clears event_outbox rows"

        # =====================================================================
        # Leaving the service
        # =====================================================================

        connectsphere.events.dataAccess          -> connectsphere.db           "Reads and writes the events-service tables" "supabase-js"
        connectsphere.events.publisher           -> connectsphere.broker       "Publishes domain events" "AMQP"
        connectsphere.events.usersClient         -> connectsphere.user         "GET /api/users?role=coordinator" "JSON over HTTP"
        connectsphere.events.arrangementsClient  -> connectsphere.venue        "Reads bookings, checks availability, flags for rebooking" "JSON over HTTP"
        connectsphere.events.arrangementsClient  -> connectsphere.equipment    "Reads equipment requests, flags for reassessment" "JSON over HTTP"
        connectsphere.events.registrationsClient -> connectsphere.registration "GET /api/registrations/event/:eventId" "JSON over HTTP"
    }

    views {

        component connectsphere.events "C3-EventsService" "Components of the events service (E2, E3). Owns the event and every status transition, from Unassigned through Safety Review and Needs Review to Completed or Cancelled." {
            include *
            autolayout lr
        }

        styles {
            element "Software System" {
                background #534AB7
                color #ffffff
            }
            element "Container" {
                background #534AB7
                color #ffffff
            }
            element "Component" {
                background #AFA9EC
                color #26215C
            }
            element "Wide" {
                width 650
            }
            element "Detailed" {
                width 650
                height 450
            }
            element "Infrastructure" {
                background #D85A30
                color #ffffff
                shape Pipe
            }
            element "Database" {
                background #5F5E5A
                color #ffffff
                shape Cylinder
            }
            relationship "Relationship" {
                thickness 2
            }
        }
    }
}
