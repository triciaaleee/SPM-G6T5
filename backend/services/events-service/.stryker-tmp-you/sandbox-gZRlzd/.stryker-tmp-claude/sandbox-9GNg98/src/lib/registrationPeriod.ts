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
import { EVENT_STATUS } from "./eventStatus.js";
import { eventEndsAt, eventStartsAt, localDateStart } from "./eventTiming.js";
import { clock } from "./clock.js";

/**
 * Registration period. The coordinator stores an open date and an optional
 * manual override (events.registration_override); the state is derived from
 * them on every read, so there is no stored status and no scheduler. Opening,
 * closing and reopening after a withdrawal all follow from the inputs.
 *
 * This service doesn't own the registered count (registration-service does),
 * so it decides everything except FULL: it returns OPEN, and registration-
 * service turns an OPEN event with no places left into FULL. That is the same
 * result as checking "full" in the order below.
 */

export const REGISTRATION_OVERRIDE = {
  None: "NONE",
  ForceOpen: "FORCE_OPEN",
  ForceClosed: "FORCE_CLOSED"
} as const;
export type RegistrationOverride = typeof REGISTRATION_OVERRIDE[keyof typeof REGISTRATION_OVERRIDE];
export const REGISTRATION_STATE = {
  NotOpen: "NOT_OPEN",
  Open: "OPEN",
  Full: "FULL",
  Closed: "CLOSED"
} as const;
export type RegistrationState = typeof REGISTRATION_STATE[keyof typeof REGISTRATION_STATE];

/** By default registration closes this long before the event starts (business rule). */
export const REGISTRATION_CUTOFF_DAYS = 5;
const DAY_MS = stryMutAct_9fa48("601") ? 24 * 60 * 60 / 1000 : (stryCov_9fa48("601"), (stryMutAct_9fa48("602") ? 24 * 60 / 60 : (stryCov_9fa48("602"), (stryMutAct_9fa48("603") ? 24 / 60 : (stryCov_9fa48("603"), 24 * 60)) * 60)) * 1000);

/** Statuses in which the coordinator may still set the open date. */
export const REGISTRATION_DATE_EDITABLE_STATUSES: string[] = stryMutAct_9fa48("604") ? [] : (stryCov_9fa48("604"), [EVENT_STATUS.Planning, EVENT_STATUS.SafetyReview, EVENT_STATUS.Confirmed, EVENT_STATUS.NeedsReview]);
export function parseOverride(value: unknown): RegistrationOverride {
  if (stryMutAct_9fa48("605")) {
    {}
  } else {
    stryCov_9fa48("605");
    return (stryMutAct_9fa48("608") ? value === REGISTRATION_OVERRIDE.ForceOpen && value === REGISTRATION_OVERRIDE.ForceClosed : stryMutAct_9fa48("607") ? false : stryMutAct_9fa48("606") ? true : (stryCov_9fa48("606", "607", "608"), (stryMutAct_9fa48("610") ? value !== REGISTRATION_OVERRIDE.ForceOpen : stryMutAct_9fa48("609") ? false : (stryCov_9fa48("609", "610"), value === REGISTRATION_OVERRIDE.ForceOpen)) || (stryMutAct_9fa48("612") ? value !== REGISTRATION_OVERRIDE.ForceClosed : stryMutAct_9fa48("611") ? false : (stryCov_9fa48("611", "612"), value === REGISTRATION_OVERRIDE.ForceClosed)))) ? value : REGISTRATION_OVERRIDE.None;
  }
}

/** The default cutoff: the moment 5 days before the event starts. */
export function registrationCutoff(details: Record<string, unknown>): Date | null {
  if (stryMutAct_9fa48("613")) {
    {}
  } else {
    stryCov_9fa48("613");
    const startsAt = eventStartsAt(details);
    return (stryMutAct_9fa48("616") ? startsAt !== null : stryMutAct_9fa48("615") ? false : stryMutAct_9fa48("614") ? true : (stryCov_9fa48("614", "615", "616"), startsAt === null)) ? null : new Date(stryMutAct_9fa48("617") ? startsAt.getTime() + REGISTRATION_CUTOFF_DAYS * DAY_MS : (stryCov_9fa48("617"), startsAt.getTime() - (stryMutAct_9fa48("618") ? REGISTRATION_CUTOFF_DAYS / DAY_MS : (stryCov_9fa48("618"), REGISTRATION_CUTOFF_DAYS * DAY_MS))));
  }
}
interface RegistrationInputs {
  status: string;
  details: Record<string, unknown>;
  openDate: unknown;
  override: unknown;
}

