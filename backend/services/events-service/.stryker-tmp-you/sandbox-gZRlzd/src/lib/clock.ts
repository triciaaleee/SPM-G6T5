/**
 * The service's source of "now". Everything that needs the current time reads it from here instead of
 * calling `new Date()` / `Date.now()` directly, so a test can pin it (setClockForTest) without patching
 * the global Date and without depending on when or in which time zone the suite happens to run.
 */
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
export interface Clock {
  now(): Date;
}
const systemClock: Clock = stryMutAct_9fa48("302") ? {} : (stryCov_9fa48("302"), {
  now: stryMutAct_9fa48("303") ? () => undefined : (stryCov_9fa48("303"), () => new Date())
});
let current: Clock = systemClock;
export const clock: Clock = stryMutAct_9fa48("304") ? {} : (stryCov_9fa48("304"), {
  now: stryMutAct_9fa48("305") ? () => undefined : (stryCov_9fa48("305"), () => current.now())
});

/** Pin the clock to a fixed instant (or a custom clock); call with no argument to go back to the system clock. */
export function setClockForTest(next?: Clock | Date | string): void {
  if (stryMutAct_9fa48("306")) {
    {}
  } else {
    stryCov_9fa48("306");
    if (stryMutAct_9fa48("309") ? next !== undefined : stryMutAct_9fa48("308") ? false : stryMutAct_9fa48("307") ? true : (stryCov_9fa48("307", "308", "309"), next === undefined)) current = systemClock;else if (stryMutAct_9fa48("312") ? typeof next === "string" && next instanceof Date : stryMutAct_9fa48("311") ? false : stryMutAct_9fa48("310") ? true : (stryCov_9fa48("310", "311", "312"), (stryMutAct_9fa48("314") ? typeof next !== "string" : stryMutAct_9fa48("313") ? false : (stryCov_9fa48("313", "314"), typeof next === (stryMutAct_9fa48("315") ? "" : (stryCov_9fa48("315"), "string")))) || next instanceof Date)) {
      if (stryMutAct_9fa48("316")) {
        {}
      } else {
        stryCov_9fa48("316");
        const fixed = new Date(next);
        current = stryMutAct_9fa48("317") ? {} : (stryCov_9fa48("317"), {
          now: stryMutAct_9fa48("318") ? () => undefined : (stryCov_9fa48("318"), () => new Date(fixed.getTime()))
        });
      }
    } else current = next;
  }
}