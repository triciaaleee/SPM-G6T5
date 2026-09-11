workspace "ConnectSphere - C1 System Context" "Level 1 of the C4 model. Scope derived from the GitHub issue backlog, epics E1-E7." {

    model {

        organiser   = person "Event organiser"         "Requests events, opens registration, raises change requests." "Role"
        coordinator = person "Event coordinator"       "Reviews requests, plans venue and equipment, drives the event lifecycle." "Role"
        venueStaff  = person "Venue staff"             "Maintains the venue catalogue and availability, decides booking requests." "Role"
        techSupport = person "Technical support staff" "Maintains equipment inventory and reserves items against events." "Role"
        attendee    = person "Attendee"                "Discovers events open for registration, registers and withdraws." "Role"

        # Supabase Auth is the only external dependency. Issue #63 confirms no integration
        # with existing tools, and E7-1 fixes notification delivery as in-app only, so there
        # is deliberately no email, SMS or payment provider in this diagram.
        supabaseAuth = softwareSystem "Supabase Auth" "Managed identity provider. Issues the JWT that every request carries and verifies it on demand." "External"

        connectsphere = softwareSystem "ConnectSphere" "Plans campus events end to end: request intake, coordinator review, venue and equipment arrangement, confirmation, completion and cancellation."

        organiser   -> connectsphere "Submits and manages event requests, configures registration"
        coordinator -> connectsphere "Reviews requests, plans arrangements, decides change requests"
        venueStaff  -> connectsphere "Maintains venues and availability, decides booking requests"
        techSupport -> connectsphere "Maintains equipment inventory, reserves items"
        attendee    -> connectsphere "Discovers events, registers, withdraws"

        connectsphere -> supabaseAuth "Authenticates users and verifies access tokens" "HTTPS"
    }

    views {

        systemContext connectsphere "C1-SystemContext" "Who uses ConnectSphere and the one system it depends on." {
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
            element "External" {
                background #888780
                color #ffffff
            }
            relationship "Relationship" {
                thickness 2
            }
        }

        theme default
    }
}
