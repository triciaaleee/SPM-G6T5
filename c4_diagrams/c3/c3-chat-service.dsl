workspace "ConnectSphere - C3 Chat Service" "Level 3 of the C4 model. Components of the chat service: one chat thread per event between its Organiser and assigned coordinator." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly." "Vue 3, TypeScript, Vite, Tailwind"

            events = container "Events service" "E2 and E3. The event, its status and who is assigned to it. Port 4001." "Express 5, TypeScript"

            broker = container "Message broker" "Topic exchange connectsphere.events." "RabbitMQ" "Infrastructure"

            db = container "ConnectSphere database" "One Postgres instance; each service owns its own tables." "Supabase Postgres" "Database"

            # =================================================================
            # Chat service, port 4006
            # Owns only chat_messages. The event, and who is assigned to it,
            # is read live through events-service.
            # =================================================================

            chat = container "Chat service" "Live chat between an Organiser and their event's assigned coordinator, one thread per event. Port 4006." "Express 5, TypeScript" {

                authMiddleware = component "Auth middleware" "Checks the caller's sign-in token on every request and notes who they are and their role. Each route then decides what that role may do." "src/middleware/auth.ts, src/lib/jwt.ts"

                chatController = component "Chat controller" "Shows each user their chat inbox and message history, sends messages, and marks threads as read." "src/routes/chatMessages.ts"

                accessCheck = component "Chat access check" "Lets only the event's organiser and assigned coordinator chat, and only while the event is in Planning or Confirmed. At other times the thread is hidden, not deleted." "src/routes/chatMessages.ts"

                validator = component "Message validator" "Checks a new message before it is saved." "src/lib/validateChatMessage.ts"

                publisher = component "Event publisher" "Announces each new message on the message broker once it is saved, so the other person is notified." "src/lib/rabbitPublisher.ts, amqplib"

                eventsClient = component "Events client" "Asks events-service for an event's status, organiser and coordinator, using the caller's own token." "src/lib/eventsClient.ts"

                dataAccess = component "Supabase client" "Reads and writes chat messages and whether they have been read." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        connectsphere.spa -> connectsphere.chat.authMiddleware "Opens the inbox and threads, sends messages" "JSON over HTTPS"

        connectsphere.chat.authMiddleware -> connectsphere.chat.chatController "Passes the authenticated request"
        connectsphere.chat.chatController -> connectsphere.chat.accessCheck    "Checks the caller may chat on this event"
        connectsphere.chat.chatController -> connectsphere.chat.validator      "Validates a new message"
        connectsphere.chat.chatController -> connectsphere.chat.eventsClient   "Lists the caller's events for the inbox"
        connectsphere.chat.chatController -> connectsphere.chat.publisher      "Emits message.sent"
        connectsphere.chat.chatController -> connectsphere.chat.dataAccess     "Reads and writes messages and read state"
        connectsphere.chat.accessCheck    -> connectsphere.chat.eventsClient   "Reads the event's status, organiser and coordinator"

        connectsphere.chat.dataAccess   -> connectsphere.db     "Reads and writes chat messages" "supabase-js"
        connectsphere.chat.publisher    -> connectsphere.broker "Publishes message.sent" "AMQP"
        connectsphere.chat.eventsClient -> connectsphere.events "GET /api/events and /api/events/:id" "JSON over HTTP"
    }

    views {

        component connectsphere.chat "C3-ChatService" "Components of the chat service. Owns chat_messages only; every access decision reads the event live from events-service." {
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
