import jwt from "jsonwebtoken";

export class TokenExpiredError extends Error {}

export interface AppTokenPayload {
  sub: string;
  role: string;
  /** Seconds since epoch. Set by jsonwebtoken; present on verified tokens. */
  exp?: number;
}

/**
 * Verify-only: user-service issues tokens, every other service just checks
 * them with the shared JWT_SECRET. Read lazily so a missing secret fails
 * with a clear message rather than at module load.
 */
function getSecret(): string {
  const secret = process.env.JWT_SECRET ?? "";
  if (!secret) {
    throw new Error("JWT_SECRET is not set — add it to backend/.env");
  }
  return secret;
}

/**
 * Throws TokenExpiredError when the token was valid but has aged out, so
 * callers can tell "log in again" apart from "this token is a forgery".
 */
export function verifyToken(token: string): AppTokenPayload {
  try {
    return jwt.verify(token, getSecret()) as AppTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new TokenExpiredError("Token expired");
    }
    throw err;
  }
}
