workspace "ConnectSphere - C3 User Service" "Level 3 of the C4 model. Components of the user service (E1): accounts, login with lockout, the JWT and the role directory." {

    !identifiers hierarchical

    model {

        connectsphere = softwareSystem "ConnectSphere Online" "Plans client events from request to completion." {

            spa = container "Web application" "Single-page app for all seven roles. Calls each service directly at its own base URL (VITE_AUTH_API_URL and VITE_USERS_API_URL for this one)." "Vue 3, TypeScript, Vite, Tailwind"

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

                authController = component "Auth controller" "Public. POST /api/auth/signup: only attendee or organiser can be self-chosen (attendee by default; internal staff accounts are seeded), email check, bcrypt hash. POST /api/auth/login: one generic error for a wrong email or password, a decoy hash so both take the same time, and a 15-minute lockout after 5 failed attempts. Returns the signed token." "src/routes/auth.ts" "Wide"

                passwordPolicy = component "Password policy" "The strength rule and the sentence that states it, side by side; rejects passwords over bcrypt's 72-byte limit. The frontend mirrors it for live feedback." "src/lib/passwordPolicy.ts"

                tokenService = component "Token service" "Signs the JWT with sub (user id) and role using JWT_SECRET, and verifies it. The secret is read lazily so a missing value fails with a clear message." "src/lib/jwt.ts, jsonwebtoken"

                authMiddleware = component "Auth middleware" "requireAuth verifies the bearer token; every 401 carries a code so an expired session reads differently from a bad token. requireAuthOrInternal also admits a sibling service's internal token." "src/middleware/auth.ts"

                internalAuth = component "Internal token verifier" "Verifies the short-lived X-Internal-Auth token a sibling service signs with INTERNAL_SERVICE_SECRET when it has no user token to forward. Separate from JWT_SECRET." "src/lib/internalAuth.ts"

                usersController = component "Users controller" "GET /me: the caller's identity. GET /names: id and name only, for organisers, coordinators and Technical Support. GET /?role=: id and name of users with a role; a Lead may list coordinators, an organiser may list coordinator leads, an internal caller any role." "src/routes/users.ts" "Wide"

                dataAccess = component "Supabase client" "Service-role client; bypasses RLS, so routes enforce access. Table: users, including the lockout counters. New ids come from the generate_user_id function." "src/lib/supabaseAdmin.ts, supabase-js"
            }
        }

        connectsphere.spa          -> connectsphere.user.authController "Signs up and logs in, no token" "JSON over HTTPS"
        connectsphere.spa          -> connectsphere.user.authMiddleware "Calls /api/users with the user's bearer token" "JSON over HTTPS"
        connectsphere.events       -> connectsphere.user.authMiddleware "Lists active coordinators, forwarding the Lead's token" "JSON over HTTP"
        connectsphere.equipment    -> connectsphere.user.authMiddleware "Reads coordinator names" "JSON over HTTP"
        connectsphere.registration -> connectsphere.user.authMiddleware "Reads attendee names for a roster" "JSON over HTTP"
        connectsphere.notification -> connectsphere.user.authMiddleware "Resolves role recipients" "JSON over HTTP, internal token"

        connectsphere.user.authController -> connectsphere.user.passwordPolicy "Checks password strength on sign-up"
        connectsphere.user.authController -> connectsphere.user.tokenService   "Signs the token after sign-up or login"
        connectsphere.user.authController -> connectsphere.user.dataAccess     "Creates users; reads and updates lockout counters"

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
