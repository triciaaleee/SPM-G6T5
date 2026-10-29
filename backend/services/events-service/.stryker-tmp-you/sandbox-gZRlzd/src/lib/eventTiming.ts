/**
 * When an event ends. An event's date and times are stored as local
 * wall-clock strings with no time zone (submitted_details.proposedDate
 * "YYYY-MM-DD", endTime "HH:MM"), so they're read as Singapore time
 * explicitly — not the server's own time zone, which is UTC on most hosts
 * and would make an event "end" eight hours late.
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
import { clock } from "./clock.js";

/** Singapore has no daylight saving, so a fixed offset is exact. */
export const EVENT_UTC_OFFSET = stryMutAct_9fa48("373") ? "" : (stryCov_9fa48("373"), "+08:00");

// The patterns are anchored on purpose: without "^" a signed extended year such as "+092026-11-10" gets
// through and Date reads it as the year 92026 (tested in libEdges.test.ts).
//
// Mutation testing: dropping the trailing "$" (date) or either anchor (time) changes nothing observable.
// The value is spliced into `${date}T${time}:00+08:00` and handed to Date, which rejects any stray character,
// so a string those mutants would admit still comes back null. Fuzzed with 4 million prefixed/suffixed values
// without finding a difference. Stryker can only skip a mutator as a whole, hence the two disables.
// Stryker disable next-line Regex: the "^" case is covered by a dedicated test; "$" is equivalent (see above)
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Stryker disable next-line Regex: equivalent mutants only (see above)
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Used when an event has a date but no end time: it runs to the end of that day. */
const END_OF_DAY = stryMutAct_9fa48("389") ? "" : (stryCov_9fa48("389"), "23:59");

/**
 * The moment the event ends, or null when it has no valid date (or an
 * unreadable end time). Events end on the day they start — validation
 * requires endTime after startTime — so proposedDate + endTime is the end.
 */
export function eventEndsAt(details: Record<string, unknown>): Date | null {
  if (stryMutAct_9fa48("390")) {
    {}
  } else {
    stryCov_9fa48("390");
    const date = details.proposedDate;
    if (stryMutAct_9fa48("393") ? typeof date !== "string" && !DATE_PATTERN.test(date) : stryMutAct_9fa48("392") ? false : stryMutAct_9fa48("391") ? true : (stryCov_9fa48("391", "392", "393"), (stryMutAct_9fa48("395") ? typeof date === "string" : stryMutAct_9fa48("394") ? false : (stryCov_9fa48("394", "395"), typeof date !== (stryMutAct_9fa48("396") ? "" : (stryCov_9fa48("396"), "string")))) || (stryMutAct_9fa48("397") ? DATE_PATTERN.test(date) : (stryCov_9fa48("397"), !DATE_PATTERN.test(date))))) return null;
    const endTime = (stryMutAct_9fa48("400") ? details.endTime === undefined && details.endTime === null : stryMutAct_9fa48("399") ? false : stryMutAct_9fa48("398") ? true : (stryCov_9fa48("398", "399", "400"), (stryMutAct_9fa48("402") ? details.endTime !== undefined : stryMutAct_9fa48("401") ? false : (stryCov_9fa48("401", "402"), details.endTime === undefined)) || (stryMutAct_9fa48("404") ? details.endTime !== null : stryMutAct_9fa48("403") ? false : (stryCov_9fa48("403", "404"), details.endTime === null)))) ? END_OF_DAY : details.endTime;
    if (stryMutAct_9fa48("407") ? typeof endTime !== "string" && !TIME_PATTERN.test(endTime) : stryMutAct_9fa48("406") ? false : stryMutAct_9fa48("405") ? true : (stryCov_9fa48("405", "406", "407"), (stryMutAct_9fa48("409") ? typeof endTime === "string" : stryMutAct_9fa48("408") ? false : (stryCov_9fa48("408", "409"), typeof endTime !== (stryMutAct_9fa48("410") ? "" : (stryCov_9fa48("410"), "string")))) || (stryMutAct_9fa48("411") ? TIME_PATTERN.test(endTime) : (stryCov_9fa48("411"), !TIME_PATTERN.test(endTime))))) return null;
    const endsAt = new Date(stryMutAct_9fa48("412") ? `` : (stryCov_9fa48("412"), `${date}T${endTime}:00${EVENT_UTC_OFFSET}`));
    return Number.isNaN(endsAt.getTime()) ? null : endsAt;
  }
}

/** Used when an event has a date but no start time: it starts at the beginning of that day. */
const START_OF_DAY = stryMutAct_9fa48("413") ? "" : (stryCov_9fa48("413"), "00:00");

/**
 * The moment the event starts, or null when it has no valid date (or an
 * unreadable start time). Mirrors eventEndsAt.
 */
