/**
 * The instant every test starts at (vitest.setup.ts fakes `Date` to it). Lives
 * under src/ so tests can import it without reaching outside tsconfig's rootDir.
 */
export const TEST_NOW = new Date("2026-10-28T04:00:00.000Z");
