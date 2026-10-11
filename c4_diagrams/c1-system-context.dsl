workspace "ConnectSphere - C1 System Context" "Level 1 of the C4 model. Scope derived from the GitHub issue backlog (epics E1-E7) and the Week 7 customer changes." {

    model {

        organiser   = person "Event organiser"         "External client. Submits and edits event requests, answers clarifications, opens registration, raises change requests and cancels their own events." "Role"
        lead        = person "Event coordinator lead"  "Internal. Watches the unassigned queue, assigns each new request to a coordinator, reassigns events and oversees every coordinator's workload." "Role"
        coordinator = person "Event coordinator"       "Internal. Reviews the requests assigned to them, plans venues and equipment, submits events for safety review and decides change requests." "Role"
        safetyOfficer = person "Safety officer"        "Internal. Runs the Operational Safety Check on planned events: approves, rejects or requests changes." "Role"
        venueStaff  = person "Venue staff"             "Internal. Maintains venues, setup and turnaround times and unavailability; holds, approves or rejects booking requests." "Role"
        techSupport = person "Technical support staff" "Internal. Maintains equipment inventory and reserves items against events." "Role"
        attendee    = person "Attendee"                "Discovers events open for registration, registers and withdraws." "Role"

        # ConnectSphere has no external software dependencies. Issue #63 confirms no
        # integration with existing tools, accounts and tokens are issued by
        # ConnectSphere itself (user-service), and E7-1 fixes notification delivery
        # as in-app only, so there is no identity, email, SMS or payment provider here.

        connectsphere = softwareSystem "ConnectSphere" "Plans client events end to end: request intake, assignment by the coordinator lead, coordinator review, venue and equipment arrangement, the Operational Safety Check, confirmation, attendee registration, completion and cancellation."

        organiser     -> connectsphere "Submits and tracks event requests, configures registration, raises change requests, cancels events"
        lead          -> connectsphere "Assigns and reassigns coordinators, views all assignments"
        coordinator   -> connectsphere "Reviews requests, books venues, requests equipment, submits for safety review"
        safetyOfficer -> connectsphere "Reviews events awaiting the Operational Safety Check and records the outcome"
        venueStaff    -> connectsphere "Maintains venues and unavailability, decides booking requests"
        techSupport   -> connectsphere "Maintains equipment inventory, reserves items"
        attendee      -> connectsphere "Discovers events, registers, withdraws"
    }

    views {

        systemContext connectsphere "C1-SystemContext" "Who uses ConnectSphere. Seven roles; no external systems." {
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
            relationship "Relationship" {
                thickness 2
            }
        }

        theme default
    }
}
