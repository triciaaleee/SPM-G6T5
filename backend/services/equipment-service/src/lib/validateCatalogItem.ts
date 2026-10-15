// E5-1/E5-3 inventory records: validation for POST and PATCH on
// /api/equipment-catalog. Technical Support add items and correct stock;
// counts are whole numbers, never negative, and the units on the shelf can
// never exceed the units owned (the database enforces the same rule).

export interface NewCatalogItem {
  name: string;
  totalStock: number;
}

export interface CatalogItemChanges {
  totalStock?: number;
  availableStock?: number;
}

export type Validation<T> = { valid: true; value: T } | { valid: false; fields: Record<string, string> };

const MAX_NAME_LENGTH = 100;
const MAX_STOCK = 100000;

function parseCount(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_STOCK ? n : null;
}

export function validateNewCatalogItem(input: unknown): Validation<NewCatalogItem> {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "") fields.name = "Enter an equipment name.";
  else if (name.length > MAX_NAME_LENGTH) fields.name = `Use at most ${MAX_NAME_LENGTH} characters.`;

  const totalStock = parseCount(body.totalStock ?? 0);
  if (totalStock === null) fields.totalStock = "Total stock must be a whole number, 0 or more.";

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, value: { name, totalStock: totalStock! } };
}

/**
 * Only the fields present are changed. The route checks `availableStock <=
 * totalStock` against the item's current values for whichever one is omitted.
 */
export function validateCatalogChanges(input: unknown): Validation<CatalogItemChanges> {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const value: CatalogItemChanges = {};

  if (body.totalStock !== undefined) {
    const n = parseCount(body.totalStock);
    if (n === null) fields.totalStock = "Total stock must be a whole number, 0 or more.";
    else value.totalStock = n;
  }
  if (body.availableStock !== undefined) {
    const n = parseCount(body.availableStock);
    if (n === null) fields.availableStock = "Available stock must be a whole number, 0 or more.";
    else value.availableStock = n;
  }
  if (body.totalStock === undefined && body.availableStock === undefined) {
    fields.totalStock = "Provide totalStock and/or availableStock.";
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, value };
}
