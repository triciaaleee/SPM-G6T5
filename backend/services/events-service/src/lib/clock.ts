/**
 * The service's source of "now". Everything that needs the current time reads it from here instead of
 * calling `new Date()` / `Date.now()` directly, so a test can pin it (setClockForTest) without patching
 * the global Date and without depending on when or in which time zone the suite happens to run.
 */
export interface Clock {
  now(): Date;
}

const systemClock: Clock = { now: () => new Date() };

let current: Clock = systemClock;

export const clock: Clock = { now: () => current.now() };

/** Pin the clock to a fixed instant (or a custom clock); call with no argument to go back to the system clock. */
export function setClockForTest(next?: Clock | Date | string): void {
  if (next === undefined) current = systemClock;
  else if (typeof next === "string" || next instanceof Date) {
    const fixed = new Date(next);
    current = { now: () => new Date(fixed.getTime()) };
  } else current = next;
}
