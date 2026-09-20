import type { ValidatedEventRequest } from "./validateEventRequest.js";

// E2-10 AC1: the organiser's edit itself becomes the reply posted into the
// clarification thread — no separate typed message required. This produces
// that human-readable diff.

const FIELD_LABELS: Record<keyof ValidatedEventRequest, string> = {
  name: "Event name",
  purpose: "Purpose",
  description: "Description",
  proposedDate: "Proposed date",
  startTime: "Start time",
  endTime: "End time",
  expectedAttendance: "Expected attendance",
  venue: "Venue",
  accessibility: "Accessibility",
  equipment: "Equipment",
  technicalSupport: "Technical support",
  registrationNeeded: "Registration needed",
};

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/**
 * Compares the old and new submitted_details field-by-field and returns a
 * human-readable summary of what changed, one line per field, or null if
 * nothing changed (so callers can skip posting an empty/no-op reply).
 */
export function diffSubmittedDetails(
  oldDetails: Partial<ValidatedEventRequest>,
  newDetails: ValidatedEventRequest,
): string | null {
  const lines: string[] = [];

  for (const key of Object.keys(FIELD_LABELS) as (keyof ValidatedEventRequest)[]) {
    const oldValue = oldDetails[key];
    const newValue = newDetails[key];

    if (oldValue === newValue) continue;

    lines.push(`${FIELD_LABELS[key]} changed from '${formatValue(oldValue ?? "—")}' to '${formatValue(newValue)}'`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}
