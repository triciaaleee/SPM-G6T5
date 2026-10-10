workspace "ConnectSphere - C2 Containers" "Level 2 of the C4 model. Seven roles use one web application, which reaches six backend services through a single API gateway." {

    !identifiers hierarchical

    model {

        organiser     = person "Event organiser"         "External client. Submits and edits event requests, answers clarifications, opens registration, raises change requests and cancels their own events." "Role"
        lead          = person "Event coordinator lead"  "Internal. Watches the unassigned queue, assigns and reassigns coordinators, oversees every coordinator's workload." "Role"
        coordinator   = person "Event coordinator"       "Internal. Reviews assigned requests, plans venues and equipment, submits events for safety review, decides change requests." "Role"
        safetyOfficer = person "Safety officer"          "Internal. Runs the Operational Safety Check: approves, rejects or requests changes." "Role"
        venueStaff    = person "Venue staff"             "Internal. Maintains venues, setup and turnaround times and unavailability; holds, approves or rejects bookings." "Role"
        techSupport   = person "Technical support staff" "Internal. Maintains equipment inventory and reserves items against events." "Role"
        attendee      = person "Attendee"                "Discovers events open for registration, registers and withdraws." "Role"

        connectsphere = softwareSystem "ConnectSphere" "Plans client events end to end." {

            spa = container "Web application" "Single-page app for all seven roles. Shows each role only its own views; route guards send unauthenticated users to login. Calls one API base URL." "Vue 3, TypeScript, Vite, Tailwind"

            gateway = container "API gateway" "Single entry point on port 4000. Verifies the JWT once with the shared JWT_SECRET (only /api/auth is public), then proxies by path prefix to the owning service and forwards the original token." "Express 5, http-proxy-middleware"

            user = container "User service" "E1. Sign-up, login with lockout after five failed attempts, issues the JWT carrying the caller's role, and the role directory (seven roles, including the coordinator lead and safety officer). Port 4002." "Express 5, TypeScript"

            events = container "Events service" "E2 and E3. Owns the event and its status machine: drafts, submission into the unassigned queue, lead assignment and reassignment, clarification, coordinator review, edit rules, event history, submission for safety review and the three safety outcomes, arrangements-changed re-review, completion, cancellation and change requests. Port 4001." "Express 5, TypeScript"

            venue = container "Venue service" "E4. Venue catalogue with setup and turnaround times, unavailability periods, availability calendar, search and recommendations, multi-venue booking requests, hold, approve and reject with 72-hour expiring holds, conflict detection on the occupied window, and Replacement Required flagging. Port 4003." "Express 5, TypeScript"

            equipment = container "Equipment service" "E5. Equipment requests, inventory and usability, availability checks and reservations. Port 4005." "Express 5, TypeScript"

            registration = container "Registration service" "E6. Registration configuration, attendee discovery and sign-up, withdrawal, organiser and coordinator roster views. Port 4006." "Express 5, TypeScript"

            notification = container "Notification service" "E7. In-app notification feed with unread count, and the trigger-to-recipient routing matrix. Port 4004." "Express 5, TypeScript"

            broker = container "Message broker" "Topic exchange connectsphere.events. Carries every E7-2 notification trigger and fans out cancellations and re-reviews, so no service waits on another to react. Message catalogue in RabbitMQ.md." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance. Each service reads and writes only the tables it owns; status, role and booking-status columns are Postgres enums." "Supabase Postgres" "Database"
        }

        # --- How each role uses the system ------------------------------------

        organiser     -> connectsphere.spa "Submits and tracks requests, answers clarifications, configures registration, raises change requests, cancels events" "HTTPS"
        lead          -> connectsphere.spa "Works the unassigned queue, assigns and reassigns coordinators, views the assignment overview" "HTTPS"
        coordinator   -> connectsphere.spa "Reviews requests, books venues, requests equipment, submits for safety review, decides change requests" "HTTPS"
        safetyOfficer -> connectsphere.spa "Opens the safety review queue and records approve, reject or request changes" "HTTPS"
        venueStaff    -> connectsphere.spa "Maintains venues and unavailability, holds, approves or rejects bookings" "HTTPS"
        techSupport   -> connectsphere.spa "Maintains inventory, updates and reserves equipment requests" "HTTPS"
        attendee      -> connectsphere.spa "Browses open events, registers, withdraws" "HTTPS"

        # --- Front door -------------------------------------------------------

        connectsphere.spa -> connectsphere.gateway "Makes every API call with a bearer token" "JSON over HTTPS"

        connectsphere.gateway -> connectsphere.user         "Routes /api/auth and /api/users"     "JSON over HTTP"
        connectsphere.gateway -> connectsphere.events       "Routes /api/events"                   "JSON over HTTP"
        connectsphere.gateway -> connectsphere.venue        "Routes /api/venues"                   "JSON over HTTP"
        connectsphere.gateway -> connectsphere.equipment    "Routes /api/equipment-requests"       "JSON over HTTP"
        connectsphere.gateway -> connectsphere.registration "Routes /api/registrations"            "JSON over HTTP"
        connectsphere.gateway -> connectsphere.notification "Routes /api/notifications"            "JSON over HTTP"

        # --- Each service owns its own tables ---------------------------------

        connectsphere.user         -> connectsphere.db "Reads and writes users and login attempts"                                 "supabase-js"
        connectsphere.events       -> connectsphere.db "Reads and writes events, clarifications, event history and safety reviews"  "supabase-js"
        connectsphere.venue        -> connectsphere.db "Reads and writes venues, unavailability and venue bookings"                 "supabase-js"
        connectsphere.equipment    -> connectsphere.db "Reads and writes equipment requests, inventory and reservations"            "supabase-js"
        connectsphere.registration -> connectsphere.db "Reads and writes registration settings and registrations"                   "supabase-js"
        connectsphere.notification -> connectsphere.db "Reads and writes notifications"                                             "supabase-js"

        # --- Synchronous reads across service boundaries -----------------------
        # Used only where the caller needs live state to answer the request.
        # The caller's bearer token is forwarded, so the owner's access rules apply.

        connectsphere.events       -> connectsphere.user         "Lists active coordinators for assignment and reassignment (E2-12, E2-13)"                       "JSON over HTTP"
        connectsphere.events       -> connectsphere.venue        "Reads every booking's status before safety review and for change impact (E3-4, E3-10)"          "JSON over HTTP"
        connectsphere.events       -> connectsphere.equipment    "Reads reservation status before safety review and for change impact (E3-4, E3-10)"              "JSON over HTTP"
        connectsphere.events       -> connectsphere.registration "Reads registered counts against proposed capacity (E3-10)"                                      "JSON over HTTP"
        connectsphere.venue        -> connectsphere.events       "Reads event date, times, attendance and status for search, suitability and occupied windows (E4-6 to E4-11)" "JSON over HTTP"
        connectsphere.equipment    -> connectsphere.events       "Reads event date, times and venue bookings to scope availability windows (E5-4)"                "JSON over HTTP"
        connectsphere.registration -> connectsphere.events       "Reads event details and status for discovery and registration (E6-1, E6-2)"                     "JSON over HTTP"
        connectsphere.registration -> connectsphere.venue        "Reads the capacity of the event's approved venue bookings (E6-1, E6-6)"                         "JSON over HTTP"
        connectsphere.notification -> connectsphere.user         "Resolves role-based recipients such as coordinator leads and safety officers (E7-2)"            "JSON over HTTP"

        # --- Asynchronous: publishers -----------------------------------------

        connectsphere.events       -> connectsphere.broker "Publishes request.submitted, request.edited, coordinator.assigned, coordinator.reassigned, clarification.requested, clarification.answered, request.decided, safety.submitted, safety.decided, event.rereview, change.requested, change.decided, event.cancelled" "AMQP"
        connectsphere.venue        -> connectsphere.broker "Publishes booking.requested, booking.decided, booking.withdrawn, hold.expiring, hold.expired, booking.replacement_required, booking.unavailability_clash, booking.setup_conflict, venue.capacity_reduced" "AMQP"
        connectsphere.equipment    -> connectsphere.broker "Publishes equipment.requested, equipment.amended, equipment.status_changed, equipment.unusable, equipment.released" "AMQP"
        connectsphere.registration -> connectsphere.broker "Publishes registration.confirmed, registration.withdrawn, registration.cancelled_by_event" "AMQP"

        # --- Asynchronous: consumers ------------------------------------------

        connectsphere.broker -> connectsphere.notification "Delivers every message; each one names its recipients (see RabbitMQ.md)" "AMQP"
        connectsphere.broker -> connectsphere.events       "Delivers booking.replacement_required so a Safety Review or Confirmed event returns to Planning (change 2)" "AMQP"
        connectsphere.broker -> connectsphere.venue        "Delivers event.cancelled so every booking of the event is withdrawn, then announced as booking.withdrawn (E3-6)" "AMQP"
        connectsphere.broker -> connectsphere.equipment    "Delivers event.cancelled and change.decided so reservations are released (then announced as equipment.released) or re-checked (E3-6, E5-6)" "AMQP"
        connectsphere.broker -> connectsphere.registration "Delivers event.cancelled so registration closes and places are cancelled, then announced as registration.cancelled_by_event (E3-6)" "AMQP"
    }

    views {

        container connectsphere "C2-Containers" "Every role, the web application, the API gateway, the six services, the message broker and the database in one view." {
            include *
            autolayout lr
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
                background #534AB7
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
