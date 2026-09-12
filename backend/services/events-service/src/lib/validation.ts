const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * events.id is now an auto-incrementing integer (migration 0005), not a
 * uuid. Used to validate route params before querying, so malformed/
 * garbage IDs (e.g. "abc") are rejected without ever reaching the DB.
 */
export function isPositiveInteger(value: string): boolean {
  return POSITIVE_INTEGER_PATTERN.test(value);
}
