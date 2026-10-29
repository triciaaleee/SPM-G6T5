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
import { clock } from "./clock.js";
// E2-1: validation for POST /api/events, driven by the story's acceptance
// criteria (mandatory fields, no past dates, positive attendance, end > start).
//
// E2-12: venue/accessibility/equipment/technicalSupport are mandatory
// planning-requirement fields the Organiser describes; registrationNeeded is
// a yes/no flag that's always present from the UI toggle, so it has no
// "blank" state to enforce.

export interface EventRequestInput {
  name?: unknown;
  purpose?: unknown;
  description?: unknown;
  proposedDate?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  expectedAttendance?: unknown;
  venue?: unknown;
  accessibility?: unknown;
  equipment?: unknown;
  technicalSupport?: unknown;
  registrationNeeded?: unknown;
}
export interface ValidatedEventRequest {
  name: string;
  purpose: string;
  description: string;
  proposedDate: string;
  startTime: string;
  endTime: string;
  expectedAttendance: number;
  venue: string;
  accessibility: string;
  equipment: string;
  technicalSupport: string;
  registrationNeeded: boolean;
}
export interface ValidationResult {
  valid: boolean;
  fields: Record<string, string>;
  value?: ValidatedEventRequest;
}
const REQUIRED_TEXT_FIELDS = ["name", "purpose", "description", "venue", "accessibility", "equipment", "technicalSupport"] as const;
const TIME_PATTERN = stryMutAct_9fa48("1124") ? /^([01]\d|2[0-3]):([0-5]\D)$/ : stryMutAct_9fa48("1123") ? /^([01]\d|2[0-3]):([^0-5]\d)$/ : stryMutAct_9fa48("1122") ? /^([01]\d|2[^0-3]):([0-5]\d)$/ : stryMutAct_9fa48("1121") ? /^([01]\D|2[0-3]):([0-5]\d)$/ : stryMutAct_9fa48("1120") ? /^([^01]\d|2[0-3]):([0-5]\d)$/ : stryMutAct_9fa48("1119") ? /^([01]\d|2[0-3]):([0-5]\d)/ : stryMutAct_9fa48("1118") ? /([01]\d|2[0-3]):([0-5]\d)$/ : (stryCov_9fa48("1118", "1119", "1120", "1121", "1122", "1123", "1124"), /^([01]\d|2[0-3]):([0-5]\d)$/);
function isBlank(value: unknown): boolean {
  if (stryMutAct_9fa48("1125")) {
    {}
  } else {
    stryCov_9fa48("1125");
    return stryMutAct_9fa48("1128") ? (value === undefined || value === null) && typeof value === "string" && value.trim() === "" : stryMutAct_9fa48("1127") ? false : stryMutAct_9fa48("1126") ? true : (stryCov_9fa48("1126", "1127", "1128"), (stryMutAct_9fa48("1130") ? value === undefined && value === null : stryMutAct_9fa48("1129") ? false : (stryCov_9fa48("1129", "1130"), (stryMutAct_9fa48("1132") ? value !== undefined : stryMutAct_9fa48("1131") ? false : (stryCov_9fa48("1131", "1132"), value === undefined)) || (stryMutAct_9fa48("1134") ? value !== null : stryMutAct_9fa48("1133") ? false : (stryCov_9fa48("1133", "1134"), value === null)))) || (stryMutAct_9fa48("1136") ? typeof value === "string" || value.trim() === "" : stryMutAct_9fa48("1135") ? false : (stryCov_9fa48("1135", "1136"), (stryMutAct_9fa48("1138") ? typeof value !== "string" : stryMutAct_9fa48("1137") ? true : (stryCov_9fa48("1137", "1138"), typeof value === (stryMutAct_9fa48("1139") ? "" : (stryCov_9fa48("1139"), "string")))) && (stryMutAct_9fa48("1141") ? value.trim() !== "" : stryMutAct_9fa48("1140") ? true : (stryCov_9fa48("1140", "1141"), (stryMutAct_9fa48("1142") ? value : (stryCov_9fa48("1142"), value.trim())) === (stryMutAct_9fa48("1143") ? "Stryker was here!" : (stryCov_9fa48("1143"), "")))))));
  }
}
function toMinutes(time: string): number {
  if (stryMutAct_9fa48("1144")) {
    {}
  } else {
    stryCov_9fa48("1144");
    const [hours, minutes] = time.split(stryMutAct_9fa48("1145") ? "" : (stryCov_9fa48("1145"), ":")).map(Number);
    return stryMutAct_9fa48("1146") ? hours * 60 - minutes : (stryCov_9fa48("1146"), (stryMutAct_9fa48("1147") ? hours / 60 : (stryCov_9fa48("1147"), hours * 60)) + minutes);
  }
}
function todayIsoDate(): string {
  if (stryMutAct_9fa48("1148")) {
    {}
  } else {
    stryCov_9fa48("1148");
    return stryMutAct_9fa48("1149") ? clock.now().toISOString() : (stryCov_9fa48("1149"), clock.now().toISOString().slice(0, 10));
  }
}

