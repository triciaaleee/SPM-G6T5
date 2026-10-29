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
import { createClient } from "@supabase/supabase-js";
const supabaseUrl = stryMutAct_9fa48("1072") ? process.env.SUPABASE_URL && "" : (stryCov_9fa48("1072"), process.env.SUPABASE_URL ?? (stryMutAct_9fa48("1073") ? "Stryker was here!" : (stryCov_9fa48("1073"), "")));
const supabaseServiceRoleKey = stryMutAct_9fa48("1074") ? process.env.SUPABASE_SERVICE_ROLE_KEY && "" : (stryCov_9fa48("1074"), process.env.SUPABASE_SERVICE_ROLE_KEY ?? (stryMutAct_9fa48("1075") ? "Stryker was here!" : (stryCov_9fa48("1075"), "")));

/**
 * Service-role client: bypasses RLS entirely. Now that auth is custom
 * (JWT issued by this backend, not Supabase Auth), there is no
 * per-request user JWT for Supabase to scope RLS against — the backend
 * is the sole gatekeeper and must enforce ownership/role checks in
 * application code for every query made with this client.
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, stryMutAct_9fa48("1076") ? {} : (stryCov_9fa48("1076"), {
  auth: stryMutAct_9fa48("1077") ? {} : (stryCov_9fa48("1077"), {
    persistSession: stryMutAct_9fa48("1078") ? true : (stryCov_9fa48("1078"), false),
    autoRefreshToken: stryMutAct_9fa48("1079") ? true : (stryCov_9fa48("1079"), false)
  })
}));