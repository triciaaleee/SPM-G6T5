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
const UUID_PATTERN = stryMutAct_9fa48("1277") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[^0-9a-f]{12}$/i : stryMutAct_9fa48("1276") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]$/i : stryMutAct_9fa48("1275") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[^0-9a-f]{4}-[0-9a-f]{12}$/i : stryMutAct_9fa48("1274") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]-[0-9a-f]{12}$/i : stryMutAct_9fa48("1273") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[^0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i : stryMutAct_9fa48("1272") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]-[0-9a-f]{4}-[0-9a-f]{12}$/i : stryMutAct_9fa48("1271") ? /^[0-9a-f]{8}-[^0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i : stryMutAct_9fa48("1270") ? /^[0-9a-f]{8}-[0-9a-f]-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i : stryMutAct_9fa48("1269") ? /^[^0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i : stryMutAct_9fa48("1268") ? /^[0-9a-f]-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i : stryMutAct_9fa48("1267") ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i : stryMutAct_9fa48("1266") ? /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i : (stryCov_9fa48("1266", "1267", "1268", "1269", "1270", "1271", "1272", "1273", "1274", "1275", "1276", "1277"), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const POSITIVE_INTEGER_PATTERN = stryMutAct_9fa48("1282") ? /^[1-9]\D*$/ : stryMutAct_9fa48("1281") ? /^[1-9]\d$/ : stryMutAct_9fa48("1280") ? /^[^1-9]\d*$/ : stryMutAct_9fa48("1279") ? /^[1-9]\d*/ : stryMutAct_9fa48("1278") ? /[1-9]\d*$/ : (stryCov_9fa48("1278", "1279", "1280", "1281", "1282"), /^[1-9]\d*$/);
/** Postgres `integer` tops out here; anything larger would make the query itself fail with a 500. */
const MAX_INTEGER_ID = 2_147_483_647;
export function isUuid(value: string): boolean {
  if (stryMutAct_9fa48("1283")) {
    {}
  } else {
    stryCov_9fa48("1283");
    return UUID_PATTERN.test(value);
  }
}

/**
 * events.id is now an auto-incrementing integer (migration 0005), not a
 * uuid. Used to validate route params before querying, so malformed/
 * garbage IDs (e.g. "abc", or one too large for the column) are rejected
 * without ever reaching the DB.
 */
export function isPositiveInteger(value: string): boolean {
  if (stryMutAct_9fa48("1284")) {
    {}
  } else {
    stryCov_9fa48("1284");
    return stryMutAct_9fa48("1287") ? POSITIVE_INTEGER_PATTERN.test(value) || Number(value) <= MAX_INTEGER_ID : stryMutAct_9fa48("1286") ? false : stryMutAct_9fa48("1285") ? true : (stryCov_9fa48("1285", "1286", "1287"), POSITIVE_INTEGER_PATTERN.test(value) && (stryMutAct_9fa48("1290") ? Number(value) > MAX_INTEGER_ID : stryMutAct_9fa48("1289") ? Number(value) < MAX_INTEGER_ID : stryMutAct_9fa48("1288") ? true : (stryCov_9fa48("1288", "1289", "1290"), Number(value) <= MAX_INTEGER_ID)));
  }
}