export function eventStartsAt(details: Record<string, unknown>): Date | null {
  if (stryMutAct_9fa48("414")) {
    {}
  } else {
    stryCov_9fa48("414");
    const date = details.proposedDate;
    if (stryMutAct_9fa48("417") ? typeof date !== "string" && !DATE_PATTERN.test(date) : stryMutAct_9fa48("416") ? false : stryMutAct_9fa48("415") ? true : (stryCov_9fa48("415", "416", "417"), (stryMutAct_9fa48("419") ? typeof date === "string" : stryMutAct_9fa48("418") ? false : (stryCov_9fa48("418", "419"), typeof date !== (stryMutAct_9fa48("420") ? "" : (stryCov_9fa48("420"), "string")))) || (stryMutAct_9fa48("421") ? DATE_PATTERN.test(date) : (stryCov_9fa48("421"), !DATE_PATTERN.test(date))))) return null;
    const startTime = (stryMutAct_9fa48("424") ? details.startTime === undefined && details.startTime === null : stryMutAct_9fa48("423") ? false : stryMutAct_9fa48("422") ? true : (stryCov_9fa48("422", "423", "424"), (stryMutAct_9fa48("426") ? details.startTime !== undefined : stryMutAct_9fa48("425") ? false : (stryCov_9fa48("425", "426"), details.startTime === undefined)) || (stryMutAct_9fa48("428") ? details.startTime !== null : stryMutAct_9fa48("427") ? false : (stryCov_9fa48("427", "428"), details.startTime === null)))) ? START_OF_DAY : details.startTime;
    if (stryMutAct_9fa48("431") ? typeof startTime !== "string" && !TIME_PATTERN.test(startTime) : stryMutAct_9fa48("430") ? false : stryMutAct_9fa48("429") ? true : (stryCov_9fa48("429", "430", "431"), (stryMutAct_9fa48("433") ? typeof startTime === "string" : stryMutAct_9fa48("432") ? false : (stryCov_9fa48("432", "433"), typeof startTime !== (stryMutAct_9fa48("434") ? "" : (stryCov_9fa48("434"), "string")))) || (stryMutAct_9fa48("435") ? TIME_PATTERN.test(startTime) : (stryCov_9fa48("435"), !TIME_PATTERN.test(startTime))))) return null;
    const startsAt = new Date(stryMutAct_9fa48("436") ? `` : (stryCov_9fa48("436"), `${date}T${startTime}:00${EVENT_UTC_OFFSET}`));
    return Number.isNaN(startsAt.getTime()) ? null : startsAt;
  }
}

/**
 * True once the event has started (Singapore time). An event whose start
 * can't be worked out is treated as not started. E6-4: attendees may
 * withdraw any time before this.
 */
export function hasEventStarted(details: Record<string, unknown>, now: Date = clock.now()): boolean {
  if (stryMutAct_9fa48("437")) {
    {}
  } else {
    stryCov_9fa48("437");
    const startsAt = eventStartsAt(details);
    return stryMutAct_9fa48("440") ? startsAt !== null || startsAt.getTime() <= now.getTime() : stryMutAct_9fa48("439") ? false : stryMutAct_9fa48("438") ? true : (stryCov_9fa48("438", "439", "440"), (stryMutAct_9fa48("442") ? startsAt === null : stryMutAct_9fa48("441") ? true : (stryCov_9fa48("441", "442"), startsAt !== null)) && (stryMutAct_9fa48("445") ? startsAt.getTime() > now.getTime() : stryMutAct_9fa48("444") ? startsAt.getTime() < now.getTime() : stryMutAct_9fa48("443") ? true : (stryCov_9fa48("443", "444", "445"), startsAt.getTime() <= now.getTime())));
  }
}

/** The start of a local (Singapore) calendar day, or null for a malformed date. */
export function localDateStart(date: unknown): Date | null {
  if (stryMutAct_9fa48("446")) {
    {}
  } else {
    stryCov_9fa48("446");
    if (stryMutAct_9fa48("449") ? typeof date !== "string" && !DATE_PATTERN.test(date) : stryMutAct_9fa48("448") ? false : stryMutAct_9fa48("447") ? true : (stryCov_9fa48("447", "448", "449"), (stryMutAct_9fa48("451") ? typeof date === "string" : stryMutAct_9fa48("450") ? false : (stryCov_9fa48("450", "451"), typeof date !== (stryMutAct_9fa48("452") ? "" : (stryCov_9fa48("452"), "string")))) || (stryMutAct_9fa48("453") ? DATE_PATTERN.test(date) : (stryCov_9fa48("453"), !DATE_PATTERN.test(date))))) return null;
    const start = new Date(stryMutAct_9fa48("454") ? `` : (stryCov_9fa48("454"), `${date}T00:00:00${EVENT_UTC_OFFSET}`));
    return Number.isNaN(start.getTime()) ? null : start;
  }
}

/**
 * True once the event's end time has passed. An event whose end can't be
 * worked out is treated as not ended, so nothing that depends on it having
 * run (E3-5 completion) is allowed by mistake.
 */
export function hasEventEnded(details: Record<string, unknown>, now: Date = clock.now()): boolean {
  if (stryMutAct_9fa48("455")) {
    {}
  } else {
    stryCov_9fa48("455");
    const endsAt = eventEndsAt(details);
    return stryMutAct_9fa48("458") ? endsAt !== null || endsAt.getTime() <= now.getTime() : stryMutAct_9fa48("457") ? false : stryMutAct_9fa48("456") ? true : (stryCov_9fa48("456", "457", "458"), (stryMutAct_9fa48("460") ? endsAt === null : stryMutAct_9fa48("459") ? true : (stryCov_9fa48("459", "460"), endsAt !== null)) && (stryMutAct_9fa48("463") ? endsAt.getTime() > now.getTime() : stryMutAct_9fa48("462") ? endsAt.getTime() < now.getTime() : stryMutAct_9fa48("461") ? true : (stryCov_9fa48("461", "462", "463"), endsAt.getTime() <= now.getTime())));
  }
}