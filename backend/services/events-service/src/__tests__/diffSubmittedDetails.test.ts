import { describe, expect, it } from "vitest";
import { diffSubmittedDetails, diffSubmittedDetailsStructured } from "../lib/diffSubmittedDetails.js";
import type { ValidatedEventRequest } from "../lib/validateEventRequest.js";

const base: ValidatedEventRequest = {
  name: "Freshman Orientation",
  purpose: "Welcome new students",
  description: "An orientation session",
  proposedDate: "2099-01-01",
  startTime: "09:00",
  endTime: "17:00",
  expectedAttendance: 50,
  venue: "Main Hall",
  accessibility: "Wheelchair ramp",
  equipment: "Projector and 100 chairs",
  technicalSupport: "AV technician on-site",
  registrationNeeded: false,
};

describe("diffSubmittedDetailsStructured", () => {
  it("formats a boolean field change as Yes/No, not true/false (TC-25)", () => {
    const changes = diffSubmittedDetailsStructured(base, { ...base, registrationNeeded: true });

    expect(changes).toContainEqual({
      field: "Registration needed",
      oldValue: "No",
      newValue: "Yes",
    });
  });

  it("formats a numeric field change as its string representation (TC-26)", () => {
    const changes = diffSubmittedDetailsStructured(base, { ...base, expectedAttendance: 80 });

    expect(changes).toContainEqual({
      field: "Expected attendance",
      oldValue: "50",
      newValue: "80",
    });
  });

  it("records a null oldValue (not the string 'null' or '—') when the field was never previously set (TC-27)", () => {
    const { venue: _venue, ...oldDetailsMissingVenue } = base;

    const changes = diffSubmittedDetailsStructured(oldDetailsMissingVenue, base);

    expect(changes).toContainEqual({
      field: "Venue",
      oldValue: null,
      newValue: "Main Hall",
    });
  });

  it("also treats an explicit null oldValue as unset", () => {
    const changes = diffSubmittedDetailsStructured(
      { ...base, venue: null as unknown as string },
      base,
    );

    expect(changes).toContainEqual({
      field: "Venue",
      oldValue: null,
      newValue: "Main Hall",
    });
  });

  it("returns no rows when nothing changed", () => {
    expect(diffSubmittedDetailsStructured(base, { ...base })).toEqual([]);
  });

  it("returns one row per changed field when several fields change at once", () => {
    const changes = diffSubmittedDetailsStructured(base, {
      ...base,
      venue: "Other Hall",
      expectedAttendance: 100,
      equipment: "Microphones",
    });

    expect(changes).toHaveLength(3);
    expect(changes.map((c) => c.field).sort()).toEqual(["Equipment", "Expected attendance", "Venue"]);
  });
});

describe("diffSubmittedDetails (human-readable string, E2-10 reply text)", () => {
  it("renders a boolean change as Yes/No in prose", () => {
    const diff = diffSubmittedDetails(base, { ...base, registrationNeeded: true });

    expect(diff).toContain("Registration needed changed from 'No' to 'Yes'");
  });

  it("falls back to an em dash for a previously-unset field in prose", () => {
    const { venue: _venue, ...oldDetailsMissingVenue } = base;

    const diff = diffSubmittedDetails(oldDetailsMissingVenue, base);

    expect(diff).toContain("Venue changed from '—' to 'Main Hall'");
  });

  it("returns null when nothing changed", () => {
    expect(diffSubmittedDetails(base, { ...base })).toBeNull();
  });
});
