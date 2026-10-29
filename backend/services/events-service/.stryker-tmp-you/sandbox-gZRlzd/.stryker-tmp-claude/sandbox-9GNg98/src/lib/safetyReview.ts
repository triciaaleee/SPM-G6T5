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
import type { ArrangementBooking, ArrangementEquipmentRequest } from "./arrangementsClient.js";

/**
 * E3-4: the rules for submitting an event for safety review — what must be
 * settled first (AC1–AC4) and the safety notes the coordinator must give
 * (AC5). Pure, so the route only fetches and writes.
 */

/** Booking statuses still awaiting an outcome (AC2) — any one blocks submission. */
export const UNSETTLED_BOOKING_STATUSES: ReadonlySet<string> = new Set(stryMutAct_9fa48("938") ? [] : (stryCov_9fa48("938"), [stryMutAct_9fa48("939") ? "" : (stryCov_9fa48("939"), "Requested"), stryMutAct_9fa48("940") ? "" : (stryCov_9fa48("940"), "On Hold"), stryMutAct_9fa48("941") ? "" : (stryCov_9fa48("941"), "Replacement Required")]));
const APPROVED_BOOKING_STATUS = stryMutAct_9fa48("942") ? "" : (stryCov_9fa48("942"), "Approved");
export interface OutstandingBooking {
  bookingId: number;
  venueName: string | null;
  status: string;
}
export interface OutstandingEquipmentItem {
  requestId: number;
  equipmentType: string;
  quantity: number;
  quantityReserved: number;
}
export interface OutstandingArrangements {
  /** AC2: no booking at all has been approved. */
  noApprovedVenue: boolean;
  /** AC2: bookings still Requested, On Hold or Replacement Required. */
  bookings: OutstandingBooking[];
  /** AC3: requested equipment not yet fully reserved. */
  equipment: OutstandingEquipmentItem[];
  /** The organiser asked for equipment (their text, trimmed) but none has been recorded for the event yet. */
  equipmentNotArranged: string | null;
}

/**
 * What an organiser writes when they need no equipment: "NA", "N/A", "None", "Nil", "No", "Nothing", "Not
 * applicable", optionally followed by filler such as "required", "needed" or "equipment" ("None required",
 * "No equipment needed"). Matched on the whole answer after lower-casing and dropping punctuation, so "None of the
 * usual, but 2 mics" still counts as a request for equipment.
 */
const NO_EQUIPMENT_ANSWER = stryMutAct_9fa48("947") ? /^(?:|na|n a|none|nil|nothing|no|not applicable|not required)(?: (?:required|needed|equipment|requirements?|needs))*$/ : stryMutAct_9fa48("946") ? /^(?:|na|n a|none|nil|nothing|no|not applicable|not required)(?: (?:required|needed|equipment|requirements|needs?))*$/ : stryMutAct_9fa48("945") ? /^(?:|na|n a|none|nil|nothing|no|not applicable|not required)(?: (?:required|needed|equipment|requirements?|needs?))$/ : stryMutAct_9fa48("944") ? /^(?:|na|n a|none|nil|nothing|no|not applicable|not required)(?: (?:required|needed|equipment|requirements?|needs?))*/ : stryMutAct_9fa48("943") ? /(?:|na|n a|none|nil|nothing|no|not applicable|not required)(?: (?:required|needed|equipment|requirements?|needs?))*$/ : (stryCov_9fa48("943", "944", "945", "946", "947"), /^(?:|na|n a|none|nil|nothing|no|not applicable|not required)(?: (?:required|needed|equipment|requirements?|needs?))*$/);

