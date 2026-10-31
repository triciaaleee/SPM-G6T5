// E5-5 follow-up: validation for POST /api/equipment-catalog/:id/stock. Stock is
// added or removed in a stated quantity and always with a reason — it is never
// overwritten (available stock is derived, and total stock must stay in step
// with the unit rows, see change_equipment_stock in migration 0044).

import type { Validation } from "./validateCatalogItem.js";

export interface StockChange {
  direction: "add" | "remove";
  quantity: number;
  reason: string;
}

const MAX_QUANTITY = 100000;
const MAX_REASON_LENGTH = 500;

export function validateStockChange(input: unknown): Validation<StockChange> {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  const direction = body.direction;
  if (direction !== "add" && direction !== "remove") fields.direction = "Choose add or remove.";

  // Stryker disable next-line ConditionalExpression,StringLiteral,MethodExpression: a blank quantity becomes 0 or stays a string, and is refused either way
  const raw = typeof body.quantity === "string" && body.quantity.trim() !== "" ? Number(body.quantity) : body.quantity;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_QUANTITY) {
    fields.quantity = `Enter a whole number from 1 to ${MAX_QUANTITY}.`;
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason === "") fields.reason = "A reason is required.";
  else if (reason.length > MAX_REASON_LENGTH) fields.reason = `Use at most ${MAX_REASON_LENGTH} characters.`;

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, value: { direction: direction as "add" | "remove", quantity: raw as number, reason } };
}
