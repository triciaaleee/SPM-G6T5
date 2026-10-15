import jwt from "jsonwebtoken";

/**
 * Signs a short-lived token for calls to sibling services that have no
 * end-user bearer token to forward (e.g. resolving a broker message's
 * `recipients.roles` via user-service). Separate secret from JWT_SECRET so
 * a leaked value can't forge a user session or vice versa.
 */
function getSecret(): string {
  const secret = process.env.INTERNAL_SERVICE_SECRET ?? "";
  if (!secret) {
    throw new Error("INTERNAL_SERVICE_SECRET is not set — add it to backend/.env");
  }
  return secret;
}

export function signInternalToken(serviceName: string): string {
  return jwt.sign({ svc: serviceName }, getSecret(), { expiresIn: "60s" });
}