/**
 * Validates and normalises a raw event-request payload. Collects every
 * field error in one pass (rather than failing fast) so the caller can
 * report all of them at once, per AC "every missing field is identified".
 */
export function validateEventRequest(input: EventRequestInput): ValidationResult {
  if (stryMutAct_9fa48("1150")) {
    {}
  } else {
    stryCov_9fa48("1150");
    const fields: Record<string, string> = {};
    for (const field of REQUIRED_TEXT_FIELDS) {
      if (stryMutAct_9fa48("1151")) {
        {}
      } else {
        stryCov_9fa48("1151");
        if (stryMutAct_9fa48("1153") ? false : stryMutAct_9fa48("1152") ? true : (stryCov_9fa48("1152", "1153"), isBlank(input[field]))) fields[field] = stryMutAct_9fa48("1154") ? "" : (stryCov_9fa48("1154"), "This field is required.");
      }
    }
    let proposedDate: string | undefined;
    if (stryMutAct_9fa48("1156") ? false : stryMutAct_9fa48("1155") ? true : (stryCov_9fa48("1155", "1156"), isBlank(input.proposedDate))) {
      if (stryMutAct_9fa48("1157")) {
        {}
      } else {
        stryCov_9fa48("1157");
        fields.proposedDate = stryMutAct_9fa48("1158") ? "" : (stryCov_9fa48("1158"), "This field is required.");
      }
    } else {
      if (stryMutAct_9fa48("1159")) {
        {}
      } else {
        stryCov_9fa48("1159");
        const raw = String(input.proposedDate);
        const parsed = new Date(raw);
        if (stryMutAct_9fa48("1161") ? false : stryMutAct_9fa48("1160") ? true : (stryCov_9fa48("1160", "1161"), Number.isNaN(parsed.getTime()))) {
          if (stryMutAct_9fa48("1162")) {
            {}
          } else {
            stryCov_9fa48("1162");
            fields.proposedDate = stryMutAct_9fa48("1163") ? "" : (stryCov_9fa48("1163"), "Enter a valid date.");
          }
        } else if (stryMutAct_9fa48("1167") ? raw >= todayIsoDate() : stryMutAct_9fa48("1166") ? raw <= todayIsoDate() : stryMutAct_9fa48("1165") ? false : stryMutAct_9fa48("1164") ? true : (stryCov_9fa48("1164", "1165", "1166", "1167"), raw < todayIsoDate())) {
          if (stryMutAct_9fa48("1168")) {
            {}
          } else {
            stryCov_9fa48("1168");
            fields.proposedDate = stryMutAct_9fa48("1169") ? "" : (stryCov_9fa48("1169"), "The proposed date cannot be in the past.");
          }
        } else {
          if (stryMutAct_9fa48("1170")) {
            {}
          } else {
            stryCov_9fa48("1170");
            proposedDate = raw;
          }
        }
      }
    }
    let startTime: string | undefined;
    if (stryMutAct_9fa48("1172") ? false : stryMutAct_9fa48("1171") ? true : (stryCov_9fa48("1171", "1172"), isBlank(input.startTime))) {
      if (stryMutAct_9fa48("1173")) {
        {}
      } else {
        stryCov_9fa48("1173");
        fields.startTime = stryMutAct_9fa48("1174") ? "" : (stryCov_9fa48("1174"), "This field is required.");
      }
    } else if (stryMutAct_9fa48("1177") ? false : stryMutAct_9fa48("1176") ? true : stryMutAct_9fa48("1175") ? TIME_PATTERN.test(String(input.startTime)) : (stryCov_9fa48("1175", "1176", "1177"), !TIME_PATTERN.test(String(input.startTime)))) {
      if (stryMutAct_9fa48("1178")) {
        {}
      } else {
        stryCov_9fa48("1178");
        fields.startTime = stryMutAct_9fa48("1179") ? "" : (stryCov_9fa48("1179"), "Enter a valid time.");
      }
    } else {
      if (stryMutAct_9fa48("1180")) {
        {}
      } else {
        stryCov_9fa48("1180");
        startTime = String(input.startTime);
      }
    }
    let endTime: string | undefined;
    if (stryMutAct_9fa48("1182") ? false : stryMutAct_9fa48("1181") ? true : (stryCov_9fa48("1181", "1182"), isBlank(input.endTime))) {
      if (stryMutAct_9fa48("1183")) {
        {}
      } else {
        stryCov_9fa48("1183");
        fields.endTime = stryMutAct_9fa48("1184") ? "" : (stryCov_9fa48("1184"), "This field is required.");
      }
    } else if (stryMutAct_9fa48("1187") ? false : stryMutAct_9fa48("1186") ? true : stryMutAct_9fa48("1185") ? TIME_PATTERN.test(String(input.endTime)) : (stryCov_9fa48("1185", "1186", "1187"), !TIME_PATTERN.test(String(input.endTime)))) {
      if (stryMutAct_9fa48("1188")) {
        {}
      } else {
        stryCov_9fa48("1188");
        fields.endTime = stryMutAct_9fa48("1189") ? "" : (stryCov_9fa48("1189"), "Enter a valid time.");
      }
    } else {
      if (stryMutAct_9fa48("1190")) {
        {}
      } else {
        stryCov_9fa48("1190");
        endTime = String(input.endTime);
      }
    }
    if (stryMutAct_9fa48("1193") ? startTime && endTime || toMinutes(endTime) <= toMinutes(startTime) : stryMutAct_9fa48("1192") ? false : stryMutAct_9fa48("1191") ? true : (stryCov_9fa48("1191", "1192", "1193"), (stryMutAct_9fa48("1195") ? startTime || endTime : stryMutAct_9fa48("1194") ? true : (stryCov_9fa48("1194", "1195"), startTime && endTime)) && (stryMutAct_9fa48("1198") ? toMinutes(endTime) > toMinutes(startTime) : stryMutAct_9fa48("1197") ? toMinutes(endTime) < toMinutes(startTime) : stryMutAct_9fa48("1196") ? true : (stryCov_9fa48("1196", "1197", "1198"), toMinutes(endTime) <= toMinutes(startTime))))) {
      if (stryMutAct_9fa48("1199")) {
        {}
      } else {
        stryCov_9fa48("1199");
        fields.endTime = stryMutAct_9fa48("1200") ? "" : (stryCov_9fa48("1200"), "End time must be after the start time.");
      }
    }
    let expectedAttendance: number | undefined;
    if (stryMutAct_9fa48("1202") ? false : stryMutAct_9fa48("1201") ? true : (stryCov_9fa48("1201", "1202"), isBlank(input.expectedAttendance))) {
      if (stryMutAct_9fa48("1203")) {
        {}
      } else {
        stryCov_9fa48("1203");
        fields.expectedAttendance = stryMutAct_9fa48("1204") ? "" : (stryCov_9fa48("1204"), "This field is required.");
      }
    } else {
      if (stryMutAct_9fa48("1205")) {
        {}
      } else {
        stryCov_9fa48("1205");
        const numericValue = Number(input.expectedAttendance);
        if (stryMutAct_9fa48("1208") ? false : stryMutAct_9fa48("1207") ? true : stryMutAct_9fa48("1206") ? Number.isFinite(numericValue) : (stryCov_9fa48("1206", "1207", "1208"), !Number.isFinite(numericValue))) {
          if (stryMutAct_9fa48("1209")) {
            {}
          } else {
            stryCov_9fa48("1209");
            fields.expectedAttendance = stryMutAct_9fa48("1210") ? "" : (stryCov_9fa48("1210"), "Enter a valid number.");
          }
        } else if (stryMutAct_9fa48("1214") ? numericValue > 0 : stryMutAct_9fa48("1213") ? numericValue < 0 : stryMutAct_9fa48("1212") ? false : stryMutAct_9fa48("1211") ? true : (stryCov_9fa48("1211", "1212", "1213", "1214"), numericValue <= 0)) {
          if (stryMutAct_9fa48("1215")) {
            {}
          } else {
            stryCov_9fa48("1215");
            fields.expectedAttendance = stryMutAct_9fa48("1216") ? "" : (stryCov_9fa48("1216"), "Expected attendance must be greater than zero.");
          }
        } else {
          if (stryMutAct_9fa48("1217")) {
            {}
          } else {
            stryCov_9fa48("1217");
            expectedAttendance = numericValue;
          }
        }
      }
    }
    if (stryMutAct_9fa48("1221") ? Object.keys(fields).length <= 0 : stryMutAct_9fa48("1220") ? Object.keys(fields).length >= 0 : stryMutAct_9fa48("1219") ? false : stryMutAct_9fa48("1218") ? true : (stryCov_9fa48("1218", "1219", "1220", "1221"), Object.keys(fields).length > 0)) {
      if (stryMutAct_9fa48("1222")) {
        {}
      } else {
        stryCov_9fa48("1222");
        return stryMutAct_9fa48("1223") ? {} : (stryCov_9fa48("1223"), {
          valid: stryMutAct_9fa48("1224") ? true : (stryCov_9fa48("1224"), false),
          fields
        });
      }
    }
    return stryMutAct_9fa48("1225") ? {} : (stryCov_9fa48("1225"), {
      valid: stryMutAct_9fa48("1226") ? false : (stryCov_9fa48("1226"), true),
      fields: {},
      value: stryMutAct_9fa48("1227") ? {} : (stryCov_9fa48("1227"), {
        name: stryMutAct_9fa48("1228") ? String(input.name) : (stryCov_9fa48("1228"), String(input.name).trim()),
        purpose: stryMutAct_9fa48("1229") ? String(input.purpose) : (stryCov_9fa48("1229"), String(input.purpose).trim()),
        description: stryMutAct_9fa48("1230") ? String(input.description) : (stryCov_9fa48("1230"), String(input.description).trim()),
        proposedDate: proposedDate!,
        startTime: startTime!,
        endTime: endTime!,
        expectedAttendance: expectedAttendance!,
        venue: stryMutAct_9fa48("1231") ? String(input.venue) : (stryCov_9fa48("1231"), String(input.venue).trim()),
        accessibility: stryMutAct_9fa48("1232") ? String(input.accessibility) : (stryCov_9fa48("1232"), String(input.accessibility).trim()),
        equipment: stryMutAct_9fa48("1233") ? String(input.equipment) : (stryCov_9fa48("1233"), String(input.equipment).trim()),
        technicalSupport: stryMutAct_9fa48("1234") ? String(input.technicalSupport) : (stryCov_9fa48("1234"), String(input.technicalSupport).trim()),
        registrationNeeded: stryMutAct_9fa48("1237") ? input.registrationNeeded === true && input.registrationNeeded === "true" : stryMutAct_9fa48("1236") ? false : stryMutAct_9fa48("1235") ? true : (stryCov_9fa48("1235", "1236", "1237"), (stryMutAct_9fa48("1239") ? input.registrationNeeded !== true : stryMutAct_9fa48("1238") ? false : (stryCov_9fa48("1238", "1239"), input.registrationNeeded === (stryMutAct_9fa48("1240") ? false : (stryCov_9fa48("1240"), true)))) || (stryMutAct_9fa48("1242") ? input.registrationNeeded !== "true" : stryMutAct_9fa48("1241") ? false : (stryCov_9fa48("1241", "1242"), input.registrationNeeded === (stryMutAct_9fa48("1243") ? "" : (stryCov_9fa48("1243"), "true")))))
      })
    });
  }
}
export interface DraftEventRequest {
  name: string;
  purpose: string;
  description: string;
  proposedDate: string;
  startTime: string;
  endTime: string;
  expectedAttendance: number | null;
  venue: string;
  accessibility: string;
  equipment: string;
  technicalSupport: string;
  registrationNeeded: boolean;
}
function toTrimmedString(value: unknown): string {
  if (stryMutAct_9fa48("1244")) {
    {}
  } else {
    stryCov_9fa48("1244");
    return (stryMutAct_9fa48("1247") ? typeof value !== "string" : stryMutAct_9fa48("1246") ? false : stryMutAct_9fa48("1245") ? true : (stryCov_9fa48("1245", "1246", "1247"), typeof value === (stryMutAct_9fa48("1248") ? "" : (stryCov_9fa48("1248"), "string")))) ? stryMutAct_9fa48("1249") ? value : (stryCov_9fa48("1249"), value.trim()) : stryMutAct_9fa48("1250") ? "Stryker was here!" : (stryCov_9fa48("1250"), "");
  }
}

