import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

/**
 * Service-role client: bypasses RLS entirely. Now that auth is custom
 * (JWT issued by this backend, not Supabase Auth), there is no
 * per-request user JWT for Supabase to scope RLS against — the backend
 * is the sole gatekeeper and must enforce ownership/role checks in
 * application code for every query made with this client.
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
