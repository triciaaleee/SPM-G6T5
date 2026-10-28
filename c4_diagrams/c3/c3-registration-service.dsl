workspace "ConnectSphere - C3 Registration Service" "Level 3 of the C4 model. Components of the registration service (E6): attendee registrations and withdrawals." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly." "Vue 3, TypeScript, Vite, Tailwind"

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

                authMiddleware = component "Auth middleware" "Checks the caller's sign-in token on every request and notes who they are and their role. Each route then decides what that role may do." "src/middleware/auth.ts, src/lib/jwt.ts"

                discoveryController = component "Discovery controller" "Shows attendees the events open for registration, their own registrations, and an event's details once they may see it." "src/routes/registrations.ts"

                registerController = component "Registration controller" "Lets attendees register for an open event, or withdraw any time before it starts." "src/routes/registrations.ts"

                rosterController = component "Roster controller" "Lists who has registered for an event, for its organiser and coordinators. Attendees cannot see it." "src/routes/registrations.ts"

                placeCounter = component "Place counter" "Counts the places taken for each event, and shows an open event with none left as full." "src/routes/registrations.ts"

                registrationStatus = component "Registration status constants" "The three registration states: Registered, Withdrawn, and Cancelled (when the organiser cancels the whole event)." "src/lib/registrationStatus.ts"

                consumer = component "Message consumer" "Receives event cancellations from the message broker and passes them on. A message is only marked done once handled." "src/lib/rabbitConsumer.ts, amqplib"

                cancellation = component "Event cancellation handler" "When an event is cancelled, cancels every place and tells each attendee. Safe to run twice." "src/lib/eventCancelledHandler.ts"

                publisher = component "Event publisher" "Announces registration changes on the message broker once each change is saved, so other services can react." "src/lib/rabbitPublisher.ts, amqplib"

                eventsClient = component "Events client" "Asks events-service for the event details attendees may see, whether registration is open, and who may view a roster." "src/lib/eventsClient.ts"

                venuesClient = component "Venues client" "Asks venue-service where each event is held." "src/lib/venuesClient.ts"

                usersClient = component "Users client" "Asks user-service for attendees' names for a roster. The roster still shows without them if that fails." "src/lib/usersClient.ts"

                dataAccess = component "Supabase client" "Reads and writes registrations. Registering runs as one database function, so two people can't take the last place." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        # =====================================================================
        # Callers
        # =====================================================================

        connectsphere.spa    -> connectsphere.registration.authMiddleware "Calls the registration APIs with the user's bearer token" "JSON over HTTPS"
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
        connectsphere.registration.registerController  -> connectsphere.registration.dataAccess "Saves registrations and withdrawals"
        connectsphere.registration.rosterController    -> connectsphere.registration.dataAccess "Reads the event's registrations"
        connectsphere.registration.placeCounter        -> connectsphere.registration.dataAccess "Counts places taken"
        connectsphere.registration.cancellation        -> connectsphere.registration.dataAccess "Cancels the event's places"

        # =====================================================================
        # Leaving the service
        # =====================================================================

        connectsphere.registration.dataAccess   -> connectsphere.db     "Reads and writes registrations" "supabase-js"
        connectsphere.registration.publisher    -> connectsphere.broker "Publishes domain events" "AMQP"
        connectsphere.registration.eventsClient -> connectsphere.events "Reads event details" "JSON over HTTP"
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
