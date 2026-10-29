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
import type { ValidatedEventRequest } from "./validateEventRequest.js";
import { clock } from "./clock.js";

/**
 * E3-8: fields held for the assigned coordinator's review rather than
 * applied immediately, once an event is Confirmed (E3-9). Same base set as
 * COORDINATOR_LOCKED_FIELDS (E3-7, events.ts) plus equipment and
 * accessibility — one list, reused from both call sites' intent ("changes
 * to arrangements already made need reassessment").
 */
export const CRITICAL_CHANGE_FIELDS = ["proposedDate", "startTime", "endTime", "expectedAttendance", "venue", "equipment", "accessibility"] as const;
export type CriticalChangeField = typeof CRITICAL_CHANGE_FIELDS[number];
const CRITICAL_FIELD_SET: ReadonlySet<string> = new Set(CRITICAL_CHANGE_FIELDS);
export function isCriticalField(field: string): boolean {
  if (stryMutAct_9fa48("99")) {
    {}
  } else {
    stryCov_9fa48("99");
    return CRITICAL_FIELD_SET.has(field);
  }
}

/** Only the fields a change request is allowed to carry — the full set validateEventRequest knows about. */
const EDITABLE_FIELDS = ["name", "purpose", "description", "proposedDate", "startTime", "endTime", "expectedAttendance", "venue", "accessibility", "equipment", "technicalSupport", "registrationNeeded"] as const;
const TIME_PATTERN = stryMutAct_9fa48("106") ? /^([01]\d|2[0-3]):([0-5]\D)$/ : stryMutAct_9fa48("105") ? /^([01]\d|2[0-3]):([^0-5]\d)$/ : stryMutAct_9fa48("104") ? /^([01]\d|2[^0-3]):([0-5]\d)$/ : stryMutAct_9fa48("103") ? /^([01]\D|2[0-3]):([0-5]\d)$/ : stryMutAct_9fa48("102") ? /^([^01]\d|2[0-3]):([0-5]\d)$/ : stryMutAct_9fa48("101") ? /^([01]\d|2[0-3]):([0-5]\d)/ : stryMutAct_9fa48("100") ? /([01]\d|2[0-3]):([0-5]\d)$/ : (stryCov_9fa48("100", "101", "102", "103", "104", "105", "106"), /^([01]\d|2[0-3]):([0-5]\d)$/);
function todayIsoDate(): string {
  if (stryMutAct_9fa48("107")) {
    {}
  } else {
    stryCov_9fa48("107");
    return stryMutAct_9fa48("108") ? clock.now().toISOString() : (stryCov_9fa48("108"), clock.now().toISOString().slice(0, 10));
  }
}
function isBlank(value: unknown): boolean {
  if (stryMutAct_9fa48("109")) {
    {}
  } else {
    stryCov_9fa48("109");
    return stryMutAct_9fa48("112") ? (value === undefined || value === null) && typeof value === "string" && value.trim() === "" : stryMutAct_9fa48("111") ? false : stryMutAct_9fa48("110") ? true : (stryCov_9fa48("110", "111", "112"), (stryMutAct_9fa48("114") ? value === undefined && value === null : stryMutAct_9fa48("113") ? false : (stryCov_9fa48("113", "114"), (stryMutAct_9fa48("116") ? value !== undefined : stryMutAct_9fa48("115") ? false : (stryCov_9fa48("115", "116"), value === undefined)) || (stryMutAct_9fa48("118") ? value !== null : stryMutAct_9fa48("117") ? false : (stryCov_9fa48("117", "118"), value === null)))) || (stryMutAct_9fa48("120") ? typeof value === "string" || value.trim() === "" : stryMutAct_9fa48("119") ? false : (stryCov_9fa48("119", "120"), (stryMutAct_9fa48("122") ? typeof value !== "string" : stryMutAct_9fa48("121") ? true : (stryCov_9fa48("121", "122"), typeof value === (stryMutAct_9fa48("123") ? "" : (stryCov_9fa48("123"), "string")))) && (stryMutAct_9fa48("125") ? value.trim() !== "" : stryMutAct_9fa48("124") ? true : (stryCov_9fa48("124", "125"), (stryMutAct_9fa48("126") ? value : (stryCov_9fa48("126"), value.trim())) === (stryMutAct_9fa48("127") ? "Stryker was here!" : (stryCov_9fa48("127"), "")))))));
  }
}
function formatValue(value: unknown): string {
  if (stryMutAct_9fa48("128")) {
    {}
  } else {
    stryCov_9fa48("128");
    if (stryMutAct_9fa48("131") ? typeof value !== "boolean" : stryMutAct_9fa48("130") ? false : stryMutAct_9fa48("129") ? true : (stryCov_9fa48("129", "130", "131"), typeof value === (stryMutAct_9fa48("132") ? "" : (stryCov_9fa48("132"), "boolean")))) return value ? stryMutAct_9fa48("133") ? "" : (stryCov_9fa48("133"), "Yes") : stryMutAct_9fa48("134") ? "" : (stryCov_9fa48("134"), "No");
    return String(value);
  }
}

