workspace "ConnectSphere - C3 Events Service" "Level 3 of the C4 model. Components of the events service (E2, E3): the event, its status machine and everything that moves it." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly." "Vue 3, TypeScript, Vite, Tailwind"

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

                authMiddleware = component "Auth middleware" "Checks the caller's sign-in token on every request and notes who they are and their role. One route also accepts trusted calls from other services." "src/middleware/auth.ts, src/lib/jwt.ts"

                internalGuard = component "Internal route guard" "Lets in only trusted calls from other services, on routes no user may call." "src/middleware/internal.ts, src/lib/internalAuth.ts"

                publicController = component "Public events controller" "Shows guests, without signing in, the confirmed events open for registration." "src/routes/publicEvents.ts"

                requestsController = component "Requests controller" "Handles event requests: organisers submit and edit them, and each role sees the events it is allowed to. Edits stop after Planning, and every edit is recorded." "src/routes/events/requests.ts"

                draftsController = component "Drafts controller" "Lets organisers save, resume and delete drafts. Nobody else sees a draft until it is submitted." "src/routes/events/drafts.ts"

                assignmentController = component "Assignment controller" "Lets the Coordinator Lead see unassigned requests and assign or reassign a coordinator. If two Leads act at once, only one succeeds." "src/routes/events/assignment.ts"

                reviewController = component "Review controller" "Lets the assigned coordinator ask the organiser questions, then approve the request into Planning or reject it with a reason." "src/routes/events/review.ts"

                safetyController = component "Safety review controller" "Handles the safety review: the coordinator submits the event with safety notes, and the Safety Officer approves, rejects or asks for changes." "src/routes/events/safetyReview.ts"

                changeController = component "Change request controller" "Handles change requests on a confirmed event. Minor changes apply at once; major ones wait for the coordinator, who sees what they would affect." "src/routes/events/changeRequests.ts"

                lifecycleController = component "Lifecycle controller" "Lets the organiser cancel an event with a reason, and the coordinator mark it completed once it has ended." "src/routes/events/lifecycle.ts"

                registrationController = component "Registration settings controller" "Lets the coordinator set when registration opens, or force it open or closed. Also tells registration-service what attendees may see." "src/routes/events/registration.ts"

                internalController = component "Arrangements-changed handler" "Gives other services event timing and status, and handles reports of lost venues or equipment by sending the event back for review." "src/routes/events/internal.ts"

                # --- Rules ----------------------------------------------------

                eventStatus = component "Event status constants" "The event statuses, in one place. A status change only succeeds if the event is still in the status it was checked in." "src/lib/eventStatus.ts"

                requestValidator = component "Request validator" "Checks a request is complete and sensible (no past dates, end after start, attendance above zero) and reports every problem at once." "src/lib/validateEventRequest.ts, src/lib/validation.ts"

                historyDiff = component "Details differ" "Compares old and new event details, to record each changed field in the history and summarise an organiser's reply." "src/lib/diffSubmittedDetails.ts"

                eventTiming = component "Event timing" "Works out when an event starts and ends in Singapore time, and whether it has." "src/lib/eventTiming.ts"

                safetyRules = component "Safety review gate" "Checks every venue and equipment arrangement is settled before an event can go to safety review, and names anything outstanding." "src/lib/safetyReview.ts"

                safetyChangeRules = component "Safety change rules" "Tracks which arrangements the Safety Officer asked to change, and notices when each one has been changed." "src/lib/safetyChanges.ts"

                changeRules = component "Change request rules" "Decides which fields are major (date, time, attendance, venue, equipment, accessibility) and must wait for the coordinator's approval." "src/lib/changeRequestFields.ts, src/lib/changeRequestStatus.ts"

                registrationPeriod = component "Registration period" "Works out whether registration is not yet open, open or closed, fresh on every read. It closes five days before the event unless the coordinator overrides it." "src/lib/registrationPeriod.ts"

                reschedule = component "Reschedule announcer" "Spots when an event's date, time or attendance changes, and announces it so venue and equipment services can re-check their bookings." "src/lib/reschedule.ts"

                # --- Outbound -------------------------------------------------

                outbox = component "Outbox relay" "Makes sure messages other services must act on, like a cancellation, get delivered: each is stored first and retried until the broker confirms it." "src/lib/outbox.ts"

                publisher = component "Event publisher" "Announces event changes on the message broker once each change is saved, so other services can react." "src/lib/rabbitPublisher.ts, amqplib"

                usersClient = component "Users client" "Asks user-service for the list of active coordinators." "src/lib/usersClient.ts"

                arrangementsClient = component "Arrangements client" "Asks venue and equipment services about an event's bookings and equipment, and flags them when an approved change affects them." "src/lib/arrangementsClient.ts"

                registrationsClient = component "Registrations client" "Asks registration-service who has registered, to show how a change would affect them." "src/lib/registrationsClient.ts"

                dataAccess = component "Supabase client" "Reads and writes events, their history, clarifications, safety reviews and change requests. Also reads organiser and coordinator names straight from the users table." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        # =====================================================================
        # Callers
        # =====================================================================

        connectsphere.spa -> connectsphere.events.authMiddleware   "Calls the events APIs with the user's bearer token" "JSON over HTTPS"
        connectsphere.spa -> connectsphere.events.publicController "Shows public events to guests, no token" "JSON over HTTPS"

        connectsphere.venue        -> connectsphere.events.authMiddleware "Reads an event and its booking info, forwarding the caller's token" "JSON over HTTP"
        connectsphere.venue        -> connectsphere.events.internalGuard  "Reports a lost venue booking" "JSON over HTTP, internal token"
        connectsphere.venue        -> connectsphere.events.publicController "Reads public events for its public venue pages" "JSON over HTTP"
        connectsphere.equipment    -> connectsphere.events.authMiddleware "Reads an event and its booking info, forwarding the caller's token" "JSON over HTTP"
        connectsphere.equipment    -> connectsphere.events.internalGuard  "Reports a lost equipment reservation" "JSON over HTTP, internal token"
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
        connectsphere.events.authMiddleware -> connectsphere.events.internalController     "Passes requests for event timing"
        connectsphere.events.authMiddleware -> connectsphere.events.internalGuard          "Checks trusted service calls"
        connectsphere.events.internalGuard  -> connectsphere.events.internalController     "Passes lost-arrangement reports"

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
        connectsphere.events.assignmentController   -> connectsphere.events.dataAccess "Saves the coordinator and the assignment history"
        connectsphere.events.reviewController       -> connectsphere.events.dataAccess "Writes the decision and clarification threads"
        connectsphere.events.safetyController       -> connectsphere.events.dataAccess "Saves safety submissions and decisions"
        connectsphere.events.changeController       -> connectsphere.events.dataAccess "Reads and writes change requests and applied fields"
        connectsphere.events.lifecycleController    -> connectsphere.events.dataAccess "Writes the status and history"
        connectsphere.events.registrationController -> connectsphere.events.dataAccess "Writes the open date and override"
        connectsphere.events.publicController       -> connectsphere.events.dataAccess "Reads Confirmed events"
        connectsphere.events.internalController     -> connectsphere.events.dataAccess "Saves the status; marks the safety approval out of date"
        connectsphere.events.outbox                 -> connectsphere.events.dataAccess "Stores messages until they are sent"

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
