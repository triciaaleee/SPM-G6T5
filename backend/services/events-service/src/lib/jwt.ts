import jwt from "jsonwebtoken";

const JWT_EXPIRES_IN = "1d";

export class TokenExpiredError extends Error {}

export interface AppTokenPayload {
  sub: string;
  role: string;
  /** Seconds since epoch. Set by jsonwebtoken; present on verified tokens. */
  exp?: number;
}

/**
 * Read the secret lazily rather than at module load. jsonwebtoken throws a
 * cryptic "secretOrPrivateKey must have a value" if it's empty, which is a
 * confusing first failure for anyone who hasn't filled in their .env — and
 * a module-load throw would also break test files that set env vars in a
 * setup hook. index.ts additionally checks this at boot so the problem
 * surfaces on startup rather than on the first login attempt.
 */
function getSecret(): string {
  const secret = process.env.JWT_SECRET ?? "";
  if (!secret) {
    throw new Error("JWT_SECRET is not set — add it to backend/services/events-service/.env");
  }
  return secret;
}

export function signToken(payload: { sub: string; role: string }): string {
  return jwt.sign(payload, getSecret(), { expiresIn: JWT_EXPIRES_IN });
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
