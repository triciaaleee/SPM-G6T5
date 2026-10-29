/**
 * change_requests.status values, spelled exactly as the
 * change_request_status Postgres enum (migrations 0036, 0038) spells
 * them. `Auto-Withdrawn` is its own status, not a flavour of `Approved` —
 * when every held field gets reverted before anyone decides on it,
 * nothing was actually approved, so calling it `Approved` would be a
 * lie. Named "Auto-" rather than plain "Withdrawn" because there is no
 * manual withdraw-this-request action anywhere in the system yet; one
 * gets its own plain `Withdrawn` value if that's ever built, with no
 * collision.
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
export const CHANGE_REQUEST_STATUS = {
  Pending: "Pending",
  Approved: "Approved",
  Rejected: "Rejected",
  AutoWithdrawn: "Auto-Withdrawn"
} as const;
export type ChangeRequestStatus = typeof CHANGE_REQUEST_STATUS[keyof typeof CHANGE_REQUEST_STATUS];

/**
 * E3-9 AC3: a purely non-critical submission is `Approved` immediately —
 * truthfully, since it really was applied, no coordinator decision
 * pending or skipped. But `decided_by` stays null just like a future
 * coordinator's own approval (E3-11) would look different only once that
 * exists, so this reason prefix is what tells the two apart on both
 * sides in the meantime; `Approved` itself needs no separate status for
 * this, unlike the withdrawn case above.
 */
export const AUTO_APPLIED_REASON_PREFIX = stryMutAct_9fa48("301") ? "" : (stryCov_9fa48("301"), "Applied automatically — ");