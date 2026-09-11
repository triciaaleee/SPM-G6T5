workspace "ConnectSphere - C2 Containers" "Level 2 of the C4 model. Seven backend services, one per epic, behind a single gateway." {

    !identifiers hierarchical

    model {

        organiser   = person "Event organiser"         "Requests events, opens registration, raises change requests." "Role"
        coordinator = person "Event coordinator"       "Reviews requests, plans venue and equipment, drives the event lifecycle." "Role"
        venueStaff  = person "Venue staff"             "Maintains the venue catalogue and availability, decides booking requests." "Role"
        techSupport = person "Technical support staff" "Maintains equipment inventory and reserves items against events." "Role"
        attendee    = person "Attendee"                "Discovers events open for registration, registers and withdraws." "Role"

        supabaseAuth = softwareSystem "Supabase Auth" "Managed identity provider. Issues the JWT that every request carries and verifies it on demand." "External"

        connectsphere = softwareSystem "ConnectSphere" "Plans campus events end to end." {

            spa = container "Web application" "Single-page app serving all five roles. Route guards check the Supabase session before any protected view." "Vue 3, TypeScript, Vite, Tailwind" "Existing"

            gateway = container "API gateway" "Single entry point. Validates the JWT once, resolves the roles of the caller, then forwards the original token downstream so row level security still applies." "Express, TypeScript" "Planned"

            identity = container "Identity service" "E1. Accounts, role directory, login lockout, and the active-coordinator roster. Wraps Supabase Auth rather than replacing it." "Express, TypeScript" "Planned"

            eventRequest = container "Event request service" "E2. Request intake and validation, drafts, clarification exchange, round-robin coordinator assignment, approve and reject." "Express, TypeScript" "Existing"

            eventLifecycle = container "Event lifecycle service" "E3. Owns the event aggregate: the status machine, change history, the confirmation gate, critical-field review and change requests." "Express, TypeScript" "Planned"

            venue = container "Venue service" "E4. Venue catalogue and availability, search and suitability, booking requests, exclusive tentative holds, double-booking prevention." "Express, TypeScript" "Planned"

            equipment = container "Equipment service" "E5. Equipment requests, inventory and usability, availability checks and reservations." "Express, TypeScript" "Planned"

            registration = container "Registration service" "E6. Registration configuration, attendee discovery and sign-up, withdrawal, roster views." "Express, TypeScript" "Planned"

            notification = container "Notification service" "E7. In-app notification feed and the trigger-to-recipient routing matrix." "Express, TypeScript" "Planned"

            broker = container "Message broker" "Topic exchange connectsphere.events. Decouples the eighteen E7-2 notification triggers and the cancellation fan-out." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance, one schema per service. Row level security is the primary authorisation control, not application code." "Supabase Postgres" "Database"
        }

        # --- People to the web application ------------------------------------

        organiser   -> connectsphere.spa "Uses" "HTTPS"
        coordinator -> connectsphere.spa "Uses" "HTTPS"
        venueStaff  -> connectsphere.spa "Uses" "HTTPS"
        techSupport -> connectsphere.spa "Uses" "HTTPS"
        attendee    -> connectsphere.spa "Uses" "HTTPS"

        # --- Front door -------------------------------------------------------

        connectsphere.spa     -> supabaseAuth "Signs up, signs in, holds the session" "supabase-js over HTTPS"
        connectsphere.spa     -> connectsphere.gateway "Makes API calls with a bearer token" "JSON over HTTPS"
        connectsphere.gateway -> supabaseAuth "Validates the JWT" "HTTPS"

        connectsphere.gateway -> connectsphere.identity       "Resolves caller roles, then routes E1 requests" "JSON over HTTPS"
        connectsphere.gateway -> connectsphere.eventRequest   "Routes E2 requests" "JSON over HTTPS"
        connectsphere.gateway -> connectsphere.eventLifecycle "Routes E3 requests" "JSON over HTTPS"
        connectsphere.gateway -> connectsphere.venue          "Routes E4 requests" "JSON over HTTPS"
        connectsphere.gateway -> connectsphere.equipment      "Routes E5 requests" "JSON over HTTPS"
        connectsphere.gateway -> connectsphere.registration   "Routes E6 requests" "JSON over HTTPS"
        connectsphere.gateway -> connectsphere.notification   "Routes E7 requests" "JSON over HTTPS"

        # --- Each service owns exactly one schema -----------------------------

        connectsphere.identity       -> connectsphere.db "Reads and writes the identity schema"        "supabase-js, caller JWT"
        connectsphere.eventRequest   -> connectsphere.db "Reads and writes the event_request schema"   "supabase-js, caller JWT"
        connectsphere.eventLifecycle -> connectsphere.db "Reads and writes the event_lifecycle schema" "supabase-js, caller JWT"
        connectsphere.venue          -> connectsphere.db "Reads and writes the venue schema"           "supabase-js, caller JWT"
        connectsphere.equipment      -> connectsphere.db "Reads and writes the equipment schema"       "supabase-js, caller JWT"
        connectsphere.registration   -> connectsphere.db "Reads and writes the registration schema"    "supabase-js, caller JWT"
        connectsphere.notification   -> connectsphere.db "Reads and writes the notification schema"    "supabase-js, caller JWT"

        # --- Synchronous reads across service boundaries -----------------------
        # Used only where the caller needs live state and cannot tolerate
        # eventual consistency.

        connectsphere.eventRequest   -> connectsphere.identity       "Reads the active coordinator roster for round-robin assignment (E2-6)" "JSON over HTTPS"
        connectsphere.eventRequest   -> connectsphere.eventLifecycle "Creates the event in Planning once a request is approved (E2-11)" "JSON over HTTPS"
        connectsphere.eventLifecycle -> connectsphere.venue          "Reads booking state for the confirmation gate and impact assessment (E3-4, E3-10)" "JSON over HTTPS"
        connectsphere.eventLifecycle -> connectsphere.equipment      "Reads reservation state for the confirmation gate and impact assessment (E3-4, E3-10)" "JSON over HTTPS"
        connectsphere.eventLifecycle -> connectsphere.registration   "Reads registered counts against proposed capacity (E3-10)" "JSON over HTTPS"
        connectsphere.venue          -> connectsphere.eventLifecycle "Reads event date, time and attendance to pre-fill search and run suitability checks (E4-6, E4-7)" "JSON over HTTPS"
        connectsphere.equipment      -> connectsphere.eventLifecycle "Reads event date, time and venue to scope availability windows (E5-4)" "JSON over HTTPS"
        connectsphere.registration   -> connectsphere.venue          "Reads the maximum capacity of the booked venue as the effective limit (E6-1, E6-7)" "JSON over HTTPS"
        connectsphere.notification   -> connectsphere.identity       "Resolves recipients and confirms they still have access to the event (E7-2)" "JSON over HTTPS"

        # --- Asynchronous: publishers -----------------------------------------

        connectsphere.eventRequest   -> connectsphere.broker "Publishes request.submitted, request.edited, request.approved, request.rejected, coordinator.assigned" "AMQP"
        connectsphere.eventLifecycle -> connectsphere.broker "Publishes event.confirmed, event.completed, event.cancelled, event.critical_changed, change.decided" "AMQP"
        connectsphere.venue          -> connectsphere.broker "Publishes booking.requested, booking.approved, booking.rejected, venue.capacity_reduced" "AMQP"
        connectsphere.equipment      -> connectsphere.broker "Publishes equipment.requested, equipment.reserved, equipment.unusable, equipment.status_changed" "AMQP"
        connectsphere.registration   -> connectsphere.broker "Publishes registration.confirmed, registration.withdrawn" "AMQP"

        # --- Asynchronous: consumers ------------------------------------------

        connectsphere.broker -> connectsphere.notification   "Delivers every trigger in the E7-2 matrix" "AMQP"
        connectsphere.broker -> connectsphere.venue          "Delivers event.cancelled so the booking is released and the slot returns to available (E3-6)" "AMQP"
        connectsphere.broker -> connectsphere.equipment      "Delivers event.cancelled and event.critical_changed so reservations are released or re-checked (E3-6, E5-6)" "AMQP"
        connectsphere.broker -> connectsphere.eventLifecycle "Delivers booking.approved and equipment.reserved to update confirmation readiness (E3-4)" "AMQP"
    }

    views {

        container connectsphere "C2-RequestPath" "Containers and the synchronous request path. The broker is hidden here; see C2-EventPath." {
            include *
            exclude "connectsphere.broker -> *"
            exclude "* -> connectsphere.broker"
            autolayout lr
        }

        container connectsphere "C2-EventPath" "The same containers, showing only the asynchronous event flow through the broker." {
            include connectsphere.broker
            include connectsphere.eventRequest connectsphere.eventLifecycle connectsphere.venue
            include connectsphere.equipment connectsphere.registration connectsphere.notification
            exclude "connectsphere.eventRequest -> connectsphere.eventLifecycle"
            exclude "connectsphere.eventLifecycle -> connectsphere.venue"
            exclude "connectsphere.eventLifecycle -> connectsphere.equipment"
            exclude "connectsphere.eventLifecycle -> connectsphere.registration"
            exclude "connectsphere.venue -> connectsphere.eventLifecycle"
            exclude "connectsphere.equipment -> connectsphere.eventLifecycle"
            exclude "connectsphere.registration -> connectsphere.venue"
            autolayout tb
        }

        styles {
            element "Person" {
                shape Person
                background #7F77DD
                color #ffffff
            }
            element "Software System" {
                background #534AB7
                color #ffffff
            }
            element "Container" {
                background #7F77DD
                color #ffffff
            }
            element "Existing" {
                background #1D9E75
                color #ffffff
            }
            element "Planned" {
                border dashed
            }
            element "External" {
                background #888780
                color #ffffff
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

        theme default
    }
}
