workspace "ConnectSphere - C3 Equipment Service" "Level 3 of the C4 model. Components of the equipment service (E5): equipment requests, inventory, physical units and reservations." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly." "Vue 3, TypeScript, Vite, Tailwind"

            user = container "User service" "E1. Accounts, login, the JWT and the role directory. Port 4002." "Express 5, TypeScript"

            events = container "Events service" "E2 and E3. The event and its status machine. Port 4001." "Express 5, TypeScript"

            broker = container "Message broker" "Topic exchange connectsphere.events." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance; each service owns its own tables." "Supabase Postgres" "Database"

            # =================================================================
            # Equipment service (E5), port 4005
            # Owns the inventory, every physical unit and every reservation.
            # =================================================================

            equipment = container "Equipment service" "E5. Equipment requests, inventory, units, availability checks and reservations. Port 4005." "Express 5, TypeScript" {

                # --- Entry points -------------------------------------------

                authMiddleware = component "Auth middleware" "Checks the caller's sign-in token on every request and notes who they are and their role. Each route then decides what that role may do." "src/middleware/auth.ts, src/lib/jwt.ts"

                requestsController = component "Equipment requests controller" "Handles equipment requests. Coordinators submit, amend and cancel them; Technical Support review them and reserve units." "src/routes/equipmentRequests.ts"

                catalogController = component "Inventory controller" "Manages the inventory: shows stock for any day, adds items, and adds or removes stock with a reason." "src/routes/equipmentCatalog.ts"

                availabilityController = component "Availability controller" "Answers how many working units of a type are free for an event's date and time, and how many are short." "src/routes/equipmentAvailability.ts"

                unitsController = component "Units controller" "Manages individual units: marks them damaged or under maintenance for a period, previews which reservations that affects, and marks them usable again." "src/routes/equipmentUnits.ts"

                # --- Rules ----------------------------------------------------

                validators = component "Input validators" "Checks incoming requests, stock changes and out-of-use periods, and reports every problem at once." "src/lib/validate*.ts"

                scheduleWindow = component "Schedule window" "Works out when equipment is in use for an event: exactly the event's start to end, with no setup time either side." "src/lib/scheduleWindow.ts"

                unitUnavailability = component "Unit unavailability" "Looks up when units are damaged or under maintenance." "src/lib/unitUnavailability.ts"

                conflicts = component "Unit conflict rules" "Finds which units are free for an event, given other bookings and out-of-use periods. Shared by availability checks and reservations." "src/lib/equipmentConflicts.ts"

                reservationFlags = component "Reservation re-check" "Re-checks reservations each time a request is viewed, and flags any that no longer hold after the event moves." "src/lib/reservationFlags.ts"

                unitImpact = component "Unit impact" "Shows what taking units out of use would affect, and suggests which units to take first." "src/lib/unitImpact.ts"

                catalogStock = component "Catalog stock" "Works out total, reserved, out-of-use and available stock per item, always from the current units rather than a stored count." "src/lib/catalogStock.ts, src/lib/catalogLookup.ts"

                # --- Reacting to events-service ---------------------------------

                consumer = component "Message consumer" "Receives event cancellations and reschedules from the message broker and passes each to its handler. A message is only marked done once handled." "src/lib/rabbitConsumer.ts, src/lib/handleMessage.ts, amqplib"

                cancellation = component "Event cancellation handler" "When an event is cancelled, releases all its reservations and returns the stock. Safe to run twice." "src/lib/eventCancelledHandler.ts, src/lib/eventCancellation.ts"

                rescheduled = component "Event rescheduled handler" "When an event moves, moves its reservations to the new time and reports any that now clash." "src/lib/eventRescheduledHandler.ts"

                # --- Outbound -------------------------------------------------

                publisher = component "Event publisher" "Announces equipment changes on the message broker once each change is saved, so other services can react." "src/lib/rabbitPublisher.ts, amqplib"

                eventsClient = component "Events client" "Asks events-service for event details (dates, status, coordinator) and reports reservations that were lost." "src/lib/eventsClient.ts, src/lib/internalAuth.ts"

                usersClient = component "Users client" "Asks user-service for coordinators' names to show Technical Support." "src/lib/usersClient.ts"

                dataAccess = component "Supabase client" "Reads and writes the equipment tables. Multi-step changes, like reserving or releasing units, run as single database functions." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        # =====================================================================
        # Callers
        # =====================================================================

        connectsphere.spa    -> connectsphere.equipment.authMiddleware "Calls the equipment APIs with the user's bearer token" "JSON over HTTPS"
        connectsphere.events -> connectsphere.equipment.authMiddleware "Reads an event's requests; flags them for reassessment" "JSON over HTTP"
        connectsphere.broker -> connectsphere.equipment.consumer       "Delivers event.cancelled, event.rescheduled" "AMQP"

        # =====================================================================
        # Entry points to controllers
        # =====================================================================

        connectsphere.equipment.authMiddleware -> connectsphere.equipment.requestsController     "Passes the authenticated request"
        connectsphere.equipment.authMiddleware -> connectsphere.equipment.catalogController      "Passes the authenticated request"
        connectsphere.equipment.authMiddleware -> connectsphere.equipment.availabilityController "Passes the authenticated request"
        connectsphere.equipment.authMiddleware -> connectsphere.equipment.unitsController        "Passes the authenticated request"

        # =====================================================================
        # Controllers to rules
        # =====================================================================

        connectsphere.equipment.requestsController -> connectsphere.equipment.validators       "Checks requests and amendments"
        connectsphere.equipment.requestsController -> connectsphere.equipment.conflicts        "Claims free units when reserving"
        connectsphere.equipment.requestsController -> connectsphere.equipment.reservationFlags "Re-checks reservations on every view"
        connectsphere.equipment.requestsController -> connectsphere.equipment.cancellation     "Releases a cancelled event's reservations (fallback)"
        connectsphere.equipment.requestsController -> connectsphere.equipment.eventsClient     "Checks the event, its status and coordinator"
        connectsphere.equipment.requestsController -> connectsphere.equipment.usersClient      "Names the coordinator who raised the request"
        connectsphere.equipment.requestsController -> connectsphere.equipment.publisher        "Emits equipment.requested, amended, status_changed, flagged_for_reassessment, released"

        connectsphere.equipment.catalogController -> connectsphere.equipment.validators   "Validates new items and stock changes"
        connectsphere.equipment.catalogController -> connectsphere.equipment.catalogStock "Reads the stock numbers for a day"

        connectsphere.equipment.availabilityController -> connectsphere.equipment.validators         "Validates the query"
        connectsphere.equipment.availabilityController -> connectsphere.equipment.conflicts          "Counts free usable units"
        connectsphere.equipment.availabilityController -> connectsphere.equipment.unitUnavailability "Skips units that are out of use"
        connectsphere.equipment.availabilityController -> connectsphere.equipment.eventsClient       "Reads the event's date and time"

        connectsphere.equipment.unitsController -> connectsphere.equipment.validators         "Validates the period"
        connectsphere.equipment.unitsController -> connectsphere.equipment.unitImpact         "Previews and reports which reservations are hit"
        connectsphere.equipment.unitsController -> connectsphere.equipment.unitUnavailability "Reads each unit's out-of-use periods"
        connectsphere.equipment.unitsController -> connectsphere.equipment.catalogStock       "Resolves the item and its stock"
        connectsphere.equipment.unitsController -> connectsphere.equipment.eventsClient       "Reports each event that lost a reserved unit"
        connectsphere.equipment.unitsController -> connectsphere.equipment.publisher          "Emits equipment.unusable"

        connectsphere.equipment.conflicts          -> connectsphere.equipment.scheduleWindow     "Compares windows"
        connectsphere.equipment.conflicts          -> connectsphere.equipment.unitUnavailability "Treats out-of-use periods as blocking"
        connectsphere.equipment.conflicts          -> connectsphere.equipment.eventsClient       "Reads other events' timing"
        connectsphere.equipment.reservationFlags   -> connectsphere.equipment.scheduleWindow     "Compares windows"
        connectsphere.equipment.reservationFlags   -> connectsphere.equipment.unitUnavailability "Checks out-of-use periods"
        connectsphere.equipment.reservationFlags   -> connectsphere.equipment.eventsClient       "Reads current event timing"
        connectsphere.equipment.unitImpact         -> connectsphere.equipment.scheduleWindow     "Compares windows"
        connectsphere.equipment.unitImpact         -> connectsphere.equipment.unitUnavailability "Finds units already out of use"
        connectsphere.equipment.unitImpact         -> connectsphere.equipment.eventsClient       "Reads the affected events and their coordinators"
        connectsphere.equipment.unitUnavailability -> connectsphere.equipment.scheduleWindow     "Works out each period's dates"
        connectsphere.equipment.catalogStock       -> connectsphere.equipment.scheduleWindow     "Limits the counts to one day"

        connectsphere.equipment.consumer     -> connectsphere.equipment.cancellation   "Hands over event.cancelled"
        connectsphere.equipment.consumer     -> connectsphere.equipment.rescheduled    "Hands over event.rescheduled"
        connectsphere.equipment.cancellation -> connectsphere.equipment.publisher      "Emits equipment.released"
        connectsphere.equipment.rescheduled  -> connectsphere.equipment.scheduleWindow "Builds the new window"
        connectsphere.equipment.rescheduled  -> connectsphere.equipment.eventsClient   "Reports the event if a reserved unit now clashes"
        connectsphere.equipment.rescheduled  -> connectsphere.equipment.publisher      "Emits equipment.reservation_clash"

        # =====================================================================
        # Persistence
        # =====================================================================

        connectsphere.equipment.requestsController -> connectsphere.equipment.dataAccess "Saves requests, reservations and amendments"
        connectsphere.equipment.catalogController  -> connectsphere.equipment.dataAccess "Adds items and changes stock"
        connectsphere.equipment.unitsController    -> connectsphere.equipment.dataAccess "Reads units; writes periods and labels"
        connectsphere.equipment.conflicts          -> connectsphere.equipment.dataAccess "Reads units and their bookings"
        connectsphere.equipment.unitUnavailability -> connectsphere.equipment.dataAccess "Reads out-of-use periods"
        connectsphere.equipment.catalogStock       -> connectsphere.equipment.dataAccess "Reads stock levels"
        connectsphere.equipment.cancellation       -> connectsphere.equipment.dataAccess "Releases the event's reservations"
        connectsphere.equipment.rescheduled        -> connectsphere.equipment.dataAccess "Moves reservations to the new time"

        # =====================================================================
        # Leaving the service
        # =====================================================================

        connectsphere.equipment.dataAccess   -> connectsphere.db     "Reads and writes the equipment-service tables" "supabase-js"
        connectsphere.equipment.publisher    -> connectsphere.broker "Publishes domain events" "AMQP"
        connectsphere.equipment.eventsClient -> connectsphere.events "Reads event details; reports lost reservations" "JSON over HTTP"
        connectsphere.equipment.usersClient  -> connectsphere.user   "GET /api/users/names" "JSON over HTTP"
    }

    views {

        component connectsphere.equipment "C3-EquipmentService" "Components of the equipment service (E5). Owns the inventory, each physical unit and its out-of-use periods, and every reservation." {
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
