workspace "ConnectSphere - C3 Notification Service" "Level 3 of the C4 model. Components of the notification service (E7): the in-app feed and the consumer that fills it." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly at its own base URL (VITE_NOTIFICATIONS_API_URL for this one)." "Vue 3, TypeScript, Vite, Tailwind"

            user = container "User service" "E1. Accounts, login, the JWT and the role directory. Port 4002." "Express 5, TypeScript"

            broker = container "Message broker" "Topic exchange connectsphere.events. Every service except user-service publishes to it." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance; each service owns its own tables." "Supabase Postgres" "Database"

            # =================================================================
            # Notification service (E7), port 4004
            # Notifications are created only by the broker consumer, never
            # over REST. The REST API only reads and clears a user's feed.
            # =================================================================

            notification = container "Notification service" "E7. In-app notification feed with unread count, filled from every message on the broker. Port 4004." "Express 5, TypeScript" {

                authMiddleware = component "Auth middleware" "Verifies the bearer token with the shared JWT_SECRET and attaches the caller's id; every 401 carries a code." "src/middleware/auth.ts, src/lib/jwt.ts"

                feedController = component "Feed controller" "GET /api/notifications: the caller's own notifications, newest first, paged by a before cursor, with the unread count on the first page. POST /read marks all read; POST /:id/read marks one." "src/routes/notifications.ts"

                consumer = component "Message consumer" "Durable queue notification-service bound to # (every message), with a dead-letter queue. Parses the shared envelope and acks only after the rows are written." "src/lib/rabbitConsumer.ts, amqplib"

                messageMapper = component "Message to notification mapper" "Skips messages nobody is notified about (event.rescheduled, event.attendance_changed) and any messageId already stored, merges the named user ids with the role groups resolved through user-service, and inserts one row per recipient." "src/lib/notificationFromMessage.ts" "Wide"

                templates = component "Message templates" "The text and link for each message type, sometimes per recipient (for example coordinator.assigned reads differently to the coordinator and the organiser). Attendees get attendee links." "src/lib/messageTemplates.ts"

                usersClient = component "Users client" "Resolves a role group such as coordinator_lead, safety_officer or technical_support to user ids. A queue message has no user token, so it signs a short-lived internal token with INTERNAL_SERVICE_SECRET." "src/lib/usersClient.ts, src/lib/internalAuth.ts" "Wide"

                dataAccess = component "Supabase client" "Service-role client; bypasses RLS, so routes enforce access. Table: notifications, including message_id for deduplication." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        connectsphere.spa    -> connectsphere.notification.authMiddleware "Polls the feed and marks notifications read" "JSON over HTTPS"
        connectsphere.broker -> connectsphere.notification.consumer       "Delivers every message; each names its recipients" "AMQP"

        connectsphere.notification.authMiddleware -> connectsphere.notification.feedController "Passes the authenticated request"
        connectsphere.notification.feedController -> connectsphere.notification.dataAccess     "Reads the caller's rows; sets read_at"

        connectsphere.notification.consumer      -> connectsphere.notification.messageMapper "Hands over each parsed message"
        connectsphere.notification.messageMapper -> connectsphere.notification.templates     "Renders the text and link for each recipient"
        connectsphere.notification.messageMapper -> connectsphere.notification.usersClient   "Resolves role recipients"
        connectsphere.notification.messageMapper -> connectsphere.notification.dataAccess    "Skips a seen messageId; inserts the rows"

        connectsphere.notification.dataAccess  -> connectsphere.db   "Reads and writes notifications" "supabase-js"
        connectsphere.notification.usersClient -> connectsphere.user "GET /api/users?role=" "JSON over HTTP, internal token"
    }

    views {

        component connectsphere.notification "C3-NotificationService" "Components of the notification service (E7). The broker consumer writes every notification; the REST API only reads and clears the feed." {
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
