import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? "";

/**
 * Creates a Supabase client scoped to the requesting user's JWT so that
 * Postgres RLS policies (organiser_id = auth.uid()) are enforced by the DB,
 * not just by application code.
 */
export function createUserScopedClient(accessToken: string): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    auth: {
/*
each request builds a fresh, short-lived client from that request's
 token.
*/
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
