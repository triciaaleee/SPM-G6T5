import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { TokenExpiredError, verifyToken } from "../lib/jwt.js";

export interface AuthedRequest extends Request {
  user?: { id: string; role: string };
  supabase?: typeof supabaseAdmin;
}

/**
 * Expects `Authorization: Bearer <token>` where the token was issued by
 * this backend's own /api/auth/login (not Supabase Auth). Verifies it
 * with our JWT secret and attaches the service-role Supabase client —
 * routes are responsible for enforcing ownership/role checks themselves,
 * since RLS no longer has a per-user identity to scope against.
 *
 * Every 401 carries a `code` so the frontend can react without parsing
 * error prose: an expired token means "your session ended, log in again"
 * (E1-2 AC4/AC5), which reads differently to the user than a missing or
 * tampered one.
 */
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;

  if (!token) {
    res.status(401).json({ error: "Missing bearer token", code: "no_token" });
    return;
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, role: payload.role };
    req.supabase = supabaseAdmin;
    next();
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      res.status(401).json({ error: "Your session has expired. Please log in again.", code: "token_expired" });
      return;
    }
    res.status(401).json({ error: "Invalid token", code: "invalid_token" });
  }
}
