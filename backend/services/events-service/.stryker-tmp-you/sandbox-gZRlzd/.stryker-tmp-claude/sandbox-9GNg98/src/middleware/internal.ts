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
import type { NextFunction, Response } from "express";
import { verifyInternalToken } from "../lib/internalAuth.js";
import type { AuthedRequest } from "./auth.js";

/**
 * For routes only a sibling service may call (venue-service and
 * equipment-service telling us an arrangement was lost). No end-user
 * token is accepted, so no `req.user` is set and the handler brings its own
 * database client.
 */
export function requireInternal(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (stryMutAct_9fa48("1338")) {
    {}
  } else {
    stryCov_9fa48("1338");
    const internalToken = req.headers[stryMutAct_9fa48("1339") ? "" : (stryCov_9fa48("1339"), "x-internal-auth")];
    if (stryMutAct_9fa48("1342") ? typeof internalToken !== "string" && !internalToken : stryMutAct_9fa48("1341") ? false : stryMutAct_9fa48("1340") ? true : (stryCov_9fa48("1340", "1341", "1342"), (stryMutAct_9fa48("1344") ? typeof internalToken === "string" : stryMutAct_9fa48("1343") ? false : (stryCov_9fa48("1343", "1344"), typeof internalToken !== (stryMutAct_9fa48("1345") ? "" : (stryCov_9fa48("1345"), "string")))) || (stryMutAct_9fa48("1346") ? internalToken : (stryCov_9fa48("1346"), !internalToken)))) {
      if (stryMutAct_9fa48("1347")) {
        {}
      } else {
        stryCov_9fa48("1347");
        res.status(401).json(stryMutAct_9fa48("1349") ? {} : (stryCov_9fa48("1349"), {
          error: stryMutAct_9fa48("1350") ? "" : (stryCov_9fa48("1350"), "Missing internal token"),
          code: stryMutAct_9fa48("1351") ? "" : (stryCov_9fa48("1351"), "no_internal_token")
        }));
        return;
      }
    }
    try {
      if (stryMutAct_9fa48("1352")) {
        {}
      } else {
        stryCov_9fa48("1352");
        if (stryMutAct_9fa48("1353")) {
          ;
        } else {
          stryCov_9fa48("1353");
          verifyInternalToken(internalToken);
        }
        if (stryMutAct_9fa48("1354")) {
          ;
        } else {
          stryCov_9fa48("1354");
          next();
        }
      }
    } catch {
      if (stryMutAct_9fa48("1355")) {
        {}
      } else {
        stryCov_9fa48("1355");
        res.status(401).json(stryMutAct_9fa48("1357") ? {} : (stryCov_9fa48("1357"), {
          error: stryMutAct_9fa48("1358") ? "" : (stryCov_9fa48("1358"), "Invalid internal token"),
          code: stryMutAct_9fa48("1359") ? "" : (stryCov_9fa48("1359"), "invalid_internal_token")
        }));
      }
    }
  }
}