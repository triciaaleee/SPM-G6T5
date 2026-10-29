// @ts-nocheck
// 
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { TokenExpiredError, verifyToken } from "../lib/jwt.js";
import { verifyInternalToken } from "../lib/internalAuth.js";
export interface AuthedRequest extends Request {
  user?: {
    id: string;
    role: string;
  };
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
  if (stryMutAct_9fa48("1291")) {
    {}
  } else {
    stryCov_9fa48("1291");
    const header = req.headers.authorization;
    const token = (stryMutAct_9fa48("1293") ? header.startsWith("Bearer ") : stryMutAct_9fa48("1292") ? header?.endsWith("Bearer ") : (stryCov_9fa48("1292", "1293"), header?.startsWith(stryMutAct_9fa48("1294") ? "" : (stryCov_9fa48("1294"), "Bearer ")))) ? stryMutAct_9fa48("1295") ? header : (stryCov_9fa48("1295"), header.slice((stryMutAct_9fa48("1296") ? "" : (stryCov_9fa48("1296"), "Bearer ")).length)) : undefined;
    if (stryMutAct_9fa48("1299") ? false : stryMutAct_9fa48("1298") ? true : stryMutAct_9fa48("1297") ? token : (stryCov_9fa48("1297", "1298", "1299"), !token)) {
      if (stryMutAct_9fa48("1300")) {
        {}
      } else {
        stryCov_9fa48("1300");
        res.status(401).json(stryMutAct_9fa48("1302") ? {} : (stryCov_9fa48("1302"), {
          error: stryMutAct_9fa48("1303") ? "" : (stryCov_9fa48("1303"), "Missing bearer token"),
          code: stryMutAct_9fa48("1304") ? "" : (stryCov_9fa48("1304"), "no_token")
        }));
        return;
      }
    }
    try {
      if (stryMutAct_9fa48("1305")) {
        {}
      } else {
        stryCov_9fa48("1305");
        const payload = verifyToken(token);
        req.user = stryMutAct_9fa48("1306") ? {} : (stryCov_9fa48("1306"), {
          id: payload.sub,
          role: payload.role
        });
        req.supabase = supabaseAdmin;
        if (stryMutAct_9fa48("1307")) {
          ;
        } else {
          stryCov_9fa48("1307");
          next();
        }
      }
    } catch (err) {
      if (stryMutAct_9fa48("1308")) {
        {}
      } else {
        stryCov_9fa48("1308");
        if (stryMutAct_9fa48("1310") ? false : stryMutAct_9fa48("1309") ? true : (stryCov_9fa48("1309", "1310"), err instanceof TokenExpiredError)) {
          if (stryMutAct_9fa48("1311")) {
            {}
          } else {
            stryCov_9fa48("1311");
            res.status(401).json(stryMutAct_9fa48("1313") ? {} : (stryCov_9fa48("1313"), {
              error: stryMutAct_9fa48("1314") ? "" : (stryCov_9fa48("1314"), "Your session has expired. Please log in again."),
              code: stryMutAct_9fa48("1315") ? "" : (stryCov_9fa48("1315"), "token_expired")
            }));
            return;
          }
        }
        res.status(401).json(stryMutAct_9fa48("1317") ? {} : (stryCov_9fa48("1317"), {
          error: stryMutAct_9fa48("1318") ? "" : (stryCov_9fa48("1318"), "Invalid token"),
          code: stryMutAct_9fa48("1319") ? "" : (stryCov_9fa48("1319"), "invalid_token")
        }));
      }
    }
  }
}

/**
 * For routes a sibling service calls with no end-user token to forward
 * (e.g. venue-service's scheduled expiring-hold sweep reading
 * venue-booking-info). Tries the internal `X-Internal-Auth` header first —
 * a valid one is a trusted system call, so it skips `req.user` entirely and
 * the route must treat its absence as "caller is trusted, not scoped to a
 * role". Falls back to normal `requireAuth` so existing user-initiated
 * callers are unaffected.
 */
export function requireAuthOrInternal(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (stryMutAct_9fa48("1320")) {
    {}
  } else {
    stryCov_9fa48("1320");
    const internalToken = req.headers[stryMutAct_9fa48("1321") ? "" : (stryCov_9fa48("1321"), "x-internal-auth")];
    if (stryMutAct_9fa48("1324") ? typeof internalToken === "string" || internalToken : stryMutAct_9fa48("1323") ? false : stryMutAct_9fa48("1322") ? true : (stryCov_9fa48("1322", "1323", "1324"), (stryMutAct_9fa48("1326") ? typeof internalToken !== "string" : stryMutAct_9fa48("1325") ? true : (stryCov_9fa48("1325", "1326"), typeof internalToken === (stryMutAct_9fa48("1327") ? "" : (stryCov_9fa48("1327"), "string")))) && internalToken)) {
      if (stryMutAct_9fa48("1328")) {
        {}
      } else {
        stryCov_9fa48("1328");
        try {
          if (stryMutAct_9fa48("1329")) {
            {}
          } else {
            stryCov_9fa48("1329");
            if (stryMutAct_9fa48("1330")) {
              ;
            } else {
              stryCov_9fa48("1330");
              verifyInternalToken(internalToken);
            }
            req.supabase = supabaseAdmin;
            if (stryMutAct_9fa48("1331")) {
              ;
            } else {
              stryCov_9fa48("1331");
              next();
            }
            return;
          }
        } catch {
          if (stryMutAct_9fa48("1332")) {
            {}
          } else {
            stryCov_9fa48("1332");
            res.status(401).json(stryMutAct_9fa48("1334") ? {} : (stryCov_9fa48("1334"), {
              error: stryMutAct_9fa48("1335") ? "" : (stryCov_9fa48("1335"), "Invalid internal token"),
              code: stryMutAct_9fa48("1336") ? "" : (stryCov_9fa48("1336"), "invalid_internal_token")
            }));
            return;
          }
        }
      }
    }
    if (stryMutAct_9fa48("1337")) {
      ;
    } else {
      stryCov_9fa48("1337");
      requireAuth(req, res, next);
    }
  }
}