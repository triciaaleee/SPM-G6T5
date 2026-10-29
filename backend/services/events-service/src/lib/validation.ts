const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;
/** Postgres `integer` tops out here; anything larger would make the query itself fail with a 500. */
const MAX_INTEGER_ID = 2_147_483_647;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * events.id is now an auto-incrementing integer (migration 0005), not a
 * uuid. Used to validate route params before querying, so malformed/
 * garbage IDs (e.g. "abc", or one too large for the column) are rejected
 * without ever reaching the DB.
 */
export function isPositiveInteger(value: string): boolean {
  return POSITIVE_INTEGER_PATTERN.test(value) && Number(value) <= MAX_INTEGER_ID;
}
