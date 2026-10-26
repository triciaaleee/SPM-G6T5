workspace "ConnectSphere - C3 Registration Service" "Level 3 of the C4 model. Components of the registration service (E6): attendee registrations and withdrawals." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly at its own base URL (VITE_REGISTRATION_API_URL for this one)." "Vue 3, TypeScript, Vite, Tailwind"

            user = container "User service" "E1. Accounts, login, the JWT and the role directory. Port 4002." "Express 5, TypeScript"

            events = container "Events service" "E2 and E3. The event, its status machine and the registration period. Port 4001." "Express 5, TypeScript"

            venue = container "Venue service" "E4. Venues and venue bookings. Port 4003." "Express 5, TypeScript"

            broker = container "Message broker" "Topic exchange connectsphere.events." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance; each service owns its own tables." "Supabase Postgres" "Database"

            # =================================================================
            # Registration service (E6), port 4007
            # Owns the registrations table and nothing else. Event details,
            # venue names and user names come from their owners over REST.
            # =================================================================

            registration = container "Registration service" "E6. Attendee discovery, registration, withdrawal and rosters. Port 4007." "Express 5, TypeScript" {

                authMiddleware = component "Auth middleware" "Verifies the bearer token with the shared JWT_SECRET and attaches the caller's id and role; routes check role and ownership themselves." "src/middleware/auth.ts, src/lib/jwt.ts"

                discoveryController = component "Discovery controller" "Attendee only. GET /open-events: events open for registration with places left and the caller's own status; GET /user/:userId: the caller's own registrations; GET /event/:eventId/view: one event as an attendee sees it, only if they hold or held a place or registration has opened." "src/routes/registrations.ts" "Wide"

                registerController = component "Registration controller" "Attendee only. POST / registers for an open event, reusing the attendee's row after a withdrawal; PATCH /event/:eventId/withdraw gives the place up any time before the event starts, keeping the row as Withdrawn." "src/routes/registrations.ts"

                rosterController = component "Roster controller" "GET /event/:eventId: everyone registered for an event, with names. Closed to attendees; the owning organiser or a coordinator is admitted by events-service's own rule. Also read by events-service for a change request's capacity impact." "src/routes/registrations.ts" "Wide"

                placeCounter = component "Place counter" "Counts Registered places per event (only the count leaves the service), works out places left, and shows an OPEN event with no places left as FULL." "src/routes/registrations.ts"

                registrationStatus = component "Registration status constants" "Registered, Withdrawn and Cancelled, spelled as the registration_status enum. Cancelled means the organiser cancelled the whole event and is final." "src/lib/registrationStatus.ts" "Wide"

                consumer = component "Message consumer" "Durable queue registration-service with a dead-letter queue, bound to event.cancelled; acks only after the handler succeeds." "src/lib/rabbitConsumer.ts, amqplib"

                cancellation = component "Event cancellation handler" "event.cancelled: every Registered place for the event becomes Cancelled, then each attendee is told with registration.cancelled_by_event. Idempotent on redelivery." "src/lib/eventCancelledHandler.ts" "Wide"

                publisher = component "Event publisher" "Publishes to connectsphere.events after the write commits; best effort. registration.confirmed, registration.withdrawn, registration.cancelled_by_event." "src/lib/rabbitPublisher.ts, amqplib"

                eventsClient = component "Events client" "Reads the attendee-facing whitelist of events (attendee-info, open-for-registration), the registration state and whether the event has started, and checks roster access. Forwards the caller's token." "src/lib/eventsClient.ts"

                venuesClient = component "Venues client" "Venue names of each event's Approved bookings, forwarding the caller's token." "src/lib/venuesClient.ts"

                usersClient = component "Users client" "Display names for a roster, forwarding the caller's token. Best effort: the roster still renders with ids alone." "src/lib/usersClient.ts"

                dataAccess = component "Supabase client" "Service-role client; bypasses RLS, so routes enforce access. Table: registrations. Registering goes through register_for_event, which counts and writes under a per-event advisory lock so two attendees cannot take the last place." "src/lib/supabaseAdmin.ts, supabase-js" "Wide"
            }
        }

        # =====================================================================
        # Callers
        # =====================================================================

        connectsphere.spa    -> connectsphere.registration.authMiddleware "Calls /api/registrations with the user's bearer token" "JSON over HTTPS"
        connectsphere.events -> connectsphere.registration.authMiddleware "Reads an event's registrations, forwarding the caller's token" "JSON over HTTP"
        connectsphere.broker -> connectsphere.registration.consumer       "Delivers event.cancelled" "AMQP"

        # =====================================================================
        # Inside the service
        # =====================================================================

        connectsphere.registration.authMiddleware -> connectsphere.registration.discoveryController "Passes the authenticated request"
        connectsphere.registration.authMiddleware -> connectsphere.registration.registerController  "Passes the authenticated request"
        connectsphere.registration.authMiddleware -> connectsphere.registration.rosterController    "Passes the authenticated request"

        connectsphere.registration.discoveryController -> connectsphere.registration.placeCounter "Shows places left and FULL"
        connectsphere.registration.discoveryController -> connectsphere.registration.eventsClient "Reads the events the attendee may see"
        connectsphere.registration.discoveryController -> connectsphere.registration.venuesClient "Reads where each event is held"

        connectsphere.registration.registerController -> connectsphere.registration.eventsClient       "Checks registration is open, or the event has not started"
        connectsphere.registration.registerController -> connectsphere.registration.registrationStatus "Sets Registered or Withdrawn"
        connectsphere.registration.registerController -> connectsphere.registration.publisher          "Emits registration.confirmed, registration.withdrawn"

        connectsphere.registration.rosterController -> connectsphere.registration.eventsClient "Checks the caller may see the event"
        connectsphere.registration.rosterController -> connectsphere.registration.usersClient  "Reads attendee names"

        connectsphere.registration.consumer     -> connectsphere.registration.cancellation       "Hands over event.cancelled"
        connectsphere.registration.cancellation -> connectsphere.registration.registrationStatus "Moves Registered places to Cancelled"
        connectsphere.registration.cancellation -> connectsphere.registration.publisher          "Emits registration.cancelled_by_event"

        connectsphere.registration.discoveryController -> connectsphere.registration.dataAccess "Reads the caller's registrations"
        connectsphere.registration.registerController  -> connectsphere.registration.dataAccess "Calls register_for_event; writes withdrawals"
        connectsphere.registration.rosterController    -> connectsphere.registration.dataAccess "Reads the event's registrations"
        connectsphere.registration.placeCounter        -> connectsphere.registration.dataAccess "Counts Registered rows"
        connectsphere.registration.cancellation        -> connectsphere.registration.dataAccess "Cancels the event's places"

        # =====================================================================
        # Leaving the service
        # =====================================================================

        connectsphere.registration.dataAccess   -> connectsphere.db     "Reads and writes registrations" "supabase-js"
        connectsphere.registration.publisher    -> connectsphere.broker "Publishes domain events" "AMQP"
        connectsphere.registration.eventsClient -> connectsphere.events "Reads attendee-info, open-for-registration and single events" "JSON over HTTP"
        connectsphere.registration.venuesClient -> connectsphere.venue  "GET /api/venues/attendee-info" "JSON over HTTP"
        connectsphere.registration.usersClient  -> connectsphere.user   "GET /api/users/names" "JSON over HTTP"
    }

    views {

        component connectsphere.registration "C3-RegistrationService" "Components of the registration service (E6). Owns registrations only; the registration period itself is derived by events-service." {
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
