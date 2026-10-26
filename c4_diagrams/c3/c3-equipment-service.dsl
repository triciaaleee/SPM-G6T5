workspace "ConnectSphere - C3 Equipment Service" "Level 3 of the C4 model. Components of the equipment service (E5): equipment requests, inventory, physical units and reservations." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly at its own base URL (VITE_EQUIPMENT_API_URL for this one)." "Vue 3, TypeScript, Vite, Tailwind"

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

                authMiddleware = component "Auth middleware" "Verifies the bearer token with the shared JWT_SECRET and attaches the caller's id and role; routes check role and ownership themselves." "src/middleware/auth.ts, src/lib/jwt.ts"

                requestsController = component "Equipment requests controller" "/api/equipment-requests. The assigned coordinator submits, amends (PUT /:id/items) and cancels a request for an event in Planning; Technical Support list outstanding requests, view one event's request, preview units and update an item's status, which reserves units (PATCH /:id). Also: POST /flag-for-event/:eventId from events-service after an approved change, and the organiser's POST /events/:eventId/release fallback once an event is Cancelled." "src/routes/equipmentRequests.ts" "Detailed"

                catalogController = component "Inventory controller" "/api/equipment-catalog. The stock table for today or a chosen date, add an item, add or remove stock with a reason (only free units can be removed), and the stock history." "src/routes/equipmentCatalog.ts"

                availabilityController = component "Availability controller" "GET /api/equipment-availability: how many usable units of a type are free for an event's own date and time, and the shortfall against a quantity." "src/routes/equipmentAvailability.ts"

                unitsController = component "Units controller" "/api/equipment-units. Every physical unit with its running and future out-of-use periods, the impact preview, marking units Damaged or Under Maintenance for a period, marking them usable again, and setting a unit's label." "src/routes/equipmentUnits.ts"

                # --- Rules ----------------------------------------------------

                validators = component "Input validators" "Request items (type, quantity above zero, technical requirements), status updates and amendments, new catalog items, stock changes, unavailability periods and availability queries. Every problem reported in one pass." "src/lib/validateEquipmentRequest.ts, validateCatalogItem.ts, validateStockChange.ts, validateUnavailability.ts, validateAvailabilityQuery.ts" "Wide"

                scheduleWindow = component "Schedule window" "An equipment booking's window is exactly its event's start to end, with no setup or turnaround padding (customer confirmed no transit time). Overlap maths shared by every check below." "src/lib/scheduleWindow.ts"

                unitUnavailability = component "Unit unavailability" "Reads equipment_unavailability: the periods a unit is damaged or under maintenance, and which units are out of use in a window." "src/lib/unitUnavailability.ts"

                conflicts = component "Unit conflict rules" "Per-unit conflicts against other events' bookings and out-of-use periods, shared by the read-only availability check and the reservation claim (claimUnits)." "src/lib/equipmentConflicts.ts"

                reservationFlags = component "Reservation re-check" "Re-runs the conflict check every time a request is viewed, so a reservation that no longer holds after the event moves is shown as flagged." "src/lib/reservationFlags.ts"

                unitImpact = component "Unit impact" "What marking units unusable would do: free, reserved (and for which events and coordinators) or already out of use; suggests free units first, then reserved ones furthest away." "src/lib/unitImpact.ts"

                catalogStock = component "Catalog stock" "Total, unusable, reserved and available counts per item, worked out from the unit rows on every read (catalog_stock_now function), never a stored counter. Resolves an item's name to its id." "src/lib/catalogStock.ts, src/lib/catalogLookup.ts"

                # --- Reacting to events-service ---------------------------------

                consumer = component "Message consumer" "Durable queue equipment-service with a dead-letter queue, bound to event.cancelled and event.rescheduled; routes each to its handler and acks only after it succeeds." "src/lib/rabbitConsumer.ts, src/lib/handleMessage.ts, amqplib"

                cancellation = component "Event cancellation handler" "event.cancelled: releases every reservation for the event through release_equipment_for_event (stock returned, booking rows kept as Released), then publishes equipment.released. Shared with the organiser's REST fallback. Idempotent on redelivery." "src/lib/eventCancelledHandler.ts, src/lib/eventCancellation.ts" "Wide"

                rescheduled = component "Event rescheduled handler" "event.rescheduled: moves the stored window of every unit reserved for the event, then checks what now clashes (equipment_reschedule_clashes) and reports it." "src/lib/eventRescheduledHandler.ts" "Wide"

                # --- Outbound -------------------------------------------------

                publisher = component "Event publisher" "Publishes to connectsphere.events after the write commits; best effort. equipment.requested, equipment.amended, equipment.status_changed, equipment.flagged_for_reassessment, equipment.unusable, equipment.reservation_clash, equipment.released." "src/lib/rabbitPublisher.ts, amqplib" "Wide"

                eventsClient = component "Events client" "Reads an event and other events' timing (venue-booking-info), forwarding the caller's token; reports a lost reservation with POST /:id/arrangements-changed using an internal token." "src/lib/eventsClient.ts, src/lib/internalAuth.ts"

                usersClient = component "Users client" "Coordinator display names for Technical Support's view of a request, forwarding the caller's token." "src/lib/usersClient.ts"

                dataAccess = component "Supabase client" "Service-role client; bypasses RLS, so routes enforce access. Tables: equipment_catalog, equipment (units), equipment_requests, equipment_request_items, equipment_booking, equipment_unavailability, equipment_stock_changes. Multi-step writes are Postgres functions: reserve_equipment_request, amend_equipment_request, release_equipment_for_request, release_equipment_for_event, change_equipment_stock." "src/lib/supabaseAdmin.ts, supabase-js" "Detailed"
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

        connectsphere.equipment.requestsController -> connectsphere.equipment.validators       "Validates items, status updates and amendments"
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
        connectsphere.equipment.availabilityController -> connectsphere.equipment.unitUnavailability "Leaves out units out of use in the window"
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
        connectsphere.equipment.unitUnavailability -> connectsphere.equipment.scheduleWindow     "Turns a period into a window"
        connectsphere.equipment.catalogStock       -> connectsphere.equipment.scheduleWindow     "Scopes the numbers to a day"

        connectsphere.equipment.consumer     -> connectsphere.equipment.cancellation   "Hands over event.cancelled"
        connectsphere.equipment.consumer     -> connectsphere.equipment.rescheduled    "Hands over event.rescheduled"
        connectsphere.equipment.cancellation -> connectsphere.equipment.publisher      "Emits equipment.released, reason event_cancelled"
        connectsphere.equipment.rescheduled  -> connectsphere.equipment.scheduleWindow "Builds the new window"
        connectsphere.equipment.rescheduled  -> connectsphere.equipment.eventsClient   "Reports the event if a reserved unit now clashes"
        connectsphere.equipment.rescheduled  -> connectsphere.equipment.publisher      "Emits equipment.reservation_clash"

        # =====================================================================
        # Persistence
        # =====================================================================

        connectsphere.equipment.requestsController -> connectsphere.equipment.dataAccess "Reads and writes requests and items; reserves and amends"
        connectsphere.equipment.catalogController  -> connectsphere.equipment.dataAccess "Adds items and changes stock"
        connectsphere.equipment.unitsController    -> connectsphere.equipment.dataAccess "Reads units; writes periods and labels"
        connectsphere.equipment.conflicts          -> connectsphere.equipment.dataAccess "Reads units and their bookings"
        connectsphere.equipment.unitUnavailability -> connectsphere.equipment.dataAccess "Reads equipment_unavailability"
        connectsphere.equipment.catalogStock       -> connectsphere.equipment.dataAccess "Calls catalog_stock_now"
        connectsphere.equipment.cancellation       -> connectsphere.equipment.dataAccess "Calls release_equipment_for_event"
        connectsphere.equipment.rescheduled        -> connectsphere.equipment.dataAccess "Moves stored booking windows; finds clashes"

        # =====================================================================
        # Leaving the service
        # =====================================================================

        connectsphere.equipment.dataAccess   -> connectsphere.db     "Reads and writes the equipment-service tables" "supabase-js"
        connectsphere.equipment.publisher    -> connectsphere.broker "Publishes domain events" "AMQP"
        connectsphere.equipment.eventsClient -> connectsphere.events "Reads events and venue-booking-info; POST /:id/arrangements-changed" "JSON over HTTP"
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