/** Only a Confirmed event that asks for registration and hasn't ended takes part. */
function takesRegistration({
  status,
  details
}: RegistrationInputs, now: Date): boolean {
  if (stryMutAct_9fa48("619")) {
    {}
  } else {
    stryCov_9fa48("619");
    if (stryMutAct_9fa48("622") ? status !== EVENT_STATUS.Confirmed && details.registrationNeeded !== true : stryMutAct_9fa48("621") ? false : stryMutAct_9fa48("620") ? true : (stryCov_9fa48("620", "621", "622"), (stryMutAct_9fa48("624") ? status === EVENT_STATUS.Confirmed : stryMutAct_9fa48("623") ? false : (stryCov_9fa48("623", "624"), status !== EVENT_STATUS.Confirmed)) || (stryMutAct_9fa48("626") ? details.registrationNeeded === true : stryMutAct_9fa48("625") ? false : (stryCov_9fa48("625", "626"), details.registrationNeeded !== (stryMutAct_9fa48("627") ? false : (stryCov_9fa48("627"), true)))))) return stryMutAct_9fa48("628") ? true : (stryCov_9fa48("628"), false);
    const endsAt = eventEndsAt(details);
    return stryMutAct_9fa48("631") ? endsAt !== null || endsAt.getTime() > now.getTime() : stryMutAct_9fa48("630") ? false : stryMutAct_9fa48("629") ? true : (stryCov_9fa48("629", "630", "631"), (stryMutAct_9fa48("633") ? endsAt === null : stryMutAct_9fa48("632") ? true : (stryCov_9fa48("632", "633"), endsAt !== null)) && (stryMutAct_9fa48("636") ? endsAt.getTime() <= now.getTime() : stryMutAct_9fa48("635") ? endsAt.getTime() >= now.getTime() : stryMutAct_9fa48("634") ? true : (stryCov_9fa48("634", "635", "636"), endsAt.getTime() > now.getTime())));
  }
}

/**
 * Check order is the rule priority; don't reorder without updating the tests:
 *  1. FORCE_CLOSED always closes;
 *  2. the stop at the event start beats everything, FORCE_OPEN included;
 *  3. FORCE_OPEN opens (even before the open date and inside the 5-day window);
 *  4. otherwise the 5-day cutoff closes, then the open date, then OPEN.
 * `registeredCount` is optional: pass it (with the capacity) to also get FULL.
 */