/**
 * E2-4 AC1: normalises a draft payload without enforcing any of
 * validateEventRequest's mandatory-field/format rules — a draft is
 * explicitly allowed to be incomplete. Values are coerced the same way a
 * real submission's are, so the eventual E2-1 validation on submit (AC3)
 * sees consistent data either way.
 */
export function normaliseDraftEventRequest(input: EventRequestInput): DraftEventRequest {
  if (stryMutAct_9fa48("1251")) {
    {}
  } else {
    stryCov_9fa48("1251");
    const attendance = Number(input.expectedAttendance);
    return stryMutAct_9fa48("1252") ? {} : (stryCov_9fa48("1252"), {
      name: toTrimmedString(input.name),
      purpose: toTrimmedString(input.purpose),
      description: toTrimmedString(input.description),
      proposedDate: toTrimmedString(input.proposedDate),
      startTime: toTrimmedString(input.startTime),
      endTime: toTrimmedString(input.endTime),
      expectedAttendance: (stryMutAct_9fa48("1255") ? isBlank(input.expectedAttendance) && !Number.isFinite(attendance) : stryMutAct_9fa48("1254") ? false : stryMutAct_9fa48("1253") ? true : (stryCov_9fa48("1253", "1254", "1255"), isBlank(input.expectedAttendance) || (stryMutAct_9fa48("1256") ? Number.isFinite(attendance) : (stryCov_9fa48("1256"), !Number.isFinite(attendance))))) ? null : attendance,
      venue: toTrimmedString(input.venue),
      accessibility: toTrimmedString(input.accessibility),
      equipment: toTrimmedString(input.equipment),
      technicalSupport: toTrimmedString(input.technicalSupport),
      registrationNeeded: stryMutAct_9fa48("1259") ? input.registrationNeeded === true && input.registrationNeeded === "true" : stryMutAct_9fa48("1258") ? false : stryMutAct_9fa48("1257") ? true : (stryCov_9fa48("1257", "1258", "1259"), (stryMutAct_9fa48("1261") ? input.registrationNeeded !== true : stryMutAct_9fa48("1260") ? false : (stryCov_9fa48("1260", "1261"), input.registrationNeeded === (stryMutAct_9fa48("1262") ? false : (stryCov_9fa48("1262"), true)))) || (stryMutAct_9fa48("1264") ? input.registrationNeeded !== "true" : stryMutAct_9fa48("1263") ? false : (stryCov_9fa48("1263", "1264"), input.registrationNeeded === (stryMutAct_9fa48("1265") ? "" : (stryCov_9fa48("1265"), "true")))))
    });
  }
}