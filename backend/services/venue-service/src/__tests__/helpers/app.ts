import express, { type Router } from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET ||= "test-jwt-secret";
process.env.INTERNAL_SERVICE_SECRET ||= "test-internal-secret";

/** A tiny express app with one router mounted, using the REAL auth middleware. */
export function appWith(path: string, router: Router) {
  const app = express();
  app.use(express.json());
  app.use(path, router);
  return app;
}

/** `Authorization` header value for a real, signed token. */
export const bearer = (id: string, role: string) => `Bearer ${jwt.sign({ sub: id, role }, process.env.JWT_SECRET!, { expiresIn: "1h" })}`;
export const COORD = bearer("COORD-0001", "coordinator");
export const STAFF = bearer("VEN-0001", "venue_staff");
export const ATTENDEE = bearer("ATT-0001", "attendee");
export const ORGANISER = bearer("ORG-0001", "organiser");

/**
 * Calls a route's own handler directly, bypassing HTTP. Used for the
 * `Array.isArray(req.params.x)` branches: Express always hands over a string
 * for a `:param`, so only a direct call can reach the array side.
 */
export async function callRoute(
  router: Router,
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  req: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path} route`);
  const handlers = layer.route.stack as { handle: (req: unknown, res: unknown, next: () => void) => unknown }[];
  const out = { status: 200, body: undefined as unknown };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
    end() { return res; },
  };
  await handlers[handlers.length - 1].handle(
    { headers: { authorization: "Bearer direct" }, query: {}, body: {}, params: {}, ...req },
    res,
    () => {},
  );
  return out;
}