/**
 * E3-9: the true committed baseline for a field — what's actually live in
 * submitted_details, ignoring any held/pending value. Used to tell a
 * genuine overwrite of a held field from a revert back to what's already
 * there (events.ts's merge logic), and to label a held field's `oldValue`
 * so it always reads against reality, not against an earlier pending
 * value that was itself never applied.
 */
export function committedFieldValue(current: Partial<ValidatedEventRequest>, field: string): string | null {
  if (stryMutAct_9fa48("135")) {
    {}
  } else {
    stryCov_9fa48("135");
    const value = (current as Record<string, unknown>)[field];
    return (stryMutAct_9fa48("138") ? value === undefined && value === null : stryMutAct_9fa48("137") ? false : stryMutAct_9fa48("136") ? true : (stryCov_9fa48("136", "137", "138"), (stryMutAct_9fa48("140") ? value !== undefined : stryMutAct_9fa48("139") ? false : (stryCov_9fa48("139", "140"), value === undefined)) || (stryMutAct_9fa48("142") ? value !== null : stryMutAct_9fa48("141") ? false : (stryCov_9fa48("141", "142"), value === null)))) ? null : formatValue(value);
  }
}

/**
 * E3-9: overlays a still-open request's held critical values onto the
 * committed baseline, so re-validating a later submission diffs against
 * "what the organiser would see if they reopened the form" rather than
 * the committed value — resubmitting an already-held value is then a
 * true no-op (the field stays held, untouched) instead of looking like a
 * fresh change every time.
 */
export function withHeldValues(current: Partial<ValidatedEventRequest>, held: {
  field: string;
  newValue: string;
}[]): Partial<ValidatedEventRequest> {
  if (stryMutAct_9fa48("143")) {
    {}
  } else {
    stryCov_9fa48("143");
    const overlaid: Record<string, unknown> = stryMutAct_9fa48("144") ? {} : (stryCov_9fa48("144"), {
      ...current
    });
    for (const {
      field,
      newValue
    } of held) {
      if (stryMutAct_9fa48("145")) {
        {}
      } else {
        stryCov_9fa48("145");
        overlaid[field] = (stryMutAct_9fa48("148") ? field !== "expectedAttendance" : stryMutAct_9fa48("147") ? false : stryMutAct_9fa48("146") ? true : (stryCov_9fa48("146", "147", "148"), field === (stryMutAct_9fa48("149") ? "" : (stryCov_9fa48("149"), "expectedAttendance")))) ? Number(newValue) : newValue;
      }
    }
    return overlaid as Partial<ValidatedEventRequest>;
  }
}
export interface ChangeRequestFieldResult {
  field: string;
  oldValue: string | null;
  newValue: string;
  isCritical: boolean;
}
export interface ChangeRequestValidation {
  valid: boolean;
  fields: Record<string, string>;
  /** One entry per changed field in the request body, split critical/non-critical. */
  changes: ChangeRequestFieldResult[];
}

/**
 * E3-9: validates a partial change-request submission against the event's
 * current submitted_details. Only fields present in the body are checked —
 * unlike validateEventRequest (which validates a full new/draft request),
 * a change request may touch just one field. Reuses the same per-field
 * rules (no past date, valid time, end after start, positive attendance)
 * so a held or applied value can never violate E2-1's own constraints.
 */
