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

/**
 * Verifies the short-lived token a sibling service signs when it calls us
 * with no end-user bearer token to forward (e.g. venue-service's scheduled
 * expiring-hold sweep resolving a booking's coordinator). Separate secret
 * from JWT_SECRET so a leaked value can't forge a user session or vice versa.
 */
function getSecret(): string {
  if (stryMutAct_9fa48("464")) {
    {}
  } else {
    stryCov_9fa48("464");
    const secret = stryMutAct_9fa48("465") ? process.env.INTERNAL_SERVICE_SECRET && "" : (stryCov_9fa48("465"), process.env.INTERNAL_SERVICE_SECRET ?? (stryMutAct_9fa48("466") ? "Stryker was here!" : (stryCov_9fa48("466"), "")));
    if (stryMutAct_9fa48("469") ? false : stryMutAct_9fa48("468") ? true : stryMutAct_9fa48("467") ? secret : (stryCov_9fa48("467", "468", "469"), !secret)) {
      if (stryMutAct_9fa48("470")) {
        {}
      } else {
        stryCov_9fa48("470");
        throw new Error(stryMutAct_9fa48("472") ? "" : (stryCov_9fa48("472"), "INTERNAL_SERVICE_SECRET is not set — add it to backend/.env"));
      }
    }
    return secret;
  }
}
export interface InternalTokenPayload {
  svc: string;
}
export function verifyInternalToken(token: string): InternalTokenPayload {
  if (stryMutAct_9fa48("473")) {
    {}
  } else {
    stryCov_9fa48("473");
    return jwt.verify(token, getSecret(), {
      clockTimestamp: Math.floor(clock.now().getTime() / 1000)
    }) as InternalTokenPayload;
  }
}