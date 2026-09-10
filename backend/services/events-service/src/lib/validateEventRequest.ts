// E2-1: validation for POST /api/events, driven by the story's acceptance
// criteria (mandatory fields, no past dates, positive attendance, end > start).

export interface EventRequestInput {
  name?: unknown;
  purpose?: unknown;
  description?: unknown;
  proposedDate?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  expectedAttendance?: unknown;
}

export interface ValidatedEventRequest {
  name: string;
  purpose: string;
  description: string;
  proposedDate: string;
  startTime: string;
  endTime: string;
  expectedAttendance: number;
}

export interface ValidationResult {
  valid: boolean;
  fields: Record<string, string>;
  value?: ValidatedEventRequest;
}

const REQUIRED_TEXT_FIELDS = ["name", "purpose", "description"] as const;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Validates and normalises a raw event-request payload. Collects every
 * field error in one pass (rather than failing fast) so the caller can
 * report all of them at once, per AC "every missing field is identified".
 */
export function validateEventRequest(input: EventRequestInput): ValidationResult {
  const fields: Record<string, string> = {};

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (isBlank(input[field])) fields[field] = "This field is required.";
  }

  let proposedDate: string | undefined;
  if (isBlank(input.proposedDate)) {
    fields.proposedDate = "This field is required.";
  } else {
    const raw = String(input.proposedDate);
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      fields.proposedDate = "Enter a valid date.";
    } else if (raw < todayIsoDate()) {
      fields.proposedDate = "The proposed date cannot be in the past.";
    } else {
      proposedDate = raw;
    }
  }

  let startTime: string | undefined;
  if (isBlank(input.startTime)) {
    fields.startTime = "This field is required.";
  } else if (!TIME_PATTERN.test(String(input.startTime))) {
    fields.startTime = "Enter a valid time.";
  } else {
    startTime = String(input.startTime);
  }

  let endTime: string | undefined;
  if (isBlank(input.endTime)) {
    fields.endTime = "This field is required.";
  } else if (!TIME_PATTERN.test(String(input.endTime))) {
    fields.endTime = "Enter a valid time.";
  } else {
    endTime = String(input.endTime);
  }

  if (startTime && endTime && toMinutes(endTime) <= toMinutes(startTime)) {
    fields.endTime = "End time must be after the start time.";
  }

  let expectedAttendance: number | undefined;
  if (isBlank(input.expectedAttendance)) {
    fields.expectedAttendance = "This field is required.";
  } else {
    const numericValue = Number(input.expectedAttendance);
    if (!Number.isFinite(numericValue)) {
      fields.expectedAttendance = "Enter a valid number.";
    } else if (numericValue <= 0) {
      fields.expectedAttendance = "Expected attendance must be greater than zero.";
    } else {
      expectedAttendance = numericValue;
    }
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }

  return {
    valid: true,
    fields: {},
    value: {
      name: String(input.name).trim(),
      purpose: String(input.purpose).trim(),
      description: String(input.description).trim(),
      proposedDate: proposedDate!,
      startTime: startTime!,
      endTime: endTime!,
      expectedAttendance: expectedAttendance!,
    },
  };
}