/** Whether the organiser's Equipment Requirements text asks for any equipment. */
export function equipmentIsRequired(requirements: string | null | undefined): boolean {
  if (stryMutAct_9fa48("948")) {
    {}
  } else {
    stryCov_9fa48("948");
    const answer = stryMutAct_9fa48("950") ? (requirements ?? "").toUpperCase().replace(/[^a-z0-9]+/g, " ").trim() : stryMutAct_9fa48("949") ? (requirements ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ") : (stryCov_9fa48("949", "950"), (stryMutAct_9fa48("951") ? requirements && "" : (stryCov_9fa48("951"), requirements ?? (stryMutAct_9fa48("952") ? "Stryker was here!" : (stryCov_9fa48("952"), "")))).toLowerCase().replace(stryMutAct_9fa48("954") ? /[a-z0-9]+/g : stryMutAct_9fa48("953") ? /[^a-z0-9]/g : (stryCov_9fa48("953", "954"), /[^a-z0-9]+/g), stryMutAct_9fa48("955") ? "" : (stryCov_9fa48("955"), " ")).trim());
    return stryMutAct_9fa48("956") ? NO_EQUIPMENT_ANSWER.test(answer) : (stryCov_9fa48("956"), !NO_EQUIPMENT_ANSWER.test(answer));
  }
}

/**
 * What stops the event entering Safety Review. Rejected, Withdrawn and
 * Expired bookings stay on record but don't block (AC2). An equipment item
 * counts as reserved once Technical Support have fulfilled its full
 * quantity. An event whose organiser asked for no equipment (NA / None) has
 * nothing outstanding there (AC4); one that asked for some is outstanding
 * until a request has been recorded, so "no request yet" is never read as
 * "nothing requested".
 */
export function findOutstandingArrangements(bookings: ArrangementBooking[], equipmentRequests: ArrangementEquipmentRequest[], equipmentRequirements?: string | null): OutstandingArrangements {
  if (stryMutAct_9fa48("957")) {
    {}
  } else {
    stryCov_9fa48("957");
    const hasRecordedItem = stryMutAct_9fa48("958") ? equipmentRequests.every(request => request.status !== "Cancelled" && request.items.length > 0) : (stryCov_9fa48("958"), equipmentRequests.some(stryMutAct_9fa48("959") ? () => undefined : (stryCov_9fa48("959"), request => stryMutAct_9fa48("962") ? request.status !== "Cancelled" || request.items.length > 0 : stryMutAct_9fa48("961") ? false : stryMutAct_9fa48("960") ? true : (stryCov_9fa48("960", "961", "962"), (stryMutAct_9fa48("964") ? request.status === "Cancelled" : stryMutAct_9fa48("963") ? true : (stryCov_9fa48("963", "964"), request.status !== (stryMutAct_9fa48("965") ? "" : (stryCov_9fa48("965"), "Cancelled")))) && (stryMutAct_9fa48("968") ? request.items.length <= 0 : stryMutAct_9fa48("967") ? request.items.length >= 0 : stryMutAct_9fa48("966") ? true : (stryCov_9fa48("966", "967", "968"), request.items.length > 0))))));
    return stryMutAct_9fa48("969") ? {} : (stryCov_9fa48("969"), {
      noApprovedVenue: stryMutAct_9fa48("970") ? bookings.some(booking => booking.status === APPROVED_BOOKING_STATUS) : (stryCov_9fa48("970"), !(stryMutAct_9fa48("971") ? bookings.every(booking => booking.status === APPROVED_BOOKING_STATUS) : (stryCov_9fa48("971"), bookings.some(stryMutAct_9fa48("972") ? () => undefined : (stryCov_9fa48("972"), booking => stryMutAct_9fa48("975") ? booking.status !== APPROVED_BOOKING_STATUS : stryMutAct_9fa48("974") ? false : stryMutAct_9fa48("973") ? true : (stryCov_9fa48("973", "974", "975"), booking.status === APPROVED_BOOKING_STATUS)))))),
      bookings: stryMutAct_9fa48("976") ? bookings.map(booking => ({
        bookingId: booking.id,
        venueName: booking.venue?.name ?? null,
        status: booking.status
      })) : (stryCov_9fa48("976"), bookings.filter(stryMutAct_9fa48("977") ? () => undefined : (stryCov_9fa48("977"), booking => UNSETTLED_BOOKING_STATUSES.has(booking.status))).map(stryMutAct_9fa48("978") ? () => undefined : (stryCov_9fa48("978"), booking => stryMutAct_9fa48("979") ? {} : (stryCov_9fa48("979"), {
        bookingId: booking.id,
        venueName: stryMutAct_9fa48("980") ? booking.venue?.name && null : (stryCov_9fa48("980"), (stryMutAct_9fa48("981") ? booking.venue.name : (stryCov_9fa48("981"), booking.venue?.name)) ?? null),
        status: booking.status
      })))),
      equipment: equipmentRequests.flatMap(stryMutAct_9fa48("982") ? () => undefined : (stryCov_9fa48("982"), request => stryMutAct_9fa48("983") ? request.items.map(item => ({
        requestId: request.id,
        equipmentType: item.equipmentType,
        quantity: item.quantity,
        quantityReserved: item.quantityFulfilled
      })) : (stryCov_9fa48("983"), request.items.filter(stryMutAct_9fa48("984") ? () => undefined : (stryCov_9fa48("984"), item => stryMutAct_9fa48("988") ? item.quantityFulfilled >= item.quantity : stryMutAct_9fa48("987") ? item.quantityFulfilled <= item.quantity : stryMutAct_9fa48("986") ? false : stryMutAct_9fa48("985") ? true : (stryCov_9fa48("985", "986", "987", "988"), item.quantityFulfilled < item.quantity))).map(stryMutAct_9fa48("989") ? () => undefined : (stryCov_9fa48("989"), item => stryMutAct_9fa48("990") ? {} : (stryCov_9fa48("990"), {
        requestId: request.id,
        equipmentType: item.equipmentType,
        quantity: item.quantity,
        quantityReserved: item.quantityFulfilled
      })))))),
      equipmentNotArranged: (stryMutAct_9fa48("993") ? equipmentIsRequired(equipmentRequirements) || !hasRecordedItem : stryMutAct_9fa48("992") ? false : stryMutAct_9fa48("991") ? true : (stryCov_9fa48("991", "992", "993"), equipmentIsRequired(equipmentRequirements) && (stryMutAct_9fa48("994") ? hasRecordedItem : (stryCov_9fa48("994"), !hasRecordedItem)))) ? stryMutAct_9fa48("995") ? equipmentRequirements as string : (stryCov_9fa48("995"), (equipmentRequirements as string).trim()) : null
    });
  }
}
export function hasOutstanding(outstanding: OutstandingArrangements): boolean {
  if (stryMutAct_9fa48("996")) {
    {}
  } else {
    stryCov_9fa48("996");
    return stryMutAct_9fa48("999") ? (outstanding.noApprovedVenue || outstanding.bookings.length > 0 || outstanding.equipment.length > 0) && outstanding.equipmentNotArranged !== null : stryMutAct_9fa48("998") ? false : stryMutAct_9fa48("997") ? true : (stryCov_9fa48("997", "998", "999"), (stryMutAct_9fa48("1001") ? (outstanding.noApprovedVenue || outstanding.bookings.length > 0) && outstanding.equipment.length > 0 : stryMutAct_9fa48("1000") ? false : (stryCov_9fa48("1000", "1001"), (stryMutAct_9fa48("1003") ? outstanding.noApprovedVenue && outstanding.bookings.length > 0 : stryMutAct_9fa48("1002") ? false : (stryCov_9fa48("1002", "1003"), outstanding.noApprovedVenue || (stryMutAct_9fa48("1006") ? outstanding.bookings.length <= 0 : stryMutAct_9fa48("1005") ? outstanding.bookings.length >= 0 : stryMutAct_9fa48("1004") ? false : (stryCov_9fa48("1004", "1005", "1006"), outstanding.bookings.length > 0)))) || (stryMutAct_9fa48("1009") ? outstanding.equipment.length <= 0 : stryMutAct_9fa48("1008") ? outstanding.equipment.length >= 0 : stryMutAct_9fa48("1007") ? false : (stryCov_9fa48("1007", "1008", "1009"), outstanding.equipment.length > 0)))) || (stryMutAct_9fa48("1011") ? outstanding.equipmentNotArranged === null : stryMutAct_9fa48("1010") ? false : (stryCov_9fa48("1010", "1011"), outstanding.equipmentNotArranged !== null)));
  }
}

/**
 * One readable sentence naming every outstanding arrangement, e.g. "Settle
 * these first: Grand Ballroom is still On Hold; Projector: 1 of 2 reserved."
 */
export function describeOutstanding(outstanding: OutstandingArrangements): string {
  if (stryMutAct_9fa48("1012")) {
    {}
  } else {
    stryCov_9fa48("1012");
    const parts: string[] = stryMutAct_9fa48("1013") ? ["Stryker was here"] : (stryCov_9fa48("1013"), []);
    if (stryMutAct_9fa48("1015") ? false : stryMutAct_9fa48("1014") ? true : (stryCov_9fa48("1014", "1015"), outstanding.noApprovedVenue)) parts.push(stryMutAct_9fa48("1017") ? "" : (stryCov_9fa48("1017"), "the event has no approved venue booking"));
    for (const booking of outstanding.bookings) {
      if (stryMutAct_9fa48("1018")) {
        {}
      } else {
        stryCov_9fa48("1018");
        parts.push(stryMutAct_9fa48("1020") ? `` : (stryCov_9fa48("1020"), `${stryMutAct_9fa48("1021") ? booking.venueName && `Venue booking #${booking.bookingId}` : (stryCov_9fa48("1021"), booking.venueName ?? (stryMutAct_9fa48("1022") ? `` : (stryCov_9fa48("1022"), `Venue booking #${booking.bookingId}`)))} is still ${booking.status}`));
      }
    }
    for (const item of outstanding.equipment) {
      if (stryMutAct_9fa48("1023")) {
        {}
      } else {
        stryCov_9fa48("1023");
        parts.push(stryMutAct_9fa48("1025") ? `` : (stryCov_9fa48("1025"), `${item.equipmentType}: ${item.quantityReserved} of ${item.quantity} reserved`));
      }
    }
    if (stryMutAct_9fa48("1028") ? outstanding.equipmentNotArranged === null : stryMutAct_9fa48("1027") ? false : stryMutAct_9fa48("1026") ? true : (stryCov_9fa48("1026", "1027", "1028"), outstanding.equipmentNotArranged !== null)) {
      if (stryMutAct_9fa48("1029")) {
        {}
      } else {
        stryCov_9fa48("1029");
        parts.push(stryMutAct_9fa48("1031") ? `` : (stryCov_9fa48("1031"), `the requested equipment (${outstanding.equipmentNotArranged}) hasn't been arranged yet`));
      }
    }
    return stryMutAct_9fa48("1032") ? `` : (stryCov_9fa48("1032"), `This event can't be submitted for safety review yet. Settle these first: ${parts.join(stryMutAct_9fa48("1033") ? "" : (stryCov_9fa48("1033"), "; "))}.`);
  }
}

/** AC5: the safety notes, one per topic the Safety Officer checks. */
export interface SafetyNotes {
  equipmentPlacement: string;
  crowdMovement: string;
  emergencyAccess: string;
  venueRestrictions: string;
}
export const SAFETY_NOTE_FIELDS: Record<keyof SafetyNotes, string> = stryMutAct_9fa48("1034") ? {} : (stryCov_9fa48("1034"), {
  equipmentPlacement: stryMutAct_9fa48("1035") ? "" : (stryCov_9fa48("1035"), "equipment placement"),
  crowdMovement: stryMutAct_9fa48("1036") ? "" : (stryCov_9fa48("1036"), "crowd movement"),
  emergencyAccess: stryMutAct_9fa48("1037") ? "" : (stryCov_9fa48("1037"), "emergency access"),
  venueRestrictions: stryMutAct_9fa48("1038") ? "" : (stryCov_9fa48("1038"), "known venue restrictions")
});
export const MAX_SAFETY_NOTE_LENGTH = 2000;

/** E3-13: the Safety Officer's reason for rejecting, same cap as a safety note. */
export const MAX_SAFETY_DECISION_REASON_LENGTH = 2000;
export type SafetyNotesResult = {
  valid: true;
  notes: SafetyNotes;
} | {
  valid: false;
  fields: Record<string, string>;
};

/**
 * Reads `{ safetyNotes: { equipmentPlacement, crowdMovement,
 * emergencyAccess, venueRestrictions } }`. Every note is required; every
 * problem is reported at once, keyed by field.
 */
export function parseSafetyNotes(body: unknown): SafetyNotesResult {
  if (stryMutAct_9fa48("1039")) {
    {}
  } else {
    stryCov_9fa48("1039");
    // Optional chaining covers null/undefined; a primitive has no safetyNotes, so every note reads as missing.
    const raw = stryMutAct_9fa48("1040") ? (body as {
      safetyNotes?: unknown;
    } | null | undefined).safetyNotes : (stryCov_9fa48("1040"), (body as {
      safetyNotes?: unknown;
    } | null | undefined)?.safetyNotes);
    const source = (raw ?? {}) as Record<string, unknown>;
    const notes = {} as SafetyNotes;
    const fields: Record<string, string> = {};
    for (const [key, label] of Object.entries(SAFETY_NOTE_FIELDS) as [keyof SafetyNotes, string][]) {
      if (stryMutAct_9fa48("1041")) {
        {}
      } else {
        stryCov_9fa48("1041");
        const value = (stryMutAct_9fa48("1044") ? typeof source[key] !== "string" : stryMutAct_9fa48("1043") ? false : stryMutAct_9fa48("1042") ? true : (stryCov_9fa48("1042", "1043", "1044"), typeof source[key] === (stryMutAct_9fa48("1045") ? "" : (stryCov_9fa48("1045"), "string")))) ? stryMutAct_9fa48("1046") ? source[key] as string : (stryCov_9fa48("1046"), (source[key] as string).trim()) : stryMutAct_9fa48("1047") ? "Stryker was here!" : (stryCov_9fa48("1047"), "");
        if (stryMutAct_9fa48("1050") ? false : stryMutAct_9fa48("1049") ? true : stryMutAct_9fa48("1048") ? value : (stryCov_9fa48("1048", "1049", "1050"), !value)) {
          if (stryMutAct_9fa48("1051")) {
            {}
          } else {
            stryCov_9fa48("1051");
            fields[key] = (stryMutAct_9fa48("1054") ? key !== "venueRestrictions" : stryMutAct_9fa48("1053") ? false : stryMutAct_9fa48("1052") ? true : (stryCov_9fa48("1052", "1053", "1054"), key === (stryMutAct_9fa48("1055") ? "" : (stryCov_9fa48("1055"), "venueRestrictions")))) ? stryMutAct_9fa48("1056") ? `` : (stryCov_9fa48("1056"), `Describe any ${label}, or write "None known".`) : stryMutAct_9fa48("1057") ? `` : (stryCov_9fa48("1057"), `Describe the ${label}.`);
          }
        } else if (stryMutAct_9fa48("1061") ? value.length <= MAX_SAFETY_NOTE_LENGTH : stryMutAct_9fa48("1060") ? value.length >= MAX_SAFETY_NOTE_LENGTH : stryMutAct_9fa48("1059") ? false : stryMutAct_9fa48("1058") ? true : (stryCov_9fa48("1058", "1059", "1060", "1061"), value.length > MAX_SAFETY_NOTE_LENGTH)) {
          if (stryMutAct_9fa48("1062")) {
            {}
          } else {
            stryCov_9fa48("1062");
            fields[key] = stryMutAct_9fa48("1063") ? `` : (stryCov_9fa48("1063"), `Keep this under ${MAX_SAFETY_NOTE_LENGTH} characters.`);
          }
        }
        notes[key] = value;
      }
    }
    return (stryMutAct_9fa48("1067") ? Object.keys(fields).length <= 0 : stryMutAct_9fa48("1066") ? Object.keys(fields).length >= 0 : stryMutAct_9fa48("1065") ? false : stryMutAct_9fa48("1064") ? true : (stryCov_9fa48("1064", "1065", "1066", "1067"), Object.keys(fields).length > 0)) ? stryMutAct_9fa48("1068") ? {} : (stryCov_9fa48("1068"), {
      valid: stryMutAct_9fa48("1069") ? true : (stryCov_9fa48("1069"), false),
      fields
    }) : stryMutAct_9fa48("1070") ? {} : (stryCov_9fa48("1070"), {
      valid: stryMutAct_9fa48("1071") ? false : (stryCov_9fa48("1071"), true),
      notes
    });
  }
}