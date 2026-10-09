// E5-1: validation for POST /api/equipment-requests, driven by the
// story's acceptance criteria — equipment type, quantity and technical
// requirements per item (AC1), quantity of zero or less blocked (AC3).

export interface EquipmentItemInput {
  equipmentType?: unknown;
  quantity?: unknown;
  technicalRequirements?: unknown;
}

export interface ValidatedEquipmentItem {
  equipmentType: string;
  quantity: number;
  technicalRequirements: string;
}

export interface ValidationResult {
  valid: boolean;
  /** "items[0].quantity" etc., one entry per problem found. */
  fields: Record<string, string>;
  value?: ValidatedEquipmentItem[];
}

const MAX_ITEMS = 50;

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Validates and normalises the item list of an equipment request. Collects
 * every field error in one pass (rather than failing fast), mirroring
 * events-service's validateEventRequest, so the caller can report every
 * problem at once instead of one submission attempt per fix.
 */
export function validateEquipmentItems(input: unknown): ValidationResult {
  if (!Array.isArray(input) || input.length === 0) {
    return { valid: false, fields: { items: "At least one equipment item is required." } };
  }
  if (input.length > MAX_ITEMS) {
    return { valid: false, fields: { items: `At most ${MAX_ITEMS} items are allowed per request.` } };
  }

  const fields: Record<string, string> = {};
  const value: ValidatedEquipmentItem[] = [];

  input.forEach((raw, index) => {
    const item = (raw && typeof raw === "object" ? raw : {}) as EquipmentItemInput;

    if (isBlank(item.equipmentType)) {
      fields[`items[${index}].equipmentType`] = "Equipment type is required.";
    }

    let quantity: number | undefined;
    if (isBlank(item.quantity)) {
      fields[`items[${index}].quantity`] = "Quantity is required.";
    } else {
      const numericValue = Number(item.quantity);
      if (!Number.isFinite(numericValue) || !Number.isInteger(numericValue)) {
        fields[`items[${index}].quantity`] = "Enter a whole number.";
      } else if (numericValue <= 0) {
        // AC3: a quantity of zero or less blocks submission.
        fields[`items[${index}].quantity`] = "Quantity must be greater than zero.";
      } else {
        quantity = numericValue;
      }
    }

    if (!fields[`items[${index}].equipmentType`] && quantity !== undefined) {
      value.push({
        equipmentType: String(item.equipmentType).trim(),
        quantity,
        technicalRequirements: isBlank(item.technicalRequirements) ? "" : String(item.technicalRequirements).trim(),
      });
    }
  });

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }
  return { valid: true, fields: {}, value };
}

/** The real values equipment_requests.status can take on (migration 0020). */
export const EQUIPMENT_REQUEST_STATUSES = ["Requested", "Arranged", "Partially Fulfilled"] as const;
export type EquipmentRequestStatus = (typeof EQUIPMENT_REQUEST_STATUSES)[number];

export interface StatusUpdateInput {
  status?: unknown;
  note?: unknown;
}

export interface StatusUpdateResult {
  valid: boolean;
  fields: Record<string, string>;
  value?: { status: EquipmentRequestStatus; note: string | null };
}

/**
 * Validation for PATCH /api/equipment-requests/:id. AC2: a note describing
 * what remains outstanding is required when the status is "Partially
 * Fulfilled"; the note is cleared for any other status so it can't go
 * stale once arrangements move on.
 */
export function validateStatusUpdate(input: StatusUpdateInput): StatusUpdateResult {
  const fields: Record<string, string> = {};

  const status = typeof input.status === "string" ? input.status.trim() : "";
  if (!(EQUIPMENT_REQUEST_STATUSES as readonly string[]).includes(status)) {
    fields.status = `Status must be one of: ${EQUIPMENT_REQUEST_STATUSES.join(", ")}.`;
  }

  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (status === "Partially Fulfilled" && note === "") {
    fields.note = "A note describing what remains outstanding is required.";
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }
  const keptNote = status === "Partially Fulfilled" && note !== "" ? note : null;
  return { valid: true, fields: {}, value: { status: status as EquipmentRequestStatus, note: keptNote } };
}
