// @ts-nocheck
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
import jwt from "jsonwebtoken";
import { clock } from "./clock.js";

/** The injected clock as the seconds-since-epoch jsonwebtoken expects, so token issue and expiry follow it. */
const nowSeconds = stryMutAct_9fa48("474") ? () => undefined : (stryCov_9fa48("474"), (() => {
  const nowSeconds = (): number => Math.floor(stryMutAct_9fa48("475") ? clock.now().getTime() * 1000 : (stryCov_9fa48("475"), clock.now().getTime() / 1000));
  return nowSeconds;
})());
const JWT_EXPIRES_IN = stryMutAct_9fa48("476") ? "" : (stryCov_9fa48("476"), "1d");
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
  if (stryMutAct_9fa48("477")) {
    {}
  } else {
    stryCov_9fa48("477");
    const secret = stryMutAct_9fa48("478") ? process.env.JWT_SECRET && "" : (stryCov_9fa48("478"), process.env.JWT_SECRET ?? (stryMutAct_9fa48("479") ? "Stryker was here!" : (stryCov_9fa48("479"), "")));
    if (stryMutAct_9fa48("482") ? false : stryMutAct_9fa48("481") ? true : stryMutAct_9fa48("480") ? secret : (stryCov_9fa48("480", "481", "482"), !secret)) {
      if (stryMutAct_9fa48("483")) {
        {}
      } else {
        stryCov_9fa48("483");
        throw new Error(stryMutAct_9fa48("485") ? "" : (stryCov_9fa48("485"), "JWT_SECRET is not set — add it to backend/services/events-service/.env"));
      }
    }
    return secret;
  }
}
export function signToken(payload: {
  sub: string;
  role: string;
}): string {
  if (stryMutAct_9fa48("486")) {
    {}
  } else {
    stryCov_9fa48("486");
    return jwt.sign(stryMutAct_9fa48("487") ? {} : (stryCov_9fa48("487"), {
      ...payload,
      iat: nowSeconds()
    }), getSecret(), stryMutAct_9fa48("488") ? {} : (stryCov_9fa48("488"), {
      expiresIn: JWT_EXPIRES_IN
    }));
  }
}

/**
 * Throws TokenExpiredError when the token was valid but has aged out, so
 * callers can tell "log in again" apart from "this token is a forgery".
 */
export function verifyToken(token: string): AppTokenPayload {
  if (stryMutAct_9fa48("489")) {
    {}
  } else {
    stryCov_9fa48("489");
    try {
      if (stryMutAct_9fa48("490")) {
        {}
      } else {
        stryCov_9fa48("490");
        return jwt.verify(token, getSecret(), {
          clockTimestamp: nowSeconds()
        }) as AppTokenPayload;
      }
    } catch (err) {
      if (stryMutAct_9fa48("491")) {
        {}
      } else {
        stryCov_9fa48("491");
        if (stryMutAct_9fa48("493") ? false : stryMutAct_9fa48("492") ? true : (stryCov_9fa48("492", "493"), err instanceof jwt.TokenExpiredError)) {
          if (stryMutAct_9fa48("494")) {
            {}
          } else {
            stryCov_9fa48("494");
            throw new TokenExpiredError(stryMutAct_9fa48("496") ? "" : (stryCov_9fa48("496"), "Token expired"));
          }
        }
        throw err;
      }
    }
  }
}