import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { TokenExpiredError, verifyToken } from "../lib/jwt.js";
import { verifyInternalToken } from "../lib/internalAuth.js";

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

/**
 * For routes a sibling service calls with no end-user token to forward
 * (e.g. notification-service resolving a broker message's
 * `recipients.roles`). Tries the internal `X-Internal-Auth` header first —
 * a valid one is a trusted system call, so it skips `req.user` entirely and
 * the route must treat its absence as "caller is trusted, not scoped to a
 * role". Falls back to normal `requireAuth` so existing user-initiated
 * callers are unaffected.
 */
export function requireAuthOrInternal(req: AuthedRequest, res: Response, next: NextFunction): void {
  const internalToken = req.headers["x-internal-auth"];
  if (typeof internalToken === "string" && internalToken) {
    try {
      verifyInternalToken(internalToken);
      req.supabase = supabaseAdmin;
      next();
      return;
    } catch {
      res.status(401).json({ error: "Invalid internal token", code: "invalid_internal_token" });
      return;
    }
  }

  requireAuth(req, res, next);
}
