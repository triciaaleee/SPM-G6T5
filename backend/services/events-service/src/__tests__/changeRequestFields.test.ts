import { describe, expect, it } from "vitest";
import {
  committedFieldValue,
  validateChangeRequestFields,
  withHeldValues,
} from "../lib/changeRequestFields.js";
import type { ValidatedEventRequest } from "../lib/validateEventRequest.js";

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
