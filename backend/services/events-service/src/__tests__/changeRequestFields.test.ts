import { describe, expect, it } from "vitest";
import {
  CRITICAL_CHANGE_FIELDS,
  committedFieldValue,
  isCriticalField,
  validateChangeRequestFields,
  withHeldValues,
} from "../lib/changeRequestFields.js";
import type { ValidatedEventRequest } from "../lib/validateEventRequest.js";
import { clock } from "../lib/clock.js";

const current: Partial<ValidatedEventRequest> = {
  name: "Spring Gala",
  venue: "Grand Ballroom",
  expectedAttendance: 100,
  registrationNeeded: true,
};

describe("validateChangeRequestFields — no-op detection", () => {
  it("doesn't treat resubmitting the same number as a change", () => {
    // Regression: the no-op check used to compare the raw (numeric)
    // current value against the always-stringified new value, so
    // `100 === "100"` was false and every resubmission of an unchanged
    // numeric field registered as a spurious change.
    const result = validateChangeRequestFields({ expectedAttendance: 100 }, current);
    expect(result.valid).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("still detects a genuine numeric change", () => {
    const result = validateChangeRequestFields({ expectedAttendance: 150 }, current);
    expect(result.changes).toEqual([
      { field: "expectedAttendance", oldValue: "100", newValue: "150", isCritical: true },
    ]);
  });

  it("doesn't treat resubmitting the same string as a change", () => {
    const result = validateChangeRequestFields({ venue: "Grand Ballroom" }, current);
    expect(result.changes).toEqual([]);
  });

  it("doesn't treat resubmitting the same boolean as a change", () => {
    const result = validateChangeRequestFields({ registrationNeeded: true }, current);
    expect(result.changes).toEqual([]);
  });
});

describe("committedFieldValue", () => {
  it("formats the current value as a string", () => {
    expect(committedFieldValue(current, "expectedAttendance")).toBe("100");
    expect(committedFieldValue(current, "venue")).toBe("Grand Ballroom");
  });

  it("returns null for a field with no committed value", () => {
    expect(committedFieldValue(current, "equipment")).toBeNull();
  });
});

describe("withHeldValues", () => {
  it("overlays held fields on top of the committed baseline", () => {
    const overlaid = withHeldValues(current, [{ field: "venue", newValue: "Seminar Room 3-01" }]);
    expect(overlaid.venue).toBe("Seminar Room 3-01");
    expect(overlaid.name).toBe("Spring Gala");
  });

  it("parses a held expectedAttendance back to a number", () => {
    const overlaid = withHeldValues(current, [{ field: "expectedAttendance", newValue: "150" }]);
    expect(overlaid.expectedAttendance).toBe(150);
  });

  it("resubmitting an already-held value against the overlay is a no-op", () => {
    const overlaid = withHeldValues(current, [{ field: "expectedAttendance", newValue: "150" }]);
    const result = validateChangeRequestFields({ expectedAttendance: 150 }, overlaid);
    expect(result.changes).toEqual([]);
  });
});

const baseline: Partial<ValidatedEventRequest> = {
  ...current,
  startTime: "10:00",
  endTime: "12:00",
  proposedDate: "2099-01-01",
};

function isoDay(offsetDays: number): string {
  return new Date(clock.now().getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

describe("isCriticalField", () => {
  it.each([...CRITICAL_CHANGE_FIELDS])("%s is critical", (field) => {
    expect(isCriticalField(field)).toBe(true);
  });

  it.each(["name", "purpose", "description", "technicalSupport", "registrationNeeded", "", "constructor"])(
    "%j is not critical",
    (field) => {
      expect(isCriticalField(field)).toBe(false);
    },
  );
});

describe("validateChangeRequestFields — proposedDate boundaries", () => {
  it("accepts today", () => {
    expect(validateChangeRequestFields({ proposedDate: isoDay(0) }, baseline).valid).toBe(true);
  });

  it("rejects yesterday", () => {
    const result = validateChangeRequestFields({ proposedDate: isoDay(-1) }, baseline);
    expect(result.valid).toBe(false);
    expect(result.fields.proposedDate).toBe("The proposed date cannot be in the past.");
  });

  it("accepts tomorrow", () => {
    expect(validateChangeRequestFields({ proposedDate: isoDay(1) }, baseline).valid).toBe(true);
  });

  it.each([null, undefined, "", "   "])("requires a value (%j)", (value) => {
    const result = validateChangeRequestFields({ proposedDate: value }, baseline);
    expect(result.fields.proposedDate).toBe("This field is required.");
  });

  it.each(["not-a-date", "2099-13-45", "2099-02-30x"])("rejects an unparseable date (%j)", (value) => {
    const result = validateChangeRequestFields({ proposedDate: value }, baseline);
    expect(result.fields.proposedDate).toBe("Enter a valid date.");
  });
});

describe("validateChangeRequestFields — time boundaries", () => {
  it.each(["00:00", "09:59", "23:59"])("accepts %s as a start time that fits", (time) => {
    const result = validateChangeRequestFields({ startTime: time }, { ...baseline, endTime: "23:59" });
    // 23:59 start equals the 23:59 end, so only the end-after-start rule can fail here.
    expect(result.fields.startTime).toBeUndefined();
  });

  it.each(["24:00", "9:5", "12:60", "1200", "12-00", "ab:cd", "-1:00"])("rejects the malformed time %j", (time) => {
    expect(validateChangeRequestFields({ startTime: time }, baseline).fields.startTime).toBe("Enter a valid time.");
    expect(validateChangeRequestFields({ endTime: time }, baseline).fields.endTime).toBe("Enter a valid time.");
  });

  it.each([null, "", "  "])("requires a time (%j)", (time) => {
    expect(validateChangeRequestFields({ startTime: time }, baseline).fields.startTime).toBe("This field is required.");
    expect(validateChangeRequestFields({ endTime: time }, baseline).fields.endTime).toBe("This field is required.");
  });

  it("rejects an end time equal to the start time", () => {
    const result = validateChangeRequestFields({ endTime: "10:00" }, baseline);
    expect(result.fields.endTime).toBe("End time must be after the start time.");
  });

  it("accepts an end time one minute after the start time", () => {
    expect(validateChangeRequestFields({ endTime: "10:01" }, baseline).valid).toBe(true);
  });

  it("rejects an end time one minute before the start time", () => {
    expect(validateChangeRequestFields({ endTime: "09:59" }, baseline).valid).toBe(false);
  });

  it("checks a new start time against the current end time", () => {
    expect(validateChangeRequestFields({ startTime: "12:00" }, baseline).fields.endTime).toBe(
      "End time must be after the start time.",
    );
    expect(validateChangeRequestFields({ startTime: "11:59" }, baseline).valid).toBe(true);
  });

  it("checks both new times together, ignoring the current ones", () => {
    expect(validateChangeRequestFields({ startTime: "15:00", endTime: "16:00" }, baseline).valid).toBe(true);
    expect(validateChangeRequestFields({ startTime: "16:00", endTime: "15:00" }, baseline).valid).toBe(false);
  });

  it("skips the ordering check when the other time is unknown", () => {
    expect(validateChangeRequestFields({ startTime: "23:00" }, {}).valid).toBe(true);
  });

  it("doesn't also report an ordering error when a time is malformed", () => {
    const result = validateChangeRequestFields({ startTime: "99:99", endTime: "08:00" }, baseline);
    expect(result.fields).toEqual({ startTime: "Enter a valid time." });
  });
});

describe("validateChangeRequestFields — expectedAttendance boundaries", () => {
  it.each([1, "1", 5000, "  25  "])("accepts %j", (value) => {
    expect(validateChangeRequestFields({ expectedAttendance: value }, baseline).valid).toBe(true);
  });

  it.each([0, "0", -1, "-50"])("rejects %j as not above zero", (value) => {
    expect(validateChangeRequestFields({ expectedAttendance: value }, baseline).fields.expectedAttendance).toBe(
      "Expected attendance must be greater than zero.",
    );
  });

  it.each(["abc", "Infinity", NaN, {}])("rejects %j as not a number", (value) => {
    expect(validateChangeRequestFields({ expectedAttendance: value }, baseline).fields.expectedAttendance).toBe(
      "Enter a valid number.",
    );
  });

  it.each([null, undefined, "", "   "])("requires a value (%j)", (value) => {
    expect(validateChangeRequestFields({ expectedAttendance: value }, baseline).fields.expectedAttendance).toBe(
      "This field is required.",
    );
  });
});

describe("validateChangeRequestFields — required text fields", () => {
  it.each(["name", "purpose", "description", "venue", "accessibility", "equipment", "technicalSupport"])(
    "%s can't be blank",
    (field) => {
      for (const blank of ["", "   ", null, undefined]) {
        expect(validateChangeRequestFields({ [field]: blank }, baseline).fields[field]).toBe("This field is required.");
      }
    },
  );

  it("trims the new value before comparing and reporting", () => {
    const result = validateChangeRequestFields({ venue: "  Seminar Room  " }, baseline);
    expect(result.changes).toEqual([
      { field: "venue", oldValue: "Grand Ballroom", newValue: "Seminar Room", isCritical: true },
    ]);
  });

  it("treats a padded copy of the current value as no change", () => {
    expect(validateChangeRequestFields({ venue: "  Grand Ballroom  " }, baseline).changes).toEqual([]);
  });

  it("reports a null oldValue for a field with no committed value", () => {
    const result = validateChangeRequestFields({ equipment: "Projector" }, baseline);
    expect(result.changes).toEqual([{ field: "equipment", oldValue: null, newValue: "Projector", isCritical: true }]);
  });

  it("marks a non-critical field as not critical", () => {
    const result = validateChangeRequestFields({ name: "Autumn Gala" }, baseline);
    expect(result.changes[0].isCritical).toBe(false);
  });
});

describe("validateChangeRequestFields — registrationNeeded and unknown fields", () => {
  it("reads true and 'true' as Yes, anything else as No", () => {
    const off = { ...baseline, registrationNeeded: false };
    for (const value of [true, "true"]) {
      expect(validateChangeRequestFields({ registrationNeeded: value }, off).changes).toEqual([
        { field: "registrationNeeded", oldValue: "No", newValue: "Yes", isCritical: false },
      ]);
    }
    for (const value of [false, "false", "yes", 1, null]) {
      expect(validateChangeRequestFields({ registrationNeeded: value }, baseline).changes).toEqual([
        { field: "registrationNeeded", oldValue: "Yes", newValue: "No", isCritical: false },
      ]);
    }
  });

  it("ignores fields a change request may not carry", () => {
    const result = validateChangeRequestFields({ status: "Confirmed", coordinator_id: "X", __proto__: { a: 1 } }, baseline);
    expect(result).toEqual({ valid: true, fields: {}, changes: [] });
  });

  it("returns no changes for an empty body", () => {
    expect(validateChangeRequestFields({}, baseline)).toEqual({ valid: true, fields: {}, changes: [] });
  });

  it("reports every invalid field at once and no changes", () => {
    const result = validateChangeRequestFields({ expectedAttendance: 0, venue: "", name: "Fine" }, baseline);
    expect(result.valid).toBe(false);
    expect(Object.keys(result.fields).sort()).toEqual(["expectedAttendance", "venue"]);
    expect(result.changes).toEqual([]);
  });

  it("returns changes in the order of the editable-field list, not the body", () => {
    const result = validateChangeRequestFields({ venue: "B", name: "A" }, baseline);
    expect(result.changes.map((c) => c.field)).toEqual(["name", "venue"]);
  });
});

describe("committedFieldValue / withHeldValues — edges", () => {
  it("formats a boolean as Yes/No", () => {
    expect(committedFieldValue({ registrationNeeded: false }, "registrationNeeded")).toBe("No");
    expect(committedFieldValue({ registrationNeeded: true }, "registrationNeeded")).toBe("Yes");
  });

  it("treats 0 as a committed value, not as missing", () => {
    expect(committedFieldValue({ expectedAttendance: 0 }, "expectedAttendance")).toBe("0");
  });

  it("leaves the baseline untouched and handles an empty held list", () => {
    const overlaid = withHeldValues(current, []);
    expect(overlaid).toEqual(current);
    expect(overlaid).not.toBe(current);
    withHeldValues(current, [{ field: "venue", newValue: "X" }]);
    expect(current.venue).toBe("Grand Ballroom");
  });

  it("lets the last held value for a field win", () => {
    const overlaid = withHeldValues(current, [
      { field: "venue", newValue: "A" },
      { field: "venue", newValue: "B" },
    ]);
    expect(overlaid.venue).toBe("B");
  });
});