export function getRegistrationState(inputs: RegistrationInputs, now: Date = clock.now(), fullness?: {
  registeredCount: number;
  capacity: number | null;
}): RegistrationState {
  if (stryMutAct_9fa48("637")) {
    {}
  } else {
    stryCov_9fa48("637");
    if (stryMutAct_9fa48("640") ? false : stryMutAct_9fa48("639") ? true : stryMutAct_9fa48("638") ? takesRegistration(inputs, now) : (stryCov_9fa48("638", "639", "640"), !takesRegistration(inputs, now))) return REGISTRATION_STATE.Closed;
    const override = parseOverride(inputs.override);
    const full = stryMutAct_9fa48("643") ? fullness != null && fullness.capacity != null || fullness.registeredCount >= fullness.capacity : stryMutAct_9fa48("642") ? false : stryMutAct_9fa48("641") ? true : (stryCov_9fa48("641", "642", "643"), (stryMutAct_9fa48("645") ? fullness != null || fullness.capacity != null : stryMutAct_9fa48("644") ? true : (stryCov_9fa48("644", "645"), (stryMutAct_9fa48("647") ? fullness == null : stryMutAct_9fa48("646") ? true : (stryCov_9fa48("646", "647"), fullness != null)) && (stryMutAct_9fa48("649") ? fullness.capacity == null : stryMutAct_9fa48("648") ? true : (stryCov_9fa48("648", "649"), fullness.capacity != null)))) && (stryMutAct_9fa48("652") ? fullness.registeredCount < fullness.capacity : stryMutAct_9fa48("651") ? fullness.registeredCount > fullness.capacity : stryMutAct_9fa48("650") ? true : (stryCov_9fa48("650", "651", "652"), fullness.registeredCount >= fullness.capacity)));
    if (stryMutAct_9fa48("655") ? override !== REGISTRATION_OVERRIDE.ForceClosed : stryMutAct_9fa48("654") ? false : stryMutAct_9fa48("653") ? true : (stryCov_9fa48("653", "654", "655"), override === REGISTRATION_OVERRIDE.ForceClosed)) return REGISTRATION_STATE.Closed;
    const startsAt = eventStartsAt(inputs.details);
    if (stryMutAct_9fa48("658") ? startsAt !== null || now.getTime() >= startsAt.getTime() : stryMutAct_9fa48("657") ? false : stryMutAct_9fa48("656") ? true : (stryCov_9fa48("656", "657", "658"), (stryMutAct_9fa48("660") ? startsAt === null : stryMutAct_9fa48("659") ? true : (stryCov_9fa48("659", "660"), startsAt !== null)) && (stryMutAct_9fa48("663") ? now.getTime() < startsAt.getTime() : stryMutAct_9fa48("662") ? now.getTime() > startsAt.getTime() : stryMutAct_9fa48("661") ? true : (stryCov_9fa48("661", "662", "663"), now.getTime() >= startsAt.getTime())))) return REGISTRATION_STATE.Closed;
    if (stryMutAct_9fa48("666") ? override !== REGISTRATION_OVERRIDE.ForceOpen : stryMutAct_9fa48("665") ? false : stryMutAct_9fa48("664") ? true : (stryCov_9fa48("664", "665", "666"), override === REGISTRATION_OVERRIDE.ForceOpen)) {
      if (stryMutAct_9fa48("667")) {
        {}
      } else {
        stryCov_9fa48("667");
        return full ? REGISTRATION_STATE.Full : REGISTRATION_STATE.Open;
      }
    }
    const cutoff = registrationCutoff(inputs.details);
    if (stryMutAct_9fa48("670") ? cutoff !== null || now.getTime() >= cutoff.getTime() : stryMutAct_9fa48("669") ? false : stryMutAct_9fa48("668") ? true : (stryCov_9fa48("668", "669", "670"), (stryMutAct_9fa48("672") ? cutoff === null : stryMutAct_9fa48("671") ? true : (stryCov_9fa48("671", "672"), cutoff !== null)) && (stryMutAct_9fa48("675") ? now.getTime() < cutoff.getTime() : stryMutAct_9fa48("674") ? now.getTime() > cutoff.getTime() : stryMutAct_9fa48("673") ? true : (stryCov_9fa48("673", "674", "675"), now.getTime() >= cutoff.getTime())))) return REGISTRATION_STATE.Closed;
    const opensAt = localDateStart(inputs.openDate);
    if (stryMutAct_9fa48("678") ? opensAt === null && now.getTime() < opensAt.getTime() : stryMutAct_9fa48("677") ? false : stryMutAct_9fa48("676") ? true : (stryCov_9fa48("676", "677", "678"), (stryMutAct_9fa48("680") ? opensAt !== null : stryMutAct_9fa48("679") ? false : (stryCov_9fa48("679", "680"), opensAt === null)) || (stryMutAct_9fa48("683") ? now.getTime() >= opensAt.getTime() : stryMutAct_9fa48("682") ? now.getTime() <= opensAt.getTime() : stryMutAct_9fa48("681") ? false : (stryCov_9fa48("681", "682", "683"), now.getTime() < opensAt.getTime())))) return REGISTRATION_STATE.NotOpen;
    return full ? REGISTRATION_STATE.Full : REGISTRATION_STATE.Open;
  }
}

/**
 * Whether attendees may see the event in the listing: registration has been
 * opened (the open date has arrived, or the coordinator forced it open) and the
 * event takes registration. Closed and full events stay listed. The listing
 * route filters with this; keep them the same.
 */
export function isListed(inputs: RegistrationInputs, now: Date = clock.now()): boolean {
  if (stryMutAct_9fa48("684")) {
    {}
  } else {
    stryCov_9fa48("684");
    if (stryMutAct_9fa48("687") ? false : stryMutAct_9fa48("686") ? true : stryMutAct_9fa48("685") ? takesRegistration(inputs, now) : (stryCov_9fa48("685", "686", "687"), !takesRegistration(inputs, now))) return stryMutAct_9fa48("688") ? true : (stryCov_9fa48("688"), false);
    const override = parseOverride(inputs.override);
    if (stryMutAct_9fa48("691") ? override !== REGISTRATION_OVERRIDE.ForceOpen : stryMutAct_9fa48("690") ? false : stryMutAct_9fa48("689") ? true : (stryCov_9fa48("689", "690", "691"), override === REGISTRATION_OVERRIDE.ForceOpen)) return stryMutAct_9fa48("692") ? false : (stryCov_9fa48("692"), true);
    const opensAt = localDateStart(inputs.openDate);
    return stryMutAct_9fa48("695") ? opensAt !== null || now.getTime() >= opensAt.getTime() : stryMutAct_9fa48("694") ? false : stryMutAct_9fa48("693") ? true : (stryCov_9fa48("693", "694", "695"), (stryMutAct_9fa48("697") ? opensAt === null : stryMutAct_9fa48("696") ? true : (stryCov_9fa48("696", "697"), opensAt !== null)) && (stryMutAct_9fa48("700") ? now.getTime() < opensAt.getTime() : stryMutAct_9fa48("699") ? now.getTime() > opensAt.getTime() : stryMutAct_9fa48("698") ? true : (stryCov_9fa48("698", "699", "700"), now.getTime() >= opensAt.getTime())));
  }
}