/**
 * Reads the coordinator list from user-service, which owns the users
 * table (AGENTS.md §1). The caller's own bearer token is forwarded, so
 * user-service applies its own role check: only the Event Coordinator Lead
 * may list coordinators.
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
export interface Coordinator {
  id: string;
  name: string;
}
export type FetchCoordinatorsResult = {
  status: "ok";
  coordinators: Coordinator[];
} | {
  status: "error";
};
function userServiceUrl(): string {
  if (stryMutAct_9fa48("1080")) {
    {}
  } else {
    stryCov_9fa48("1080");
    return stryMutAct_9fa48("1081") ? process.env.USER_SERVICE_URL && `http://localhost:${process.env.USER_SERVICE_PORT ?? 4002}` : (stryCov_9fa48("1081"), process.env.USER_SERVICE_URL ?? (stryMutAct_9fa48("1082") ? `` : (stryCov_9fa48("1082"), `http://localhost:${stryMutAct_9fa48("1083") ? process.env.USER_SERVICE_PORT && 4002 : (stryCov_9fa48("1083"), process.env.USER_SERVICE_PORT ?? 4002)}`)));
  }
}

/**
 * Every active Event Coordinator. There is no active/inactive flag on
 * users, so every account with the coordinator role counts as active
 * (the same assumption E2-6 made).
 */
export async function fetchCoordinators(authorization: string): Promise<FetchCoordinatorsResult> {
  if (stryMutAct_9fa48("1084")) {
    {}
  } else {
    stryCov_9fa48("1084");
    try {
      if (stryMutAct_9fa48("1085")) {
        {}
      } else {
        stryCov_9fa48("1085");
        const res = await fetch(stryMutAct_9fa48("1086") ? `` : (stryCov_9fa48("1086"), `${userServiceUrl()}/api/users?role=coordinator`), stryMutAct_9fa48("1087") ? {} : (stryCov_9fa48("1087"), {
          headers: stryMutAct_9fa48("1088") ? {} : (stryCov_9fa48("1088"), {
            Authorization: authorization
          })
        }));
        if (stryMutAct_9fa48("1091") ? false : stryMutAct_9fa48("1090") ? true : stryMutAct_9fa48("1089") ? res.ok : (stryCov_9fa48("1089", "1090", "1091"), !res.ok)) return stryMutAct_9fa48("1092") ? {} : (stryCov_9fa48("1092"), {
          status: stryMutAct_9fa48("1093") ? "" : (stryCov_9fa48("1093"), "error")
        });
        const body = (await res.json()) as {
          users?: Coordinator[];
        };
        return stryMutAct_9fa48("1094") ? {} : (stryCov_9fa48("1094"), {
          status: stryMutAct_9fa48("1095") ? "" : (stryCov_9fa48("1095"), "ok"),
          coordinators: stryMutAct_9fa48("1096") ? body.users && [] : (stryCov_9fa48("1096"), body.users ?? (stryMutAct_9fa48("1097") ? ["Stryker was here"] : (stryCov_9fa48("1097"), [])))
        });
      }
    } catch {
      if (stryMutAct_9fa48("1098")) {
        {}
      } else {
        stryCov_9fa48("1098");
        return stryMutAct_9fa48("1099") ? {} : (stryCov_9fa48("1099"), {
          status: stryMutAct_9fa48("1100") ? "" : (stryCov_9fa48("1100"), "error")
        });
      }
    }
  }
}

/**
 * Every Event Coordinator Lead, so a freshly submitted request (E2-14) can
 * notify whoever triages the unassigned queue. Forwards the submitting
 * user's own bearer token, same as fetchCoordinators above.
 */
export async function fetchCoordinatorLeads(authorization: string): Promise<FetchCoordinatorsResult> {
  if (stryMutAct_9fa48("1101")) {
    {}
  } else {
    stryCov_9fa48("1101");
    try {
      if (stryMutAct_9fa48("1102")) {
        {}
      } else {
        stryCov_9fa48("1102");
        const res = await fetch(stryMutAct_9fa48("1103") ? `` : (stryCov_9fa48("1103"), `${userServiceUrl()}/api/users?role=coordinator_lead`), stryMutAct_9fa48("1104") ? {} : (stryCov_9fa48("1104"), {
          headers: stryMutAct_9fa48("1105") ? {} : (stryCov_9fa48("1105"), {
            Authorization: authorization
          })
        }));
        if (stryMutAct_9fa48("1108") ? false : stryMutAct_9fa48("1107") ? true : stryMutAct_9fa48("1106") ? res.ok : (stryCov_9fa48("1106", "1107", "1108"), !res.ok)) return stryMutAct_9fa48("1109") ? {} : (stryCov_9fa48("1109"), {
          status: stryMutAct_9fa48("1110") ? "" : (stryCov_9fa48("1110"), "error")
        });
        const body = (await res.json()) as {
          users?: Coordinator[];
        };
        return stryMutAct_9fa48("1111") ? {} : (stryCov_9fa48("1111"), {
          status: stryMutAct_9fa48("1112") ? "" : (stryCov_9fa48("1112"), "ok"),
          coordinators: stryMutAct_9fa48("1113") ? body.users && [] : (stryCov_9fa48("1113"), body.users ?? (stryMutAct_9fa48("1114") ? ["Stryker was here"] : (stryCov_9fa48("1114"), [])))
        });
      }
    } catch {
      if (stryMutAct_9fa48("1115")) {
        {}
      } else {
        stryCov_9fa48("1115");
        return stryMutAct_9fa48("1116") ? {} : (stryCov_9fa48("1116"), {
          status: stryMutAct_9fa48("1117") ? "" : (stryCov_9fa48("1117"), "error")
        });
      }
    }
  }
}