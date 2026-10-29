// @ts-nocheck
// 
import { afterEach, beforeEach } from "vitest";
import { setClockForTest } from "../lib/clock.js";

/**
 * Every test starts with the service clock pinned, so no test depends on the date or time the suite runs at.
 * A test that cares about a different instant sets its own with setClockForTest; the clock goes back to the
 * system clock afterwards so nothing leaks into the next test.
 */
export const TEST_NOW = "2026-10-28T04:00:00.000Z";

beforeEach(() => setClockForTest(TEST_NOW));
afterEach(() => setClockForTest());

