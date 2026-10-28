workspace "ConnectSphere - C3 Notification Service" "Level 3 of the C4 model. Components of the notification service (E7): the in-app feed and the consumer that fills it." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly." "Vue 3, TypeScript, Vite, Tailwind"

            user = container "User service" "E1. Accounts, login, the JWT and the role directory. Port 4002." "Express 5, TypeScript"

            broker = container "Message broker" "Topic exchange connectsphere.events. Every service except user-service publishes to it." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance; each service owns its own tables." "Supabase Postgres" "Database"

            # =================================================================
            # Notification service (E7), port 4004
            # Notifications are created only by the broker consumer, never
            # over REST. The REST API only reads and clears a user's feed.
            # =================================================================

            notification = container "Notification service" "E7. In-app notification feed with unread count, filled from every message on the broker. Port 4004." "Express 5, TypeScript" {

                authMiddleware = component "Auth middleware" "Checks the caller's sign-in token on every request and notes who they are and their role. Each route then decides what that role may do." "src/middleware/auth.ts, src/lib/jwt.ts"

                feedController = component "Feed controller" "Shows each user their own notifications, newest first, with an unread count, and marks them as read." "src/routes/notifications.ts"

                consumer = component "Message consumer" "Receives every message from the message broker and passes it on. A message is only marked done once its notifications are saved." "src/lib/rabbitConsumer.ts, amqplib"

                messageMapper = component "Message to notification mapper" "Works out who should hear about each message and saves one notification per person. Skips repeats and messages nobody needs to see." "src/lib/notificationFromMessage.ts"

                templates = component "Message templates" "Writes the wording and link for each kind of notification, sometimes differently for each person." "src/lib/messageTemplates.ts"

                usersClient = component "Users client" "Asks user-service who holds a role, such as safety officer. Uses a trusted service call, since messages carry no user token." "src/lib/usersClient.ts, src/lib/internalAuth.ts"

                dataAccess = component "Supabase client" "Reads and writes notifications, keeping each message's id so repeats can be spotted." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        connectsphere.spa    -> connectsphere.notification.authMiddleware "Polls the feed and marks notifications read" "JSON over HTTPS"
        connectsphere.broker -> connectsphere.notification.consumer       "Delivers every message; each names its recipients" "AMQP"

        connectsphere.notification.authMiddleware -> connectsphere.notification.feedController "Passes the authenticated request"
        connectsphere.notification.feedController -> connectsphere.notification.dataAccess     "Reads the caller's notifications; marks them read"

        connectsphere.notification.consumer      -> connectsphere.notification.messageMapper "Hands over each parsed message"
        connectsphere.notification.messageMapper -> connectsphere.notification.templates     "Renders the text and link for each recipient"
        connectsphere.notification.messageMapper -> connectsphere.notification.usersClient   "Resolves role recipients"
        connectsphere.notification.messageMapper -> connectsphere.notification.dataAccess    "Skips repeats; saves notifications"

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
