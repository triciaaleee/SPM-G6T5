import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET ?? "";
const JWT_EXPIRES_IN = "1d";

export interface AppTokenPayload {
  sub: string;
  role: string;
}

export function signToken(payload: AppTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function verifyToken(token: string): AppTokenPayload {
  return jwt.verify(token, JWT_SECRET) as AppTokenPayload;
}
