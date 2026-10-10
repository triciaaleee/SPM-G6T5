// E5-1: validation for POST /api/equipment-requests, driven by the
// story's acceptance criteria — equipment type, quantity and technical
// requirements per item (AC1), quantity of zero or less blocked (AC3).
//
// equipmentCatalogId (not a free-text equipmentType) ties every item to a
// row in equipment_catalog (migration 0022) so stock can be tracked; the
// route resolves it to a name/id pair and 400s if it doesn't exist.

export interface EquipmentItemInput {
  equipmentCatalogId?: unknown;
  quantity?: unknown;
}

export interface ValidatedEquipmentItem {
  equipmentCatalogId: number;
  quantity: number;
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

function isPositiveInteger(value: unknown): boolean {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && Number.isInteger(numericValue) && numericValue > 0;
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

    if (!isPositiveInteger(item.equipmentCatalogId)) {
      fields[`items[${index}].equipmentCatalogId`] = "Select an equipment type.";
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

    if (!fields[`items[${index}].equipmentCatalogId`] && quantity !== undefined) {
      value.push({
        equipmentCatalogId: Number(item.equipmentCatalogId),
        quantity,
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

export interface FulfillmentInput {
  itemId?: unknown;
  fulfilledQuantity?: unknown;
}

export interface StatusUpdateInput {
  status?: unknown;
  note?: unknown;
  fulfillments?: unknown;
}

/** The current request's items, as needed to validate fulfillments against. */
export interface StatusUpdateItem {
  id: number;
  quantity: number;
}

export interface ValidatedFulfillment {
  itemId: number;
  fulfilledQuantity: number;
}

export interface StatusUpdateResult {
  valid: boolean;
  fields: Record<string, string>;
  value?: { status: EquipmentRequestStatus; note: string | null; fulfillments: ValidatedFulfillment[] };
}

/**
 * Validation for PATCH /api/equipment-requests/:id. AC2: a note describing
 * what remains outstanding is required when the status is "Partially
 * Fulfilled"; the note is cleared for any other status so it can't go
 * stale once arrangements move on.
 *
 * Partially Fulfilled also requires a fulfilled quantity per item (0..that
 * item's requested quantity) so the stock taken off the shelf is exact —
 * see apply_equipment_request_status() (migration 0022). `items` is the
 * request's own items, passed in by the caller so every one of them (and
 * nothing else) must appear in `fulfillments`.
 */
export function validateStatusUpdate(input: StatusUpdateInput, items: StatusUpdateItem[]): StatusUpdateResult {
  const fields: Record<string, string> = {};

  const status = typeof input.status === "string" ? input.status.trim() : "";
  if (!(EQUIPMENT_REQUEST_STATUSES as readonly string[]).includes(status)) {
    fields.status = `Status must be one of: ${EQUIPMENT_REQUEST_STATUSES.join(", ")}.`;
  }

  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (status === "Partially Fulfilled" && note === "") {
    fields.note = "A note describing what remains outstanding is required.";
  }

  const fulfillments: ValidatedFulfillment[] = [];
  if (status === "Partially Fulfilled" && !fields.status) {
    const rawFulfillments = Array.isArray(input.fulfillments) ? input.fulfillments : [];
    const byItemId = new Map(
      rawFulfillments.map((raw) => {
        const f = (raw && typeof raw === "object" ? raw : {}) as FulfillmentInput;
        return [Number(f.itemId), f.fulfilledQuantity] as const;
      }),
    );

    for (const item of items) {
      const raw = byItemId.get(item.id);
      const numericValue = Number(raw);
      if (raw === undefined || !Number.isFinite(numericValue) || !Number.isInteger(numericValue)) {
        fields[`fulfillments[${item.id}]`] = "Enter how many of this item were fulfilled.";
      } else if (numericValue < 0 || numericValue > item.quantity) {
        fields[`fulfillments[${item.id}]`] = `Enter a number between 0 and ${item.quantity}.`;
      } else {
        fulfillments.push({ itemId: item.id, fulfilledQuantity: numericValue });
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields };
  }
  const keptNote = status === "Partially Fulfilled" && note !== "" ? note : null;
  return { valid: true, fields: {}, value: { status: status as EquipmentRequestStatus, note: keptNote, fulfillments } };
}
