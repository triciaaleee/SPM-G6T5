workspace "ConnectSphere - C3 Venue Service" "Level 3 of the C4 model. Components of the venue service (E4): venues, unavailability and every venue booking." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly." "Vue 3, TypeScript, Vite, Tailwind"

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

                authMiddleware = component "Auth middleware" "Checks the caller's sign-in token on every request and notes who they are and their role. Each route then decides what that role may do." "src/middleware/auth.ts, src/lib/jwt.ts"

                publicController = component "Public venues controller" "Shows guests, without signing in, the venues and where listed events are held." "src/routes/publicVenues.ts"

                venuesController = component "Venues controller" "Lets coordinators search venues, get recommendations, see availability, and request, withdraw or release bookings. Events-service also uses it to check and flag bookings." "src/routes/venues.ts"

                staffController = component "Venue staff controller" "Lets Venue Staff manage their venues and work through their booking queue: hold, approve or reject requests." "src/routes/staff.ts"

                eventBookingsController = component "Event bookings controller" "Lists every booking of one event, for the event page and the safety review check." "src/routes/eventBookings.ts"

                unavailabilityController = component "Unavailability controller" "Lets Venue Staff block out a venue for a period. Approved bookings caught by it are cancelled automatically, and their coordinators told." "src/routes/unavailability.ts"

                suitabilityController = component "Suitability controller" "Shows whether each booking's venue suits that booking's headcount and needs. A guide only; never enforced." "src/routes/suitability.ts"

                attendeeInfoController = component "Attendee info controller" "Tells registration-service which venues each event is held at." "src/routes/attendeeInfo.ts"

                # --- Booking rules -------------------------------------------

                bookingStatus = component "Booking status rules" "The booking statuses and which changes between them are allowed. Defines which bookings block a venue, and the 72-hour hold." "src/lib/bookingStatus.ts"

                conflictRules = component "Occupied-window rules" "Works out when a booking occupies a venue, including setup and turnaround, and whether two bookings clash." "src/lib/bookingConflicts.ts"

                bookingDecisions = component "Booking decision handler" "Holds, approves or rejects a booking, and rejects any overlapping requests that lost. Also expires holds that ran out." "src/lib/bookingDecisions.ts"

                venueLock = component "Venue locks" "Makes sure that when two staff decide on the same venue at once, only the first decision succeeds." "src/lib/venueLock.ts, src/lib/venueBookingLock.ts"

                staffScope = component "Venue staff scope" "Lets Venue Staff decide only on bookings at venues they look after." "src/lib/venueStaff.ts"

                bookingWithdrawal = component "Withdrawal handler" "Lets the coordinator withdraw a pending booking or release a confirmed one, leaving the event's other bookings alone." "src/lib/bookingWithdrawal.ts"

                bookingPlan = component "Booking plan and suitability" "Records what each booking is for (purpose, headcount and needs) and whether its venue suits it." "src/lib/bookingPlan.ts"

                # --- Search and availability ------------------------------------

                searchRules = component "Venue search" "Matches venues against every filter the coordinator chose, and suggests which filter to drop when nothing matches." "src/lib/venueSearch.ts"

                recommendation = component "Recommendation rules" "Turns an event's written requirements into search filters, so recommendations use the same matching as search." "src/lib/venueRecommendation.ts"

                availabilityCalc = component "Availability calculator" "Works out a venue's free times from its bookings, block-outs and opening hours." "src/lib/availability.ts"

                unavailabilityRules = component "Unavailability rules" "Reads block-out periods and finds which venues and bookings they affect." "src/lib/unavailability.ts"

                # --- Venue edits ------------------------------------------------

                venueRecord = component "Venue record rules" "Checks a new or edited venue has everything it needs, including valid setup and turnaround times." "src/lib/venueRecord.ts"

                venueChanges = component "Venue change impact" "Shows what a venue edit does to existing bookings, such as capacity now too small or bookings that now overlap. Reports them; never removes them." "src/lib/venueChanges.ts"

                bufferOverlapReview = component "Buffer overlap review" "Keeps the list of overlapping bookings up to date after every booking or venue change." "src/lib/bufferOverlapReview.ts"

                # --- Reacting to events-service ---------------------------------

                consumer = component "Message consumer" "Receives event cancellations, reschedules and attendance changes from the message broker and passes each to its handler. A message is only marked done once handled." "src/lib/rabbitConsumer.ts, src/lib/handleMessage.ts, amqplib"

                cancellation = component "Event cancellation handler" "When an event is cancelled, withdraws all its bookings at once and announces each. Safe to run twice." "src/lib/eventCancelledHandler.ts, src/lib/eventCancellation.ts"

                planningEditReview = component "Planning edit reviewer" "When an event's date, time or attendance changes, re-checks its bookings. An approved booking that no longer fits is flagged for replacement." "src/lib/planningEditReview.ts"

                holdSweep = component "Expiring-hold timer" "Runs on a timer: warns coordinators before a hold expires, then expires it and frees the venue." "src/index.ts"

                # --- Outbound -------------------------------------------------

                publisher = component "Event publisher" "Announces booking and venue changes on the message broker once each change is saved, so other services can react." "src/lib/rabbitPublisher.ts, amqplib"

                eventsClient = component "Events client" "Asks events-service for event details (dates, attendance, status, coordinator) and reports bookings that were lost." "src/lib/eventsClient.ts, src/lib/internalAuth.ts"

                dataAccess = component "Supabase client" "Reads and writes venues, bookings, block-out periods and the overlap list." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        # =====================================================================
        # Callers
        # =====================================================================

        connectsphere.spa          -> connectsphere.venue.authMiddleware   "Calls the venue APIs with the user's bearer token" "JSON over HTTPS"
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
        connectsphere.venue.cancellation       -> connectsphere.venue.publisher          "Emits booking.withdrawn for each one"
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
        connectsphere.venue.venueLock                -> connectsphere.venue.dataAccess "Takes and releases the venue's lock"
        connectsphere.venue.bookingWithdrawal        -> connectsphere.venue.dataAccess "Marks the booking Withdrawn"
        connectsphere.venue.bufferOverlapReview      -> connectsphere.venue.dataAccess "Updates the overlap list"
        connectsphere.venue.cancellation             -> connectsphere.venue.dataAccess "Withdraws every active booking of the event"
        connectsphere.venue.planningEditReview       -> connectsphere.venue.dataAccess "Marks invalid Approved bookings Replacement Required"

        # =====================================================================
        # Leaving the service
        # =====================================================================

        connectsphere.venue.dataAccess   -> connectsphere.db     "Reads and writes the venue-service tables" "supabase-js"
        connectsphere.venue.publisher    -> connectsphere.broker "Publishes domain events" "AMQP"
        connectsphere.venue.eventsClient -> connectsphere.events "Reads event details; reports lost bookings" "JSON over HTTP"
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
