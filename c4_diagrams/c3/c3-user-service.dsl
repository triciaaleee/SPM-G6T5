workspace "ConnectSphere - C3 User Service" "Level 3 of the C4 model. Components of the user service (E1): accounts, login with lockout, the JWT and the role directory." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly." "Vue 3, TypeScript, Vite, Tailwind"

            events = container "Events service" "E2 and E3. The event and its status machine. Port 4001." "Express 5, TypeScript"

            equipment = container "Equipment service" "E5. Equipment requests, inventory and reservations. Port 4005." "Express 5, TypeScript"

            registration = container "Registration service" "E6. Attendee registrations. Port 4007." "Express 5, TypeScript"

            notification = container "Notification service" "E7. In-app notification feed. Port 4004." "Express 5, TypeScript"

            db = container "ConnectSphere database" "One Postgres instance; each service owns its own tables." "Supabase Postgres" "Database"

            # =================================================================
            # User service (E1), port 4002
            # The only service that issues tokens. Every other service only
            # verifies them with the shared JWT_SECRET. No broker connection.
            # =================================================================

            user = container "User service" "E1. Sign-up, login with lockout, issues the JWT carrying the caller's role, and the role directory. Port 4002." "Express 5, TypeScript" {

                authController = component "Auth controller" "Signs people up and logs them in, then returns their token. Only attendee or organiser can be chosen at sign-up, and accounts lock for 15 minutes after five failed logins." "src/routes/auth.ts"

                passwordPolicy = component "Password policy" "Defines how strong a password must be, with the message that explains it. The web app shows the same rule while typing." "src/lib/passwordPolicy.ts"

                tokenService = component "Token service" "Creates the sign-in token that carries the user's id and role, and checks that tokens are genuine and unexpired." "src/lib/jwt.ts, jsonwebtoken"

                authMiddleware = component "Auth middleware" "Checks the caller's sign-in token on every request, or a trusted call from another service, and tells an expired session apart from a bad token." "src/middleware/auth.ts"

                internalAuth = component "Internal token verifier" "Checks trusted calls from other services that have no user token to pass on, using a secret kept separate from sign-in tokens." "src/lib/internalAuth.ts"

                usersController = component "Users controller" "Answers who the caller is, looks up names by user id, and lists users with a given role. Each role may only list the roles it needs." "src/routes/users.ts"

                dataAccess = component "Supabase client" "Reads and writes the users table, including failed-login counts." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        connectsphere.spa          -> connectsphere.user.authController "Signs up and logs in, no token" "JSON over HTTPS"
        connectsphere.spa          -> connectsphere.user.authMiddleware "Looks up users with the user's bearer token" "JSON over HTTPS"
        connectsphere.events       -> connectsphere.user.authMiddleware "Lists active coordinators, forwarding the Lead's token" "JSON over HTTP"
        connectsphere.equipment    -> connectsphere.user.authMiddleware "Reads coordinator names" "JSON over HTTP"
        connectsphere.registration -> connectsphere.user.authMiddleware "Reads attendee names for a roster" "JSON over HTTP"
        connectsphere.notification -> connectsphere.user.authMiddleware "Resolves role recipients" "JSON over HTTP, internal token"

        connectsphere.user.authController -> connectsphere.user.passwordPolicy "Checks password strength on sign-up"
        connectsphere.user.authController -> connectsphere.user.tokenService   "Signs the token after sign-up or login"
        connectsphere.user.authController -> connectsphere.user.dataAccess     "Creates users; tracks failed logins"

        connectsphere.user.authMiddleware  -> connectsphere.user.tokenService    "Verifies the bearer token"
        connectsphere.user.authMiddleware  -> connectsphere.user.internalAuth    "Verifies an internal token"
        connectsphere.user.authMiddleware  -> connectsphere.user.usersController "Passes the authenticated request"
        connectsphere.user.usersController -> connectsphere.user.dataAccess      "Reads ids and names"

        connectsphere.user.dataAccess -> connectsphere.db "Reads and writes users" "supabase-js"
    }

    views {

        component connectsphere.user "C3-UserService" "Components of the user service (E1). Issues the JWT every other service verifies, and answers who holds a role." {
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
