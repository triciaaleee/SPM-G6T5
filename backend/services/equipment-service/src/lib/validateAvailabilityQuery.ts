// E5-4: validation for GET /api/equipment-availability.

export interface AvailabilityQuery {
  eventId: number;
  type: string;
  quantity: number;
}

export interface ValidationResult {
  valid: boolean;
  fields: Record<string, string>;
  value?: AvailabilityQuery;
}

function isPositiveInteger(value: unknown): boolean {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && Number.isInteger(numericValue) && numericValue > 0;
}

export function validateAvailabilityQuery(query: Record<string, unknown>): ValidationResult {
  const fields: Record<string, string> = {};

  if (!isPositiveInteger(query.eventId)) {
    fields.eventId = "A valid eventId is required.";
  }

  const type = typeof query.type === "string" ? query.type.trim() : "";
  if (!type) {
    fields.type = "Equipment type is required.";
  }

  if (!isPositiveInteger(query.quantity)) {
    fields.quantity = "Quantity must be a whole number greater than zero.";
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }
  return { valid: true, fields: {}, value: { eventId: Number(query.eventId), type, quantity: Number(query.quantity) } };
}
