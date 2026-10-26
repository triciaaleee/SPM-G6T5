workspace "ConnectSphere - C3 Venue Service" "Level 3 of the C4 model. Components of the venue service (E4): venues, unavailability and every venue booking." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly at its own base URL (VITE_VENUES_API_URL for this one)." "Vue 3, TypeScript, Vite, Tailwind"

            events = container "Events service" "E2 and E3. The event and its status machine. Port 4001." "Express 5, TypeScript"

            registration = container "Registration service" "E6. Attendee registrations. Port 4007." "Express 5, TypeScript"

            broker = container "Message broker" "Topic exchange connectsphere.events." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance; each service owns its own tables." "Supabase Postgres" "Database"

            # =================================================================
            # Venue service (E4), port 4003
            # Owns venues, unavailability and every venue booking.
            # =================================================================

            venue = container "Venue service" "E4. Venues, unavailability, availability, search and bookings. Port 4003." "Express 5, TypeScript" {

                # --- Entry points -------------------------------------------

                authMiddleware = component "Auth middleware" "Verifies the bearer token with the shared JWT_SECRET and attaches the caller's id and role; routes check role and ownership themselves." "src/middleware/auth.ts, src/lib/jwt.ts"

                publicController = component "Public venues controller" "GET /api/venues/public and /public/event-venues, no login: venues and where listed events are held, for the public landing pages." "src/routes/publicVenues.ts"

                venuesController = component "Venues controller" "Coordinator side. GET /filters, search (GET /), GET /recommendations/:eventId, GET /:venueId/availability, POST /bookings to request one or more venues per event with a purpose and headcount, POST /bookings/:id/withdraw and /release. Also called by events-service: GET /bookings/:id/availability-check and POST /bookings/:id/flag-for-rebooking." "src/routes/venues.ts" "Detailed"

                staffController = component "Venue staff controller" "Venue Staff side. Their venues, create and edit venue records with setup and turnaround times (preview first), the buffer-overlap review list, each venue's schedule, the request queue ordered by event date, and POST /bookings/:id/hold, /approve and /reject." "src/routes/staff.ts" "Wide"

                eventBookingsController = component "Event bookings controller" "GET /api/venues/events/:eventId/bookings: every booking of one event with its venue and capacity, for the event page and events-service's safety review gate." "src/routes/eventBookings.ts"

                unavailabilityController = component "Unavailability controller" "List, preview, record, edit and remove block-out periods with a reason. A saved period automatically cancels clashing Approved bookings and tells each clashing booking's coordinator; pending ones keep their status (Week 7 change 2)." "src/routes/unavailability.ts" "Wide"

                suitabilityController = component "Suitability controller" "GET /api/venues/suitability/:eventId: whether each booking's venue suits that booking's own headcount and needs. Shown, never enforced." "src/routes/suitability.ts"

                attendeeInfoController = component "Attendee info controller" "GET /api/venues/attendee-info?eventIds: venue names of each event's Approved bookings only, for registration-service (E6)." "src/routes/attendeeInfo.ts"

                # --- Booking rules -------------------------------------------

                bookingStatus = component "Booking status rules" "The eight booking statuses in enum order, canTransition(), the statuses that block a venue (Approved, and On Hold until it expires), and the fixed 72-hour hold." "src/lib/bookingStatus.ts"

                conflictRules = component "Occupied-window rules" "Event start minus setup to event end plus turnaround; two bookings conflict only when their occupied windows overlap. Shared by search, recommendations, submission and decisions." "src/lib/bookingConflicts.ts"

                bookingDecisions = component "Booking decision handler" "Hold, approve or reject: re-checks conflicts, writes the status, auto-rejects the overlapping requests that lost, re-checks after the write and yields if a rival won. Also expires lapsed holds on read and runs the expiring-hold sweep." "src/lib/bookingDecisions.ts" "Wide"

                venueLock = component "Venue locks" "Two guards so of two simultaneous decisions on one venue only the first succeeds: an in-process queue per venue, and a cross-process lock row in venue_booking_locks." "src/lib/venueLock.ts, src/lib/venueBookingLock.ts"

                staffScope = component "Venue staff scope" "Venue Staff decide only on bookings at venues they look after (venues.staff_id)." "src/lib/venueStaff.ts"

                bookingWithdrawal = component "Withdrawal handler" "The coordinator withdraws a Requested or On Hold booking, or releases an Approved or Replacement Required one. Other bookings of the event are untouched." "src/lib/bookingWithdrawal.ts"

                bookingPlan = component "Booking plan and suitability" "Each booking's purpose, headcount and required layouts, facilities and accessibility, pre-filled from the event. A venue suits a booking when capacity covers the headcount and every required feature is present." "src/lib/bookingPlan.ts" "Wide"

                # --- Search and availability ------------------------------------

                searchRules = component "Venue search" "Pure query parsing and all-criteria matching, kept free of Express and Supabase; suggests which filter to relax when nothing matches. The controller drops blocked-out and clashing venues before matching." "src/lib/venueSearch.ts"

                recommendation = component "Recommendation rules" "Turns the event's free-text requirements into search criteria, so recommended means passes the same all-criteria match as search." "src/lib/venueRecommendation.ts"

                availabilityCalc = component "Availability calculator" "Merges blocking bookings, unavailability and operating hours into free slots, padded by setup and turnaround." "src/lib/availability.ts"

                unavailabilityRules = component "Unavailability rules" "Parses a period (all day, or the same hours each day), finds blocked venues for a slot and the bookings whose occupied window overlaps a period." "src/lib/unavailability.ts"

                # --- Venue edits ------------------------------------------------

                venueRecord = component "Venue record rules" "Validation shared by create and update: mandatory attributes, whole-minute setup and turnaround, operating hours." "src/lib/venueRecord.ts"

                venueChanges = component "Venue change impact" "What an edit does to existing bookings: capacity cut below a future Approved booking's attendance, and pairs whose occupied windows now overlap under the new setup or turnaround. Identified and reported, never removed." "src/lib/venueChanges.ts" "Wide"

                bufferOverlapReview = component "Buffer overlap review" "Reconciles the stored venue_buffer_overlaps list with the overlaps computed now: adds new pairs, removes resolved ones, leaves the rest. Runs after every decision, withdrawal, block-out and venue edit." "src/lib/bufferOverlapReview.ts"

                # --- Reacting to events-service ---------------------------------

                consumer = component "Message consumer" "Durable queue venue-service with a dead-letter queue, bound to event.cancelled, event.rescheduled and event.attendance_changed; routes each to its handler and acks only after it succeeds." "src/lib/rabbitConsumer.ts, src/lib/handleMessage.ts, amqplib" "Wide"

                cancellation = component "Event cancellation handler" "event.cancelled: withdraws every active booking of the event at once and announces each with booking.withdrawn. Idempotent on redelivery." "src/lib/eventCancelledHandler.ts, src/lib/eventCancellation.ts"

                planningEditReview = component "Planning edit reviewer" "event.rescheduled and event.attendance_changed: re-checks the event's live bookings against block-outs, other bookings and capacity. An Approved one that no longer fits becomes Replacement Required; pending ones are only reported (AGENTS.md section 3a)." "src/lib/planningEditReview.ts" "Wide"

                holdSweep = component "Expiring-hold timer" "setInterval in index.ts that runs the hold sweep: warns the coordinator before a hold lapses and marks lapsed holds Expired, releasing the venue." "src/index.ts"

                # --- Outbound -------------------------------------------------

                publisher = component "Event publisher" "Publishes to connectsphere.events after the write commits; best effort. booking.requested, booking.decided, booking.withdrawn, booking.flagged_for_rebooking, booking.replacement_required, booking.unavailability_clash, booking.invalidated_by_edit, booking.setup_conflict, venue.capacity_reduced, hold.expiring, hold.expired." "src/lib/rabbitPublisher.ts, amqplib" "Detailed"

                eventsClient = component "Events client" "Reads event timing, attendance, status and coordinator (forwarding the caller's token, or an internal token for the sweep), lists public events, and reports a lost booking with POST /:id/arrangements-changed." "src/lib/eventsClient.ts, src/lib/internalAuth.ts" "Wide"

                dataAccess = component "Supabase client" "Service-role client; bypasses RLS, so routes enforce access. Tables: venues, venue_bookings, venue_unavailability, venue_buffer_overlaps, venue_booking_locks." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        # =====================================================================
        # Callers
        # =====================================================================

        connectsphere.spa          -> connectsphere.venue.authMiddleware   "Calls /api/venues with the user's bearer token" "JSON over HTTPS"
        connectsphere.spa          -> connectsphere.venue.publicController "Shows venues to guests, no token" "JSON over HTTPS"
        connectsphere.events       -> connectsphere.venue.authMiddleware   "Reads an event's bookings, checks availability, flags for rebooking" "JSON over HTTP"
        connectsphere.registration -> connectsphere.venue.authMiddleware   "Reads venue names for attendees" "JSON over HTTP"
        connectsphere.broker       -> connectsphere.venue.consumer         "Delivers event.cancelled, event.rescheduled, event.attendance_changed" "AMQP"

        # =====================================================================
        # Entry points to controllers
        # =====================================================================

        connectsphere.venue.authMiddleware -> connectsphere.venue.venuesController         "Passes the authenticated request"
        connectsphere.venue.authMiddleware -> connectsphere.venue.staffController          "Passes the authenticated request"
        connectsphere.venue.authMiddleware -> connectsphere.venue.eventBookingsController  "Passes the authenticated request"
        connectsphere.venue.authMiddleware -> connectsphere.venue.unavailabilityController "Passes the authenticated request"
        connectsphere.venue.authMiddleware -> connectsphere.venue.suitabilityController    "Passes the authenticated request"
        connectsphere.venue.authMiddleware -> connectsphere.venue.attendeeInfoController   "Passes the authenticated request"

        # =====================================================================
        # Controllers to rules
        # =====================================================================

        connectsphere.venue.venuesController -> connectsphere.venue.searchRules       "Searches and filters venues"
        connectsphere.venue.venuesController -> connectsphere.venue.recommendation    "Recommends venues for an event"
        connectsphere.venue.venuesController -> connectsphere.venue.availabilityCalc  "Builds the availability calendar"
        connectsphere.venue.venuesController -> connectsphere.venue.conflictRules     "Excludes clashing venues; rejects a request that clashes with a hold or approved booking"
        connectsphere.venue.venuesController -> connectsphere.venue.unavailabilityRules "Excludes blocked-out venues; refuses a request over a block-out"
        connectsphere.venue.venuesController -> connectsphere.venue.bookingPlan       "Parses each booking's purpose, headcount and needs"
        connectsphere.venue.venuesController -> connectsphere.venue.bookingStatus     "Checks the transition to Replacement Required"
        connectsphere.venue.venuesController -> connectsphere.venue.bookingWithdrawal "Withdraws or releases a booking"
        connectsphere.venue.venuesController -> connectsphere.venue.eventsClient      "Reads the event and checks its coordinator"
        connectsphere.venue.venuesController -> connectsphere.venue.publisher         "Emits booking.requested, booking.flagged_for_rebooking"

        connectsphere.venue.staffController -> connectsphere.venue.staffScope          "Checks the staff member looks after this venue"
        connectsphere.venue.staffController -> connectsphere.venue.bookingDecisions    "Holds, approves or rejects"
        connectsphere.venue.staffController -> connectsphere.venue.venueRecord         "Validates a new or edited venue"
        connectsphere.venue.staffController -> connectsphere.venue.venueChanges        "Previews and reports the edit's impact on bookings"
        connectsphere.venue.staffController -> connectsphere.venue.bufferOverlapReview "Refreshes the overlap review list after an edit"
        connectsphere.venue.staffController -> connectsphere.venue.eventsClient        "Reads event timing for the schedule and queue"

        connectsphere.venue.unavailabilityController -> connectsphere.venue.unavailabilityRules "Parses the period and finds clashing bookings"
        connectsphere.venue.unavailabilityController -> connectsphere.venue.bookingStatus       "Cancels clashing Approved bookings"
        connectsphere.venue.unavailabilityController -> connectsphere.venue.bufferOverlapReview "Clears overlaps the cancellation resolved"
        connectsphere.venue.unavailabilityController -> connectsphere.venue.eventsClient        "Reads event timing; reports each event that lost a booking"
        connectsphere.venue.unavailabilityController -> connectsphere.venue.publisher           "Emits booking.replacement_required, booking.unavailability_clash"

        connectsphere.venue.eventBookingsController -> connectsphere.venue.eventsClient "Checks the caller may see the event"
        connectsphere.venue.suitabilityController   -> connectsphere.venue.bookingPlan  "Judges each booking on its own plan"
        connectsphere.venue.suitabilityController   -> connectsphere.venue.eventsClient "Reads the event's attendance and requirements"
        connectsphere.venue.publicController        -> connectsphere.venue.eventsClient "Lists the public events"

        connectsphere.venue.bookingDecisions -> connectsphere.venue.venueLock           "Serialises decisions for the venue"
        connectsphere.venue.bookingDecisions -> connectsphere.venue.staffScope          "Checks the decider looks after the venue"
        connectsphere.venue.bookingDecisions -> connectsphere.venue.bookingStatus       "Checks the transition and sets the hold expiry"
        connectsphere.venue.bookingDecisions -> connectsphere.venue.conflictRules       "Re-checks the occupied window before and after the write"
        connectsphere.venue.bookingDecisions -> connectsphere.venue.unavailabilityRules "Refuses a hold or approval over a block-out"
        connectsphere.venue.bookingDecisions -> connectsphere.venue.bufferOverlapReview "Refreshes the overlap review list"
        connectsphere.venue.bookingDecisions -> connectsphere.venue.eventsClient        "Reads event timing and status"
        connectsphere.venue.bookingDecisions -> connectsphere.venue.publisher           "Emits booking.decided, hold.expiring, hold.expired"

        connectsphere.venue.bookingWithdrawal -> connectsphere.venue.bufferOverlapReview "Clears overlaps the release resolved"
        connectsphere.venue.bookingWithdrawal -> connectsphere.venue.eventsClient        "Checks the caller is the event's coordinator"
        connectsphere.venue.bookingWithdrawal -> connectsphere.venue.publisher           "Emits booking.withdrawn"

        connectsphere.venue.recommendation   -> connectsphere.venue.searchRules         "Reuses the all-criteria match"
        connectsphere.venue.availabilityCalc -> connectsphere.venue.unavailabilityRules "Subtracts block-out periods"
        connectsphere.venue.venueChanges     -> connectsphere.venue.conflictRules       "Recomputes occupied windows"
        connectsphere.venue.venueChanges     -> connectsphere.venue.eventsClient        "Reads event timing and attendance"
        connectsphere.venue.venueChanges     -> connectsphere.venue.publisher           "Emits booking.setup_conflict, venue.capacity_reduced"

        connectsphere.venue.consumer           -> connectsphere.venue.cancellation       "Hands over event.cancelled"
        connectsphere.venue.consumer           -> connectsphere.venue.planningEditReview "Hands over event.rescheduled and event.attendance_changed"
        connectsphere.venue.cancellation       -> connectsphere.venue.bufferOverlapReview "Clears overlaps the release resolved"
        connectsphere.venue.cancellation       -> connectsphere.venue.publisher          "Emits booking.withdrawn for each one, reason event_cancelled"
        connectsphere.venue.planningEditReview -> connectsphere.venue.conflictRules      "Re-checks the new occupied window"
        connectsphere.venue.planningEditReview -> connectsphere.venue.bookingDecisions   "Reads the windows other bookings block"
        connectsphere.venue.planningEditReview -> connectsphere.venue.unavailabilityRules "Checks the new window against block-outs"
        connectsphere.venue.planningEditReview -> connectsphere.venue.bookingStatus      "Checks the move to Replacement Required"
        connectsphere.venue.planningEditReview -> connectsphere.venue.eventsClient       "Reports each event whose Approved booking was flagged"
        connectsphere.venue.planningEditReview -> connectsphere.venue.publisher          "Emits booking.invalidated_by_edit"
        connectsphere.venue.holdSweep          -> connectsphere.venue.bookingDecisions   "Runs the expiring-hold sweep on a timer"

        # =====================================================================
        # Persistence
        # =====================================================================

        connectsphere.venue.venuesController         -> connectsphere.venue.dataAccess "Reads venues and writes booking requests"
        connectsphere.venue.staffController          -> connectsphere.venue.dataAccess "Reads and writes venue records"
        connectsphere.venue.eventBookingsController  -> connectsphere.venue.dataAccess "Reads the event's bookings"
        connectsphere.venue.unavailabilityController -> connectsphere.venue.dataAccess "Writes periods and Cancelled bookings"
        connectsphere.venue.attendeeInfoController   -> connectsphere.venue.dataAccess "Reads Approved bookings and venue names"
        connectsphere.venue.publicController         -> connectsphere.venue.dataAccess "Reads venues"
        connectsphere.venue.bookingDecisions         -> connectsphere.venue.dataAccess "Writes the decision and auto-rejects the losers"
        connectsphere.venue.venueLock                -> connectsphere.venue.dataAccess "Takes and releases the venue_booking_locks row"
        connectsphere.venue.bookingWithdrawal        -> connectsphere.venue.dataAccess "Marks the booking Withdrawn"
        connectsphere.venue.bufferOverlapReview      -> connectsphere.venue.dataAccess "Reconciles venue_buffer_overlaps"
        connectsphere.venue.cancellation             -> connectsphere.venue.dataAccess "Withdraws every active booking of the event"
        connectsphere.venue.planningEditReview       -> connectsphere.venue.dataAccess "Marks invalid Approved bookings Replacement Required"

        # =====================================================================
        # Leaving the service
        # =====================================================================

        connectsphere.venue.dataAccess   -> connectsphere.db     "Reads and writes the venue-service tables" "supabase-js"
        connectsphere.venue.publisher    -> connectsphere.broker "Publishes domain events" "AMQP"
        connectsphere.venue.eventsClient -> connectsphere.events "Reads events and venue-booking-info; POST /:id/arrangements-changed" "JSON over HTTP"
    }

    views {

        component connectsphere.venue "C3-VenueService" "Components of the venue service (E4). Owns venues, unavailability and every booking, including expiring holds, setup and turnaround, and multi-venue bookings." {
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
