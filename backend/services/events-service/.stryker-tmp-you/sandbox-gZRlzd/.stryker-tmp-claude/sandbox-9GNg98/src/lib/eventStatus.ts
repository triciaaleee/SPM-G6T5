/**
 * The event lifecycle's status values (AGENTS.md §3), spelled exactly as
 * the `event_status` Postgres enum (migration 0014) spells them. New code
 * reads them from here rather than repeating string literals.
 */
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
export const EVENT_STATUS = {
  Draft: "Draft",
  Unassigned: "Unassigned",
  Requested: "Requested",
  ClarificationRequested: "Clarification Requested",
  Planning: "Planning",
  SafetyReview: "Safety Review",
  Confirmed: "Confirmed",
  NeedsReview: "Needs Review",
  Completed: "Completed",
  Rejected: "Rejected",
  Cancelled: "Cancelled"
} as const;
export type EventStatus = typeof EVENT_STATUS[keyof typeof EVENT_STATUS];

/**
 * End states: no transitions out (§3). E2-12 AC3: an event in one of these
 * can no longer be reassigned.
 */
export const CLOSED_EVENT_STATUSES: ReadonlySet<string> = new Set(stryMutAct_9fa48("372") ? [] : (stryCov_9fa48("372"), [EVENT_STATUS.Rejected, EVENT_STATUS.Cancelled, EVENT_STATUS.Completed]));