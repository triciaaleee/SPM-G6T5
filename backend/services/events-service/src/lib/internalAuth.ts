import jwt from "jsonwebtoken";
import { clock } from "./clock.js";

/**
 * Verifies the short-lived token a sibling service signs when it calls us
 * with no end-user bearer token to forward (e.g. venue-service's scheduled
 * expiring-hold sweep resolving a booking's coordinator). Separate secret
 * from JWT_SECRET so a leaked value can't forge a user session or vice versa.
 */
function getSecret(): string {
  const secret = process.env.INTERNAL_SERVICE_SECRET ?? "";
  if (!secret) {
    throw new Error("INTERNAL_SERVICE_SECRET is not set — add it to backend/.env");
  }
  return secret;
}

export interface InternalTokenPayload {
  svc: string;
}

export function verifyInternalToken(token: string): InternalTokenPayload {
  return jwt.verify(token, getSecret(), { clockTimestamp: Math.floor(clock.now().getTime() / 1000) }) as InternalTokenPayload;
}
