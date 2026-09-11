workspace "ConnectSphere - C3 Components" "Level 3 of the C4 model. Component views for the three services carrying the most domain logic: event request (E2), event lifecycle (E3) and venue (E4)." {

    !identifiers hierarchical

    model {

        supabaseAuth = softwareSystem "Supabase Auth" "Managed identity provider. Issues the JWT that every request carries and verifies it on demand." "External"

        connectsphere = softwareSystem "ConnectSphere" "Plans campus events end to end." {

            gateway = container "API gateway" "Single entry point. Validates the JWT once and forwards the original token downstream." "Express, TypeScript" "Planned"

            identity = container "Identity service" "E1. Accounts, role directory, login lockout, active-coordinator roster." "Express, TypeScript" "Planned"

            equipment = container "Equipment service" "E5. Equipment requests, inventory, availability checks and reservations." "Express, TypeScript" "Planned"

            registration = container "Registration service" "E6. Registration configuration, sign-up, withdrawal, roster views." "Express, TypeScript" "Planned"

            broker = container "Message broker" "Topic exchange connectsphere.events." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance, one schema per service. Row level security is the primary authorisation control." "Supabase Postgres" "Database"

            # =================================================================
            # C3a - Event request service (E2)
            # Components tagged Existing map to files that are in the repo today.
            # =================================================================

            eventRequest = container "Event request service" "E2. Request intake, drafts, clarification exchange, coordinator assignment, approve and reject." "Express, TypeScript" "Existing" {

                authMiddleware = component "Auth middleware" "Extracts the bearer token, verifies it with Supabase, attaches a user-scoped client and req.user so row level security applies." "middleware/auth.ts" "Existing"

                requestsController = component "Requests controller" "Submit a request, edit before approval, list own events, view one event (E2-1, E2-7, E2-8, E1-3)." "routes/events.ts" "Existing"

                draftsController = component "Drafts controller" "Save as draft, resume, list, delete with confirmation (E2-4, E2-5)." "" "Planned"

                reviewController = component "Review controller" "Clarification exchange and the approve or reject decision (E2-9, E2-10, E2-11)." "" "Planned"

                requestValidator = component "Request validator" "Mandatory fields, no past dates, end after start, attendance greater than zero. Collects every field error in one pass (E2-1)." "lib/validateEventRequest.ts" "Existing"

                requirementsCheck = component "Requirements check" "Optional venue, accessibility and equipment fields. Raises the needs-registration and vague-requirements flags (E2-2, E2-3)." "" "Planned"

                draftStore = component "Draft store" "Persists partial requests that deliberately bypass validation. Drafts are invisible to coordinators (E2-4, E2-5)." "" "Planned"

                clarifications = component "Clarification thread" "Ordered question and answer exchange plus the awaiting-clarification flag (E2-9, E2-10)." "" "Planned"

                coordinatorPicker = component "Coordinator picker" "Round-robin over active coordinators. Exactly one per event; flags Unassigned when none exist; handles reassignment (E2-6, E2-12)." "" "Planned"

                decisionHandler = component "Decision handler" "Refuses approval while a clarification is open. Records a mandatory reason on reject (E2-11)." "" "Planned"

                requestRepository = component "Request repository" "All reads and writes against the event_request schema, always through a client built from the caller token." "" "Planned"

                clientFactory = component "Supabase client factory" "Builds a fresh short-lived client per request from the caller access token, rather than using a privileged service-role key." "lib/supabase.ts" "Existing"

                publisher = component "Event publisher" "Emits request.submitted, request.edited, request.approved, request.rejected and coordinator.assigned." "amqplib" "Planned"

                identityClient = component "Identity client" "Reads the active coordinator roster." "" "Planned"

                lifecycleClient = component "Lifecycle client" "Hands an approved request over to the event lifecycle service." "" "Planned"
            }

            # =================================================================
            # C3b - Event lifecycle service (E3)
            # Owns the event aggregate and every status transition.
            # =================================================================

            eventLifecycle = container "Event lifecycle service" "E3. Status machine, history, confirmation gate, critical-field review, change requests." "Express, TypeScript" "Planned" {

                authMiddleware = component "Auth and role guard" "Verifies the JWT and enforces assigned-coordinator-only actions (E1-4.1, E1-4.2)." "" "Planned"

                eventController = component "Event controller" "Status and outstanding arrangements for organisers, field updates during planning (E3-1, E3-7)." "" "Planned"

                dashboardController = component "Dashboard controller" "Assigned events grouped by status and ordered by event date, with needs-action highlighting (E3-2)." "" "Planned"

                changeController = component "Change request controller" "Raise, assess and decide a change request after confirmation (E3-9, E3-10, E3-11)." "" "Planned"

                statusMachine = component "Status machine" "Draft, Requested, Planning, Confirmed, Completed, Rejected, Cancelled. Permits only modelled transitions and blocks anything leaving Rejected or Cancelled (E3-3)." "" "Planned"

                confirmationGate = component "Confirmation gate" "Blocks Confirmed until the venue booking is confirmed and every requested equipment item is reserved. Names what is outstanding (E3-4)." "" "Planned"

                completionGuard = component "Completion guard" "Blocks Completed until the event end time has passed, and keeps the full record afterwards (E3-5)." "" "Planned"

                cancellation = component "Cancellation orchestrator" "Publishes event.cancelled so the venue booking and equipment reservations are released and registered attendees are told (E3-6)." "" "Planned"

                criticalFields = component "Critical field interceptor" "Expected attendance, venue and duration are held for coordinator review rather than applied silently. Never auto-releases a booking (E3-8)." "" "Planned"

                impactAssessor = component "Impact assessor" "Read-only. Lists the booking, reservations and registrations a change would break, and shows capacity conflicts explicitly (E3-10)." "" "Planned"

                changeDecision = component "Change decision handler" "Applies or rejects a change. Flags re-booking for manual release and notifies venue and technical support without requiring their re-approval (E3-11)." "" "Planned"

                historyWriter = component "History writer" "Records field, old value, new value, timestamp and actor for every change and every status transition (E3-3, E3-7, E2-12)." "" "Planned"

                lifecycleRepository = component "Lifecycle repository" "All reads and writes against the event_lifecycle schema." "" "Planned"

                venueClient = component "Venue client" "Reads booking state for the confirmation gate and impact assessment." "" "Planned"

                equipmentClient = component "Equipment client" "Reads reservation state." "" "Planned"

                registrationClient = component "Registration client" "Reads registered counts against proposed capacity." "" "Planned"

                publisher = component "Event publisher" "Emits event.confirmed, event.completed, event.cancelled, event.critical_changed and change.decided." "amqplib" "Planned"

                consumer = component "Event consumer" "Consumes booking.approved and equipment.reserved to keep confirmation readiness current." "amqplib" "Planned"
            }

            # =================================================================
            # C3c - Venue service (E4)
            # Owns tentative holds exclusively, which is why its booking data
            # cannot be shared with another service.
            # =================================================================

            venue = container "Venue service" "E4. Catalogue, availability, suitability, tentative holds, double-booking prevention." "Express, TypeScript" "Planned" {

                authMiddleware = component "Auth and role guard" "Restricts venue staff to booking-relevant event fields and denies events with no booking request raised (E1-5)." "" "Planned"

                catalogueController = component "Catalogue controller" "Create and update venue records, retire a venue, record unavailability (E4-1, E4-2, E4-3)." "" "Planned"

                searchController = component "Search controller" "Filter by date, time, attendance, location, capacity, accessibility, layout and facilities, with a relax-filters path when nothing matches (E4-6)." "" "Planned"

                bookingController = component "Booking controller" "Submit, withdraw, approve and reject booking requests, ordered by event date (E4-8, E4-9, E4-10)." "" "Planned"

                scheduleController = component "Schedule controller" "Venue availability calendar for coordinators and the venue schedule for staff (E4-4, E4-5)." "" "Planned"

                venueValidator = component "Venue validator" "Mandatory attributes present, capacity greater than zero, and notifies affected coordinators when capacity drops below a booked attendance (E4-1)." "" "Planned"

                availabilityCalc = component "Availability calculator" "Merges confirmed bookings, tentative holds, recorded unavailability and operating hours into one visually distinct calendar (E4-4)." "" "Planned"

                suitabilityChecker = component "Suitability checker" "Capacity, layout, facility and accessibility fit. Attendance equal to capacity is suitable. Warns but never blocks (E4-7)." "" "Planned"

                holdManager = component "Hold manager" "Places, releases and promotes the exclusive tentative hold. Holds never expire (E4-8, E4-9, E4-10)." "" "Planned"

                conflictDetector = component "Conflict detector" "Overlap detection against holds and confirmed bookings. First submission wins. Turnaround time is deliberately not modelled (E4-11)." "" "Planned"

                retirementGuard = component "Retirement guard" "Blocks retirement while future confirmed bookings exist and lists them. Retired venues stay visible on past bookings (E4-2)." "" "Planned"

                unavailabilityManager = component "Unavailability manager" "Blocked periods with a reason, warning against any confirmed booking already inside the period (E4-3)." "" "Planned"

                venueRepository = component "Venue repository" "All reads and writes against the venue schema." "" "Planned"

                eventClient = component "Event client" "Reads event date, time and attendance to pre-fill search and drive suitability checks." "" "Planned"

                publisher = component "Event publisher" "Emits booking.requested, booking.approved, booking.rejected and venue.capacity_reduced." "amqplib" "Planned"

                consumer = component "Event consumer" "Consumes event.cancelled to release the booking and return the slot to available." "amqplib" "Planned"
            }
        }

        # =====================================================================
        # C3a relationships - Event request service
        # =====================================================================

        connectsphere.gateway -> connectsphere.eventRequest.authMiddleware "Forwards the request with the caller bearer token" "JSON over HTTPS"

        connectsphere.eventRequest.authMiddleware -> supabaseAuth "Verifies the access token" "HTTPS"
        connectsphere.eventRequest.authMiddleware -> connectsphere.eventRequest.clientFactory      "Builds a user-scoped client from the token"
        connectsphere.eventRequest.authMiddleware -> connectsphere.eventRequest.requestsController "Passes the authenticated request"
        connectsphere.eventRequest.authMiddleware -> connectsphere.eventRequest.draftsController   "Passes the authenticated request"
        connectsphere.eventRequest.authMiddleware -> connectsphere.eventRequest.reviewController   "Passes the authenticated request"

        connectsphere.eventRequest.requestsController -> connectsphere.eventRequest.requestValidator  "Validates the payload"
        connectsphere.eventRequest.requestsController -> connectsphere.eventRequest.requirementsCheck "Records requirements and raises flags"
        connectsphere.eventRequest.requestsController -> connectsphere.eventRequest.coordinatorPicker "Triggers assignment once status is Requested"
        connectsphere.eventRequest.requestsController -> connectsphere.eventRequest.publisher        "Emits request.submitted and request.edited"

        connectsphere.eventRequest.draftsController -> connectsphere.eventRequest.draftStore       "Saves, resumes and deletes drafts"
        connectsphere.eventRequest.draftsController -> connectsphere.eventRequest.requestValidator "Validates when a draft is submitted"

        connectsphere.eventRequest.reviewController -> connectsphere.eventRequest.clarifications  "Posts questions and answers"
        connectsphere.eventRequest.reviewController -> connectsphere.eventRequest.decisionHandler "Records approve or reject"

        connectsphere.eventRequest.decisionHandler   -> connectsphere.eventRequest.clarifications  "Refuses to approve while one is unresolved"
        connectsphere.eventRequest.decisionHandler   -> connectsphere.eventRequest.lifecycleClient "Hands the approved event over"
        connectsphere.eventRequest.decisionHandler   -> connectsphere.eventRequest.publisher       "Emits request.approved and request.rejected"
        connectsphere.eventRequest.coordinatorPicker -> connectsphere.eventRequest.identityClient  "Fetches the active coordinator roster"
        connectsphere.eventRequest.coordinatorPicker -> connectsphere.eventRequest.publisher       "Emits coordinator.assigned"

        connectsphere.eventRequest.requestValidator  -> connectsphere.eventRequest.requestRepository "Persists the validated request"
        connectsphere.eventRequest.requirementsCheck -> connectsphere.eventRequest.requestRepository "Persists requirements and flags"
        connectsphere.eventRequest.draftStore        -> connectsphere.eventRequest.requestRepository "Persists drafts"
        connectsphere.eventRequest.clarifications    -> connectsphere.eventRequest.requestRepository "Persists the exchange"
        connectsphere.eventRequest.coordinatorPicker -> connectsphere.eventRequest.requestRepository "Persists the assignment"
        connectsphere.eventRequest.decisionHandler   -> connectsphere.eventRequest.requestRepository "Persists the decision and reason"

        connectsphere.eventRequest.requestRepository -> connectsphere.eventRequest.clientFactory "Obtains the per-request client"
        connectsphere.eventRequest.requestRepository -> connectsphere.db "Reads and writes the event_request schema" "supabase-js, caller JWT"

        connectsphere.eventRequest.publisher       -> connectsphere.broker         "Publishes domain events" "AMQP"
        connectsphere.eventRequest.identityClient  -> connectsphere.identity       "Calls the coordinator roster endpoint" "JSON over HTTPS"
        connectsphere.eventRequest.lifecycleClient -> connectsphere.eventLifecycle "Creates the event in Planning" "JSON over HTTPS"

        # =====================================================================
        # C3b relationships - Event lifecycle service
        # =====================================================================

        connectsphere.gateway -> connectsphere.eventLifecycle.authMiddleware "Forwards the request with the caller bearer token" "JSON over HTTPS"

        connectsphere.eventLifecycle.authMiddleware -> supabaseAuth "Verifies the access token" "HTTPS"
        connectsphere.eventLifecycle.authMiddleware -> connectsphere.eventLifecycle.eventController     "Passes the authenticated request"
        connectsphere.eventLifecycle.authMiddleware -> connectsphere.eventLifecycle.dashboardController "Passes the authenticated request"
        connectsphere.eventLifecycle.authMiddleware -> connectsphere.eventLifecycle.changeController    "Passes the authenticated request"

        connectsphere.eventLifecycle.eventController -> connectsphere.eventLifecycle.criticalFields   "Intercepts attendance, venue and duration edits"
        connectsphere.eventLifecycle.eventController -> connectsphere.eventLifecycle.statusMachine    "Requests a transition"
        connectsphere.eventLifecycle.eventController -> connectsphere.eventLifecycle.confirmationGate "Checks arrangements before Confirmed"
        connectsphere.eventLifecycle.eventController -> connectsphere.eventLifecycle.completionGuard  "Checks the end time before Completed"
        connectsphere.eventLifecycle.eventController -> connectsphere.eventLifecycle.cancellation     "Runs cancellation"
        connectsphere.eventLifecycle.eventController -> connectsphere.eventLifecycle.lifecycleRepository "Reads and writes event fields"

        connectsphere.eventLifecycle.dashboardController -> connectsphere.eventLifecycle.lifecycleRepository "Reads assigned events grouped by status"

        connectsphere.eventLifecycle.changeController -> connectsphere.eventLifecycle.impactAssessor "Assesses impact, read only"
        connectsphere.eventLifecycle.changeController -> connectsphere.eventLifecycle.changeDecision "Applies or rejects the change"

        connectsphere.eventLifecycle.statusMachine    -> connectsphere.eventLifecycle.historyWriter "Records previous status, new status, timestamp and actor"
        connectsphere.eventLifecycle.statusMachine    -> connectsphere.eventLifecycle.publisher     "Emits event.confirmed and event.completed"
        connectsphere.eventLifecycle.criticalFields   -> connectsphere.eventLifecycle.historyWriter "Records held and applied changes"
        connectsphere.eventLifecycle.completionGuard  -> connectsphere.eventLifecycle.statusMachine "Permits the transition to Completed"
        connectsphere.eventLifecycle.confirmationGate -> connectsphere.eventLifecycle.statusMachine "Permits the transition to Confirmed"
        connectsphere.eventLifecycle.cancellation     -> connectsphere.eventLifecycle.statusMachine "Transitions to Cancelled"
        connectsphere.eventLifecycle.cancellation     -> connectsphere.eventLifecycle.publisher     "Emits event.cancelled"
        connectsphere.eventLifecycle.changeDecision   -> connectsphere.eventLifecycle.statusMachine "Applies the resulting transition"
        connectsphere.eventLifecycle.changeDecision   -> connectsphere.eventLifecycle.historyWriter "Records the decision and reason"
        connectsphere.eventLifecycle.changeDecision   -> connectsphere.eventLifecycle.publisher     "Emits event.critical_changed and change.decided"

        connectsphere.eventLifecycle.confirmationGate -> connectsphere.eventLifecycle.venueClient        "Confirms the booking is confirmed"
        connectsphere.eventLifecycle.confirmationGate -> connectsphere.eventLifecycle.equipmentClient    "Confirms every requested item is reserved"
        connectsphere.eventLifecycle.impactAssessor   -> connectsphere.eventLifecycle.venueClient        "Lists the affected booking and capacity conflicts"
        connectsphere.eventLifecycle.impactAssessor   -> connectsphere.eventLifecycle.equipmentClient    "Lists the affected reservations"
        connectsphere.eventLifecycle.impactAssessor   -> connectsphere.eventLifecycle.registrationClient "Reads the registered count against proposed capacity"

        connectsphere.eventLifecycle.statusMachine  -> connectsphere.eventLifecycle.lifecycleRepository "Persists the status"
        connectsphere.eventLifecycle.historyWriter  -> connectsphere.eventLifecycle.lifecycleRepository "Persists history rows"
        connectsphere.eventLifecycle.criticalFields -> connectsphere.eventLifecycle.lifecycleRepository "Persists held changes"

        connectsphere.eventLifecycle.lifecycleRepository -> connectsphere.db "Reads and writes the event_lifecycle schema" "supabase-js, caller JWT"

        connectsphere.eventLifecycle.publisher -> connectsphere.broker "Publishes domain events" "AMQP"
        connectsphere.broker -> connectsphere.eventLifecycle.consumer "Delivers booking.approved and equipment.reserved" "AMQP"
        connectsphere.eventLifecycle.consumer -> connectsphere.eventLifecycle.confirmationGate "Updates confirmation readiness"

        connectsphere.eventLifecycle.venueClient        -> connectsphere.venue        "Reads booking state" "JSON over HTTPS"
        connectsphere.eventLifecycle.equipmentClient    -> connectsphere.equipment    "Reads reservation state" "JSON over HTTPS"
        connectsphere.eventLifecycle.registrationClient -> connectsphere.registration "Reads registered counts" "JSON over HTTPS"

        # =====================================================================
        # C3c relationships - Venue service
        # =====================================================================

        connectsphere.gateway -> connectsphere.venue.authMiddleware "Forwards the request with the caller bearer token" "JSON over HTTPS"

        connectsphere.venue.authMiddleware -> supabaseAuth "Verifies the access token" "HTTPS"
        connectsphere.venue.authMiddleware -> connectsphere.venue.catalogueController "Passes the authenticated request"
        connectsphere.venue.authMiddleware -> connectsphere.venue.searchController    "Passes the authenticated request"
        connectsphere.venue.authMiddleware -> connectsphere.venue.bookingController   "Passes the authenticated request"
        connectsphere.venue.authMiddleware -> connectsphere.venue.scheduleController  "Passes the authenticated request"

        connectsphere.venue.catalogueController -> connectsphere.venue.venueValidator        "Validates mandatory attributes and capacity"
        connectsphere.venue.catalogueController -> connectsphere.venue.retirementGuard       "Checks future confirmed bookings before retiring"
        connectsphere.venue.catalogueController -> connectsphere.venue.unavailabilityManager "Records blocked periods"

        connectsphere.venue.searchController -> connectsphere.venue.availabilityCalc   "Excludes venues unavailable in the window"
        connectsphere.venue.searchController -> connectsphere.venue.suitabilityChecker "Flags unsuitable venues without blocking the request"
        connectsphere.venue.searchController -> connectsphere.venue.eventClient        "Pre-fills from event date, time and attendance"

        connectsphere.venue.bookingController -> connectsphere.venue.conflictDetector "Rejects overlapping requests, first in wins"
        connectsphere.venue.bookingController -> connectsphere.venue.holdManager      "Places, releases and promotes the tentative hold"
        connectsphere.venue.bookingController -> connectsphere.venue.publisher        "Emits booking.requested, booking.approved and booking.rejected"

        connectsphere.venue.scheduleController -> connectsphere.venue.availabilityCalc "Renders the calendar and the staff schedule"

        connectsphere.venue.venueValidator -> connectsphere.venue.publisher "Emits venue.capacity_reduced"

        connectsphere.venue.availabilityCalc      -> connectsphere.venue.venueRepository "Reads bookings, holds, blocked periods and operating hours"
        connectsphere.venue.suitabilityChecker    -> connectsphere.venue.venueRepository "Reads venue attributes"
        connectsphere.venue.holdManager           -> connectsphere.venue.venueRepository "Writes holds and confirmed bookings"
        connectsphere.venue.conflictDetector      -> connectsphere.venue.venueRepository "Reads overlapping periods"
        connectsphere.venue.venueValidator        -> connectsphere.venue.venueRepository "Writes venue records"
        connectsphere.venue.unavailabilityManager -> connectsphere.venue.venueRepository "Writes blocked periods"
        connectsphere.venue.retirementGuard       -> connectsphere.venue.venueRepository "Reads future confirmed bookings"

        connectsphere.venue.venueRepository -> connectsphere.db "Reads and writes the venue schema" "supabase-js, caller JWT"

        connectsphere.venue.publisher -> connectsphere.broker "Publishes domain events" "AMQP"
        connectsphere.broker -> connectsphere.venue.consumer "Delivers event.cancelled" "AMQP"
        connectsphere.venue.consumer -> connectsphere.venue.holdManager "Releases the booking and frees the slot"

        connectsphere.venue.eventClient -> connectsphere.eventLifecycle "Reads event date, time and attendance" "JSON over HTTPS"
    }

    views {

        component connectsphere.eventRequest "C3a-EventRequest" "Components of the event request service (E2). Green components exist in the repo today." {
            include *
            autolayout lr
        }

        component connectsphere.eventLifecycle "C3b-EventLifecycle" "Components of the event lifecycle service (E3). Owns the event aggregate and every status transition." {
            include *
            autolayout lr
        }

        component connectsphere.venue "C3c-Venue" "Components of the venue service (E4). Owns tentative holds exclusively." {
            include *
            autolayout lr
        }

        styles {
            element "Software System" {
                background #534AB7
                color #ffffff
            }
            element "Container" {
                background #7F77DD
                color #ffffff
            }
            element "Component" {
                background #AFA9EC
                color #26215C
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
