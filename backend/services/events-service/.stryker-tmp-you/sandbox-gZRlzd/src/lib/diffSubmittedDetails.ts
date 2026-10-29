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

// E2-10 AC1: the organiser's edit itself becomes the reply posted into the
// clarification thread — no separate typed message required. This produces
// that human-readable diff.

const FIELD_LABELS: Record<keyof ValidatedEventRequest, string> = stryMutAct_9fa48("319") ? {} : (stryCov_9fa48("319"), {
  name: stryMutAct_9fa48("320") ? "" : (stryCov_9fa48("320"), "Event name"),
  purpose: stryMutAct_9fa48("321") ? "" : (stryCov_9fa48("321"), "Purpose"),
  description: stryMutAct_9fa48("322") ? "" : (stryCov_9fa48("322"), "Description"),
  proposedDate: stryMutAct_9fa48("323") ? "" : (stryCov_9fa48("323"), "Proposed date"),
  startTime: stryMutAct_9fa48("324") ? "" : (stryCov_9fa48("324"), "Start time"),
  endTime: stryMutAct_9fa48("325") ? "" : (stryCov_9fa48("325"), "End time"),
  expectedAttendance: stryMutAct_9fa48("326") ? "" : (stryCov_9fa48("326"), "Expected attendance"),
  venue: stryMutAct_9fa48("327") ? "" : (stryCov_9fa48("327"), "Venue"),
  accessibility: stryMutAct_9fa48("328") ? "" : (stryCov_9fa48("328"), "Accessibility"),
  equipment: stryMutAct_9fa48("329") ? "" : (stryCov_9fa48("329"), "Equipment"),
  technicalSupport: stryMutAct_9fa48("330") ? "" : (stryCov_9fa48("330"), "Technical support"),
  registrationNeeded: stryMutAct_9fa48("331") ? "" : (stryCov_9fa48("331"), "Registration needed")
});
function formatValue(value: unknown): string {
  if (stryMutAct_9fa48("332")) {
    {}
  } else {
    stryCov_9fa48("332");
    if (stryMutAct_9fa48("335") ? typeof value !== "boolean" : stryMutAct_9fa48("334") ? false : stryMutAct_9fa48("333") ? true : (stryCov_9fa48("333", "334", "335"), typeof value === (stryMutAct_9fa48("336") ? "" : (stryCov_9fa48("336"), "boolean")))) return value ? stryMutAct_9fa48("337") ? "" : (stryCov_9fa48("337"), "Yes") : stryMutAct_9fa48("338") ? "" : (stryCov_9fa48("338"), "No");
    return String(value);
  }
}

/**
 * Compares the old and new submitted_details field-by-field and returns a
 * human-readable summary of what changed, one line per field, or null if
 * nothing changed (so callers can skip posting an empty/no-op reply).
 */
export function diffSubmittedDetails(oldDetails: Partial<ValidatedEventRequest>, newDetails: ValidatedEventRequest): string | null {
  if (stryMutAct_9fa48("339")) {
    {}
  } else {
    stryCov_9fa48("339");
    const lines: string[] = stryMutAct_9fa48("340") ? ["Stryker was here"] : (stryCov_9fa48("340"), []);
    for (const key of Object.keys(FIELD_LABELS) as (keyof ValidatedEventRequest)[]) {
      if (stryMutAct_9fa48("341")) {
        {}
      } else {
        stryCov_9fa48("341");
        const oldValue = oldDetails[key];
        const newValue = newDetails[key];
        if (stryMutAct_9fa48("344") ? oldValue !== newValue : stryMutAct_9fa48("343") ? false : stryMutAct_9fa48("342") ? true : (stryCov_9fa48("342", "343", "344"), oldValue === newValue)) continue;
        lines.push(stryMutAct_9fa48("346") ? `` : (stryCov_9fa48("346"), `${FIELD_LABELS[key]} changed from '${formatValue(stryMutAct_9fa48("347") ? oldValue && "—" : (stryCov_9fa48("347"), oldValue ?? (stryMutAct_9fa48("348") ? "" : (stryCov_9fa48("348"), "—"))))}' to '${formatValue(newValue)}'`));
      }
    }
    return (stryMutAct_9fa48("352") ? lines.length <= 0 : stryMutAct_9fa48("351") ? lines.length >= 0 : stryMutAct_9fa48("350") ? false : stryMutAct_9fa48("349") ? true : (stryCov_9fa48("349", "350", "351", "352"), lines.length > 0)) ? lines.join(stryMutAct_9fa48("353") ? "" : (stryCov_9fa48("353"), "\n")) : null;
  }
}
export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string;
}

/**
 * E2-7 AC3: the same field-by-field comparison as diffSubmittedDetails,
 * but returning structured { field, oldValue, newValue } rows instead of
 * a human-readable string — feeds the event_history audit table, which
 * needs the field name as its own column, not embedded in prose.
 */
export function diffSubmittedDetailsStructured(oldDetails: Partial<ValidatedEventRequest>, newDetails: ValidatedEventRequest): FieldChange[] {
  if (stryMutAct_9fa48("354")) {
    {}
  } else {
    stryCov_9fa48("354");
    const changes: FieldChange[] = stryMutAct_9fa48("355") ? ["Stryker was here"] : (stryCov_9fa48("355"), []);
    for (const key of Object.keys(FIELD_LABELS) as (keyof ValidatedEventRequest)[]) {
      if (stryMutAct_9fa48("356")) {
        {}
      } else {
        stryCov_9fa48("356");
        const oldValue = oldDetails[key];
        const newValue = newDetails[key];
        if (stryMutAct_9fa48("359") ? oldValue !== newValue : stryMutAct_9fa48("358") ? false : stryMutAct_9fa48("357") ? true : (stryCov_9fa48("357", "358", "359"), oldValue === newValue)) continue;
        changes.push(stryMutAct_9fa48("361") ? {} : (stryCov_9fa48("361"), {
          field: FIELD_LABELS[key],
          oldValue: (stryMutAct_9fa48("364") ? oldValue === undefined && oldValue === null : stryMutAct_9fa48("363") ? false : stryMutAct_9fa48("362") ? true : (stryCov_9fa48("362", "363", "364"), (stryMutAct_9fa48("366") ? oldValue !== undefined : stryMutAct_9fa48("365") ? false : (stryCov_9fa48("365", "366"), oldValue === undefined)) || (stryMutAct_9fa48("368") ? oldValue !== null : stryMutAct_9fa48("367") ? false : (stryCov_9fa48("367", "368"), oldValue === null)))) ? null : formatValue(oldValue),
          newValue: formatValue(newValue)
        }));
      }
    }
    return changes;
  }
}