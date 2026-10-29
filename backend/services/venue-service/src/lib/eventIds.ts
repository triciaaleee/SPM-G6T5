export const MAX_EVENT_IDS = 100;

/**
 * The `eventIds` query parameter: 1 to MAX_EVENT_IDS comma-separated positive
 * whole numbers, de-duplicated. Null for anything else, including a missing
 * parameter or one repeated (`?eventIds=1&eventIds=2`).
 */
export function parseEventIds(raw: unknown): number[] | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((id) => id.trim());
  if (parts.length > MAX_EVENT_IDS || !parts.every((id) => /^[1-9]\d*$/.test(id))) return null;
  return [...new Set(parts.map(Number))];
}
