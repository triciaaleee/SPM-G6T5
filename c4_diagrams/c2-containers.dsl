workspace "ConnectSphere - C2 Containers" "Level 2 of the C4 model. Seven roles use one web application, which calls seven backend services directly. Each service verifies the JWT itself." {

    !identifiers hierarchical

    model {

        organiser     = person "Event organiser"         "External client. Submits and edits event requests, answers clarifications, raises change requests and cancels their own events." "Role"
        lead          = person "Event coordinator lead"  "Internal. Watches the unassigned queue, assigns each new request to a coordinator, reassigns events and oversees every coordinator's workload." "Role"
        coordinator   = person "Event coordinator"       "Internal. Reviews the requests assigned to them, plans venues and equipment, submits events for safety review and decides change requests." "Role"
        safetyOfficer = person "Safety officer"          "Internal. Runs the Operational Safety Check on planned events: approves, rejects or requests changes." "Role"
        venueStaff    = person "Venue staff"             "Internal. Maintains venues, setup and turnaround times and unavailability; holds, approves or rejects booking requests." "Role"
        techSupport   = person "Technical support staff" "Internal. Maintains equipment inventory and reserves items against events." "Role"
        attendee      = person "Attendee"                "Discovers events open for registration, and can register and withdraw from events." "Role"

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion. The coordinator lead assigns each request to a coordinator, who reviews it and arranges venues and equipment. The event then passes the Operational Safety Check before it is confirmed and opens for attendee registration." {

            spa = container "Web application" "Single-page app for all seven roles. Each role sees only its own views, and signed-out users are sent to login. Calls each service directly, sending the JWT with every request." "Vue 3, TypeScript, Vite, Tailwind"

            user = container "User service" "E1. Sign-up and login, with a 15-minute lockout after five failed attempts. Issues the JWT carrying the caller's role, and looks up users by role or name. Port 4002." "Express 5, TypeScript"

            events = container "Events service" "E2 and E3. Owns each event and its status. Handles drafts, submission, assignment by the lead and clarifications. Covers coordinator review, edits, change requests, safety review, completion and cancellation. Keeps the event history and registration settings. Port 4001." "Express 5, TypeScript"

            chat = container "Chat service" "E2. Private chat between an organiser and their event's assigned coordinator, open while the event is in Planning or Confirmed. Port 4006." "Express 5, TypeScript"

            venue = container "Venue service" "E4. Venue catalogue with setup and turnaround times and unavailability periods. Venue search and recommendations. Booking requests, 72-hour holds, approvals and rejections, and flags bookings that no longer fit. Port 4003." "Express 5, TypeScript"

            equipment = container "Equipment service" "E5. Equipment catalogue, stock and individual units, including periods out of use. Equipment requests, availability checks and reservations. Port 4005." "Express 5, TypeScript"

            registration = container "Registration service" "E6. Lists events open for registration, takes registrations up to capacity and handles withdrawals. Shows organisers and coordinators who has registered. Port 4007." "Express 5, TypeScript"

            notification = container "Notification service" "E7. In-app notification feed with an unread count. Consumes every broker message and works out who should receive it. Port 4004." "Express 5, TypeScript"

            broker = container "Message broker" "Topic exchange connectsphere.events. Carries every notification trigger and fans out event changes, such as cancellations, so services react without waiting on each other." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance. Each service reads and writes only its own tables. Status, role and booking-status columns are Postgres enums." "Supabase Postgres" "Database"
        }

        # --- How each role uses the system ------------------------------------

        organiser     -> connectsphere.spa "Submits and tracks event requests, raises change requests, cancels events" "HTTPS"
        lead          -> connectsphere.spa "Assigns and reassigns coordinators, views all assignments" "HTTPS"
        coordinator   -> connectsphere.spa "Reviews requests, books venues, requests equipment, submits for safety review, manages registration" "HTTPS"
        safetyOfficer -> connectsphere.spa "Reviews events awaiting the Operational Safety Check and records the outcome" "HTTPS"
        venueStaff    -> connectsphere.spa "Maintains venues and unavailability, decides booking requests" "HTTPS"
        techSupport   -> connectsphere.spa "Maintains equipment inventory, reserves items" "HTTPS"
        attendee      -> connectsphere.spa "Discovers events, registers, withdraws" "HTTPS"

        # --- Web application to each service ----------------------------------
        # The app holds one base URL per service, and every service
        # verifies the bearer token with the shared JWT_SECRET.

        connectsphere.spa -> connectsphere.user         "Calls /api/auth and /api/users"     "JSON over HTTPS"
        connectsphere.spa -> connectsphere.events       "Calls /api/events"                  "JSON over HTTPS"
        connectsphere.spa -> connectsphere.chat         "Calls /api/chat"                    "JSON over HTTPS"
        connectsphere.spa -> connectsphere.venue        "Calls /api/venues"                  "JSON over HTTPS"
        connectsphere.spa -> connectsphere.equipment    "Calls /api/equipment-requests"      "JSON over HTTPS"
        connectsphere.spa -> connectsphere.registration "Calls /api/registrations"           "JSON over HTTPS"
        connectsphere.spa -> connectsphere.notification "Calls /api/notifications"           "JSON over HTTPS"

        # --- Each service owns its own tables ---------------------------------

        connectsphere.user         -> connectsphere.db "Reads and writes users and login attempts"                                          "supabase-js"
        connectsphere.events       -> connectsphere.db "Reads and writes events, clarifications, change requests, event history and safety reviews" "supabase-js"
        connectsphere.chat         -> connectsphere.db "Reads and writes chat messages"                                                     "supabase-js"
        connectsphere.venue        -> connectsphere.db "Reads and writes venues, unavailability and venue bookings"                         "supabase-js"
        connectsphere.equipment    -> connectsphere.db "Reads and writes the equipment catalogue, units, requests and reservations"         "supabase-js"
        connectsphere.registration -> connectsphere.db "Reads and writes registrations"                                                     "supabase-js"
        connectsphere.notification -> connectsphere.db "Reads and writes notifications"                                                     "supabase-js"

        # --- Synchronous calls across service boundaries -----------------------
        # Used only where the caller needs live state to answer the request.

        connectsphere.events       -> connectsphere.user         "Lists active coordinators for assignment and reassignment"                          "JSON over HTTP"
        connectsphere.events       -> connectsphere.venue        "Reads booking status before safety review; checks and flags bookings a change request affects" "JSON over HTTP"
        connectsphere.events       -> connectsphere.equipment    "Reads reservation status before safety review; flags equipment a change request affects" "JSON over HTTP"
        connectsphere.events       -> connectsphere.registration "Reads registered counts to check a proposed attendance change"                      "JSON over HTTP"
        connectsphere.chat         -> connectsphere.events       "Reads the event and its assigned coordinator to check who may chat"                 "JSON over HTTP"
        connectsphere.venue        -> connectsphere.events       "Reads event dates, times, attendance and status; reports lost bookings"            "JSON over HTTP"
        connectsphere.equipment    -> connectsphere.events       "Reads event dates, times and status; reports lost reservations"                     "JSON over HTTP"
        connectsphere.equipment    -> connectsphere.user         "Reads the names of coordinators who raised equipment requests"                     "JSON over HTTP"
        connectsphere.registration -> connectsphere.events       "Reads event details and status for discovery and registration"                      "JSON over HTTP"
        connectsphere.registration -> connectsphere.venue        "Reads the names of the event's approved venues"                                     "JSON over HTTP"
        connectsphere.registration -> connectsphere.user         "Reads attendee names for the registration list"                                     "JSON over HTTP"
        connectsphere.notification -> connectsphere.user         "Resolves role-based recipients, such as coordinator leads and safety officers"      "JSON over HTTP"

        # --- Asynchronous: publishers -----------------------------------------

        connectsphere.events       -> connectsphere.broker "Publishes request.submitted, request.edited, request.decided, coordinator.assigned, coordinator.reassigned, clarification.requested, clarification.answered, safety.submitted, safety.decided, change.requested, change.decided, change.withdrawn, event.needs_review, event.returned_to_planning, event.rescheduled, event.attendance_changed, event.cancelled" "AMQP"
        connectsphere.chat         -> connectsphere.broker "Publishes message.sent" "AMQP"
        connectsphere.venue        -> connectsphere.broker "Publishes booking.requested, booking.decided, booking.withdrawn, hold.expiring, hold.expired, booking.replacement_required, booking.unavailability_clash, booking.setup_conflict, booking.invalidated_by_edit, booking.flagged_for_rebooking, venue.capacity_reduced" "AMQP"
        connectsphere.equipment    -> connectsphere.broker "Publishes equipment.requested, equipment.amended, equipment.status_changed, equipment.unusable, equipment.reservation_clash, equipment.flagged_for_reassessment, equipment.released" "AMQP"
        connectsphere.registration -> connectsphere.broker "Publishes registration.confirmed, registration.withdrawn, registration.cancelled_by_event" "AMQP"

        # --- Asynchronous: consumers ------------------------------------------

        connectsphere.broker -> connectsphere.notification "Delivers every message, to be turned into notifications" "AMQP"
        connectsphere.broker -> connectsphere.venue        "Delivers event.cancelled, so the event's bookings are withdrawn, and event.rescheduled and event.attendance_changed, so its bookings are re-checked and any that no longer fit are flagged" "AMQP"
        connectsphere.broker -> connectsphere.equipment    "Delivers event.cancelled, so the event's reservations are released, and event.rescheduled, so reserved units move to the new time and any clashes are flagged" "AMQP"
        connectsphere.broker -> connectsphere.registration "Delivers event.cancelled, so the event's registrations are cancelled" "AMQP"
    }

    views {

        container connectsphere "C2-Containers" "Every role, the web application, the seven services, the message broker and the database in one view." {
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
                width 550
                height 380
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
    }
}