export function validateChangeRequestFields(body: Record<string, unknown>, current: Partial<ValidatedEventRequest>): ChangeRequestValidation {
  if (stryMutAct_9fa48("150")) {
    {}
  } else {
    stryCov_9fa48("150");
    const fields: Record<string, string> = {};
    const changes: ChangeRequestFieldResult[] = stryMutAct_9fa48("151") ? ["Stryker was here"] : (stryCov_9fa48("151"), []);
    const submitted = stryMutAct_9fa48("152") ? EDITABLE_FIELDS : (stryCov_9fa48("152"), EDITABLE_FIELDS.filter(stryMutAct_9fa48("153") ? () => undefined : (stryCov_9fa48("153"), field => Object.prototype.hasOwnProperty.call(body, field))));
    if (stryMutAct_9fa48("155") ? false : stryMutAct_9fa48("154") ? true : (stryCov_9fa48("154", "155"), submitted.includes(stryMutAct_9fa48("156") ? "" : (stryCov_9fa48("156"), "proposedDate")))) {
      if (stryMutAct_9fa48("157")) {
        {}
      } else {
        stryCov_9fa48("157");
        const raw = body.proposedDate;
        if (stryMutAct_9fa48("159") ? false : stryMutAct_9fa48("158") ? true : (stryCov_9fa48("158", "159"), isBlank(raw))) {
          if (stryMutAct_9fa48("160")) {
            {}
          } else {
            stryCov_9fa48("160");
            fields.proposedDate = stryMutAct_9fa48("161") ? "" : (stryCov_9fa48("161"), "This field is required.");
          }
        } else {
          if (stryMutAct_9fa48("162")) {
            {}
          } else {
            stryCov_9fa48("162");
            const parsed = new Date(String(raw));
            if (stryMutAct_9fa48("164") ? false : stryMutAct_9fa48("163") ? true : (stryCov_9fa48("163", "164"), Number.isNaN(parsed.getTime()))) {
              if (stryMutAct_9fa48("165")) {
                {}
              } else {
                stryCov_9fa48("165");
                fields.proposedDate = stryMutAct_9fa48("166") ? "" : (stryCov_9fa48("166"), "Enter a valid date.");
              }
            } else if (stryMutAct_9fa48("170") ? String(raw) >= todayIsoDate() : stryMutAct_9fa48("169") ? String(raw) <= todayIsoDate() : stryMutAct_9fa48("168") ? false : stryMutAct_9fa48("167") ? true : (stryCov_9fa48("167", "168", "169", "170"), String(raw) < todayIsoDate())) {
              if (stryMutAct_9fa48("171")) {
                {}
              } else {
                stryCov_9fa48("171");
                fields.proposedDate = stryMutAct_9fa48("172") ? "" : (stryCov_9fa48("172"), "The proposed date cannot be in the past.");
              }
            }
          }
        }
      }
    }
    const effectiveStartTime = submitted.includes(stryMutAct_9fa48("173") ? "" : (stryCov_9fa48("173"), "startTime")) ? body.startTime : current.startTime;
    const effectiveEndTime = submitted.includes(stryMutAct_9fa48("174") ? "" : (stryCov_9fa48("174"), "endTime")) ? body.endTime : current.endTime;
    if (stryMutAct_9fa48("176") ? false : stryMutAct_9fa48("175") ? true : (stryCov_9fa48("175", "176"), submitted.includes(stryMutAct_9fa48("177") ? "" : (stryCov_9fa48("177"), "startTime")))) {
      if (stryMutAct_9fa48("178")) {
        {}
      } else {
        stryCov_9fa48("178");
        if (stryMutAct_9fa48("180") ? false : stryMutAct_9fa48("179") ? true : (stryCov_9fa48("179", "180"), isBlank(body.startTime))) fields.startTime = stryMutAct_9fa48("181") ? "" : (stryCov_9fa48("181"), "This field is required.");else if (stryMutAct_9fa48("184") ? false : stryMutAct_9fa48("183") ? true : stryMutAct_9fa48("182") ? TIME_PATTERN.test(String(body.startTime)) : (stryCov_9fa48("182", "183", "184"), !TIME_PATTERN.test(String(body.startTime)))) fields.startTime = stryMutAct_9fa48("185") ? "" : (stryCov_9fa48("185"), "Enter a valid time.");
      }
    }
    if (stryMutAct_9fa48("187") ? false : stryMutAct_9fa48("186") ? true : (stryCov_9fa48("186", "187"), submitted.includes(stryMutAct_9fa48("188") ? "" : (stryCov_9fa48("188"), "endTime")))) {
      if (stryMutAct_9fa48("189")) {
        {}
      } else {
        stryCov_9fa48("189");
        if (stryMutAct_9fa48("191") ? false : stryMutAct_9fa48("190") ? true : (stryCov_9fa48("190", "191"), isBlank(body.endTime))) fields.endTime = stryMutAct_9fa48("192") ? "" : (stryCov_9fa48("192"), "This field is required.");else if (stryMutAct_9fa48("195") ? false : stryMutAct_9fa48("194") ? true : stryMutAct_9fa48("193") ? TIME_PATTERN.test(String(body.endTime)) : (stryCov_9fa48("193", "194", "195"), !TIME_PATTERN.test(String(body.endTime)))) fields.endTime = stryMutAct_9fa48("196") ? "" : (stryCov_9fa48("196"), "Enter a valid time.");
      }
    }
    if (stryMutAct_9fa48("199") ? !fields.startTime && !fields.endTime && (submitted.includes("startTime") || submitted.includes("endTime")) && effectiveStartTime || effectiveEndTime : stryMutAct_9fa48("198") ? false : stryMutAct_9fa48("197") ? true : (stryCov_9fa48("197", "198", "199"), (stryMutAct_9fa48("201") ? !fields.startTime && !fields.endTime && (submitted.includes("startTime") || submitted.includes("endTime")) || effectiveStartTime : stryMutAct_9fa48("200") ? true : (stryCov_9fa48("200", "201"), (stryMutAct_9fa48("203") ? !fields.startTime && !fields.endTime || submitted.includes("startTime") || submitted.includes("endTime") : stryMutAct_9fa48("202") ? true : (stryCov_9fa48("202", "203"), (stryMutAct_9fa48("205") ? !fields.startTime || !fields.endTime : stryMutAct_9fa48("204") ? true : (stryCov_9fa48("204", "205"), (stryMutAct_9fa48("206") ? fields.startTime : (stryCov_9fa48("206"), !fields.startTime)) && (stryMutAct_9fa48("207") ? fields.endTime : (stryCov_9fa48("207"), !fields.endTime)))) && (stryMutAct_9fa48("209") ? submitted.includes("startTime") && submitted.includes("endTime") : stryMutAct_9fa48("208") ? true : (stryCov_9fa48("208", "209"), submitted.includes(stryMutAct_9fa48("210") ? "" : (stryCov_9fa48("210"), "startTime")) || submitted.includes(stryMutAct_9fa48("211") ? "" : (stryCov_9fa48("211"), "endTime")))))) && effectiveStartTime)) && effectiveEndTime)) {
      if (stryMutAct_9fa48("212")) {
        {}
      } else {
        stryCov_9fa48("212");
        const toMinutes = (time: string) => {
          if (stryMutAct_9fa48("213")) {
            {}
          } else {
            stryCov_9fa48("213");
            const [h, m] = time.split(stryMutAct_9fa48("214") ? "" : (stryCov_9fa48("214"), ":")).map(Number);
            return stryMutAct_9fa48("215") ? h * 60 - m : (stryCov_9fa48("215"), (stryMutAct_9fa48("216") ? h / 60 : (stryCov_9fa48("216"), h * 60)) + m);
          }
        };
        if (stryMutAct_9fa48("220") ? toMinutes(String(effectiveEndTime)) > toMinutes(String(effectiveStartTime)) : stryMutAct_9fa48("219") ? toMinutes(String(effectiveEndTime)) < toMinutes(String(effectiveStartTime)) : stryMutAct_9fa48("218") ? false : stryMutAct_9fa48("217") ? true : (stryCov_9fa48("217", "218", "219", "220"), toMinutes(String(effectiveEndTime)) <= toMinutes(String(effectiveStartTime)))) {
          if (stryMutAct_9fa48("221")) {
            {}
          } else {
            stryCov_9fa48("221");
            fields.endTime = stryMutAct_9fa48("222") ? "" : (stryCov_9fa48("222"), "End time must be after the start time.");
          }
        }
      }
    }
    if (stryMutAct_9fa48("224") ? false : stryMutAct_9fa48("223") ? true : (stryCov_9fa48("223", "224"), submitted.includes(stryMutAct_9fa48("225") ? "" : (stryCov_9fa48("225"), "expectedAttendance")))) {
      if (stryMutAct_9fa48("226")) {
        {}
      } else {
        stryCov_9fa48("226");
        if (stryMutAct_9fa48("228") ? false : stryMutAct_9fa48("227") ? true : (stryCov_9fa48("227", "228"), isBlank(body.expectedAttendance))) {
          if (stryMutAct_9fa48("229")) {
            {}
          } else {
            stryCov_9fa48("229");
            fields.expectedAttendance = stryMutAct_9fa48("230") ? "" : (stryCov_9fa48("230"), "This field is required.");
          }
        } else {
          if (stryMutAct_9fa48("231")) {
            {}
          } else {
            stryCov_9fa48("231");
            const numericValue = Number(body.expectedAttendance);
            if (stryMutAct_9fa48("234") ? false : stryMutAct_9fa48("233") ? true : stryMutAct_9fa48("232") ? Number.isFinite(numericValue) : (stryCov_9fa48("232", "233", "234"), !Number.isFinite(numericValue))) fields.expectedAttendance = stryMutAct_9fa48("235") ? "" : (stryCov_9fa48("235"), "Enter a valid number.");else if (stryMutAct_9fa48("239") ? numericValue > 0 : stryMutAct_9fa48("238") ? numericValue < 0 : stryMutAct_9fa48("237") ? false : stryMutAct_9fa48("236") ? true : (stryCov_9fa48("236", "237", "238", "239"), numericValue <= 0)) fields.expectedAttendance = stryMutAct_9fa48("240") ? "" : (stryCov_9fa48("240"), "Expected attendance must be greater than zero.");
          }
        }
      }
    }
    for (const field of ["name", "purpose", "description", "venue", "accessibility", "equipment", "technicalSupport"] as const) {
      if (stryMutAct_9fa48("241")) {
        {}
      } else {
        stryCov_9fa48("241");
        if (stryMutAct_9fa48("244") ? submitted.includes(field) || isBlank(body[field]) : stryMutAct_9fa48("243") ? false : stryMutAct_9fa48("242") ? true : (stryCov_9fa48("242", "243", "244"), submitted.includes(field) && isBlank(body[field]))) {
          if (stryMutAct_9fa48("245")) {
            {}
          } else {
            stryCov_9fa48("245");
            fields[field] = stryMutAct_9fa48("246") ? "" : (stryCov_9fa48("246"), "This field is required.");
          }
        }
      }
    }
    if (stryMutAct_9fa48("250") ? Object.keys(fields).length <= 0 : stryMutAct_9fa48("249") ? Object.keys(fields).length >= 0 : stryMutAct_9fa48("248") ? false : stryMutAct_9fa48("247") ? true : (stryCov_9fa48("247", "248", "249", "250"), Object.keys(fields).length > 0)) {
      if (stryMutAct_9fa48("251")) {
        {}
      } else {
        stryCov_9fa48("251");
        return stryMutAct_9fa48("252") ? {} : (stryCov_9fa48("252"), {
          valid: stryMutAct_9fa48("253") ? true : (stryCov_9fa48("253"), false),
          fields,
          changes: stryMutAct_9fa48("254") ? ["Stryker was here"] : (stryCov_9fa48("254"), [])
        });
      }
    }
    for (const field of submitted) {
      if (stryMutAct_9fa48("255")) {
        {}
      } else {
        stryCov_9fa48("255");
        const oldValue = (current as Record<string, unknown>)[field];
        const rawNew = body[field];
        const newValue = (stryMutAct_9fa48("258") ? field !== "registrationNeeded" : stryMutAct_9fa48("257") ? false : stryMutAct_9fa48("256") ? true : (stryCov_9fa48("256", "257", "258"), field === (stryMutAct_9fa48("259") ? "" : (stryCov_9fa48("259"), "registrationNeeded")))) ? stryMutAct_9fa48("262") ? rawNew === true && rawNew === "true" : stryMutAct_9fa48("261") ? false : stryMutAct_9fa48("260") ? true : (stryCov_9fa48("260", "261", "262"), (stryMutAct_9fa48("264") ? rawNew !== true : stryMutAct_9fa48("263") ? false : (stryCov_9fa48("263", "264"), rawNew === (stryMutAct_9fa48("265") ? false : (stryCov_9fa48("265"), true)))) || (stryMutAct_9fa48("267") ? rawNew !== "true" : stryMutAct_9fa48("266") ? false : (stryCov_9fa48("266", "267"), rawNew === (stryMutAct_9fa48("268") ? "" : (stryCov_9fa48("268"), "true"))))) : stryMutAct_9fa48("269") ? String(rawNew) : (stryCov_9fa48("269"), String(rawNew).trim());

        // registrationNeeded's newValue is a boolean, comparable to oldValue
        // directly; every other field's newValue is a string, but oldValue
        // comes straight off `current` typed (expectedAttendance is a number)
        // — compare by string so resubmitting the same number isn't
        // mistaken for a change.
        const noChange = (stryMutAct_9fa48("272") ? field !== "registrationNeeded" : stryMutAct_9fa48("271") ? false : stryMutAct_9fa48("270") ? true : (stryCov_9fa48("270", "271", "272"), field === (stryMutAct_9fa48("273") ? "" : (stryCov_9fa48("273"), "registrationNeeded")))) ? stryMutAct_9fa48("276") ? oldValue !== newValue : stryMutAct_9fa48("275") ? false : stryMutAct_9fa48("274") ? true : (stryCov_9fa48("274", "275", "276"), oldValue === newValue) : stryMutAct_9fa48("279") ? oldValue !== undefined && oldValue !== null || String(oldValue) === newValue : stryMutAct_9fa48("278") ? false : stryMutAct_9fa48("277") ? true : (stryCov_9fa48("277", "278", "279"), (stryMutAct_9fa48("281") ? oldValue !== undefined || oldValue !== null : stryMutAct_9fa48("280") ? true : (stryCov_9fa48("280", "281"), (stryMutAct_9fa48("283") ? oldValue === undefined : stryMutAct_9fa48("282") ? true : (stryCov_9fa48("282", "283"), oldValue !== undefined)) && (stryMutAct_9fa48("285") ? oldValue === null : stryMutAct_9fa48("284") ? true : (stryCov_9fa48("284", "285"), oldValue !== null)))) && (stryMutAct_9fa48("287") ? String(oldValue) !== newValue : stryMutAct_9fa48("286") ? true : (stryCov_9fa48("286", "287"), String(oldValue) === newValue)));
        if (stryMutAct_9fa48("289") ? false : stryMutAct_9fa48("288") ? true : (stryCov_9fa48("288", "289"), noChange)) continue;
        changes.push(stryMutAct_9fa48("291") ? {} : (stryCov_9fa48("291"), {
          field,
          oldValue: (stryMutAct_9fa48("294") ? oldValue === undefined && oldValue === null : stryMutAct_9fa48("293") ? false : stryMutAct_9fa48("292") ? true : (stryCov_9fa48("292", "293", "294"), (stryMutAct_9fa48("296") ? oldValue !== undefined : stryMutAct_9fa48("295") ? false : (stryCov_9fa48("295", "296"), oldValue === undefined)) || (stryMutAct_9fa48("298") ? oldValue !== null : stryMutAct_9fa48("297") ? false : (stryCov_9fa48("297", "298"), oldValue === null)))) ? null : formatValue(oldValue),
          newValue: formatValue(newValue),
          isCritical: isCriticalField(field)
        }));
      }
    }
    return stryMutAct_9fa48("299") ? {} : (stryCov_9fa48("299"), {
      valid: stryMutAct_9fa48("300") ? false : (stryCov_9fa48("300"), true),
      fields: {},
      changes
    });
  }
}