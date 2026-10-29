import jwt, { type SignOptions } from "jsonwebtoken";
import { clock } from "../lib/clock.js";

/** jwt.sign with the token issued at the injected clock's "now", so expiry never depends on when the suite runs. */
export function signWithClock(payload: Record<string, unknown>, secret: string, options: SignOptions = {}): string {
  return jwt.sign({ ...payload, iat: Math.floor(clock.now().getTime() / 1000) }, secret, options);
}
