import type { NextFunction, Request, Response } from "express";
import { createUserScopedClient } from "../lib/supabase.js";

export interface AuthedRequest extends Request {
  user?: { id: string };
  supabase?: ReturnType<typeof createUserScopedClient>;
}

/**
 * Expects `Authorization: Bearer <supabase access token>`. Verifies the
 * token with Supabase and attaches a user-scoped client (so RLS applies)
 * plus req.user for downstream ownership checks.
 */
export async function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

/*

uses user's own access token as authorisation header on DB request instead of privilleged 
service-role key as postgres RLS policies only allows the user to the rows they own. 

*/

  const supabase = createUserScopedClient(token);
  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data.user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  req.user = { id: data.user.id };
  req.supabase = supabase;
  next();
}
