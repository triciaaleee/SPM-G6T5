/**
 * E3-8 AC2: an event's registrations, read from registration-service
 * (AGENTS.md §1 — events-service never queries its table directly). The
 * caller's own bearer token is forwarded; registration-service's own
 * GET /event/:eventId already admits the owning organiser or a coordinator
 * and checks access itself (via its own call back into events-service), so
 * there's no extra auth plumbing needed here.
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
export interface EventRegistration {
  registrationId: number;
  userId: string;
  status: "Registered" | "Withdrawn";
  name: string | null;
}
export type FetchResult<T> = {
  status: "ok";
  value: T;
} | {
  status: "error";
};
function registrationServiceUrl(): string {
  if (stryMutAct_9fa48("701")) {
    {}
  } else {
    stryCov_9fa48("701");
    return stryMutAct_9fa48("702") ? process.env.REGISTRATION_SERVICE_URL && `http://localhost:${process.env.REGISTRATION_SERVICE_PORT ?? 4007}` : (stryCov_9fa48("702"), process.env.REGISTRATION_SERVICE_URL ?? (stryMutAct_9fa48("703") ? `` : (stryCov_9fa48("703"), `http://localhost:${stryMutAct_9fa48("704") ? process.env.REGISTRATION_SERVICE_PORT && 4007 : (stryCov_9fa48("704"), process.env.REGISTRATION_SERVICE_PORT ?? 4007)}`)));
  }
}

/** Every registration recorded for the event, whatever its status. */
export async function fetchEventRegistrations(eventId: number, authorization: string): Promise<FetchResult<EventRegistration[]>> {
  if (stryMutAct_9fa48("705")) {
    {}
  } else {
    stryCov_9fa48("705");
    try {
      if (stryMutAct_9fa48("706")) {
        {}
      } else {
        stryCov_9fa48("706");
        const res = await fetch(stryMutAct_9fa48("707") ? `` : (stryCov_9fa48("707"), `${registrationServiceUrl()}/api/registrations/event/${eventId}`), stryMutAct_9fa48("708") ? {} : (stryCov_9fa48("708"), {
          headers: stryMutAct_9fa48("709") ? {} : (stryCov_9fa48("709"), {
            Authorization: authorization
          })
        }));
        if (stryMutAct_9fa48("712") ? false : stryMutAct_9fa48("711") ? true : stryMutAct_9fa48("710") ? res.ok : (stryCov_9fa48("710", "711", "712"), !res.ok)) return stryMutAct_9fa48("713") ? {} : (stryCov_9fa48("713"), {
          status: stryMutAct_9fa48("714") ? "" : (stryCov_9fa48("714"), "error")
        });
        const body = (await res.json()) as {
          registrations?: {
            registrationId: number;
            userId: string;
            status: string;
            name: string | null;
          }[];
        };
        return stryMutAct_9fa48("715") ? {} : (stryCov_9fa48("715"), {
          status: stryMutAct_9fa48("716") ? "" : (stryCov_9fa48("716"), "ok"),
          value: (stryMutAct_9fa48("717") ? body.registrations && [] : (stryCov_9fa48("717"), body.registrations ?? (stryMutAct_9fa48("718") ? ["Stryker was here"] : (stryCov_9fa48("718"), [])))).map(stryMutAct_9fa48("719") ? () => undefined : (stryCov_9fa48("719"), row => stryMutAct_9fa48("720") ? {} : (stryCov_9fa48("720"), {
            registrationId: row.registrationId,
            userId: row.userId,
            status: row.status as EventRegistration["status"],
            name: row.name
          })))
        });
      }
    } catch {
      if (stryMutAct_9fa48("721")) {
        {}
      } else {
        stryCov_9fa48("721");
        return stryMutAct_9fa48("722") ? {} : (stryCov_9fa48("722"), {
          status: stryMutAct_9fa48("723") ? "" : (stryCov_9fa48("723"), "error")
        });
      }
    }
  }
}