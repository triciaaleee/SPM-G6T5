import type { NextFunction, Response } from "express";
import { verifyInternalToken } from "../lib/internalAuth.js";
import type { AuthedRequest } from "./auth.js";

/**
 * For routes only a sibling service may call (venue-service and
 * equipment-service telling us an arrangement was lost). No end-user
 * token is accepted, so no `req.user` is set and the handler brings its own
 * database client.
 */
export function requireInternal(req: AuthedRequest, res: Response, next: NextFunction): void {
  const internalToken = req.headers["x-internal-auth"];
  if (typeof internalToken !== "string" || !internalToken) {
    res.status(401).json({ error: "Missing internal token", code: "no_internal_token" });
    return;
  }
  try {
    verifyInternalToken(internalToken);
    next();
  } catch {
    res.status(401).json({ error: "Invalid internal token", code: "invalid_internal_token" });
  }
}
