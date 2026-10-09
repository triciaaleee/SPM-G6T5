import { describe, expect, it } from "vitest";
import { pendingVenueLocks, withVenueLock } from "../lib/venueLock.js";

/** Resolves on the next macrotask, so a task can yield mid-flight. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("withVenueLock (E4-11 AC5)", () => {
  it("runs decisions for one venue strictly one at a time", async () => {
    const trace: string[] = [];
    const task = (label: string) => async () => {
      trace.push(`${label}:start`);
      await tick();
      trace.push(`${label}:end`);
    };

    await Promise.all([withVenueLock(1, task("a")), withVenueLock(1, task("b"))]);

    // Nothing interleaves: b cannot read the venue until a has written.
    expect(trace).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("lets the second decision see the first one's write", async () => {
    const bookings: string[] = [];
    const hold = (label: string) => async () => {
      const taken = bookings.length > 0;
      await tick();
      if (!taken) bookings.push(label);
      return taken ? "conflict" : "ok";
    };

    const results = await Promise.all([withVenueLock(1, hold("a")), withVenueLock(1, hold("b"))]);

    expect(results).toEqual(["ok", "conflict"]);
    expect(bookings).toEqual(["a"]);
  });

  it("AC7: different venues are not serialised against each other", async () => {
    const trace: string[] = [];
    const task = (label: string) => async () => {
      trace.push(`${label}:start`);
      await tick();
      trace.push(`${label}:end`);
    };

    await Promise.all([withVenueLock(1, task("v1")), withVenueLock(2, task("v2"))]);

    // Both start before either finishes — venue 2 never waits on venue 1.
    expect(trace.slice(0, 2).sort()).toEqual(["v1:start", "v2:start"]);
  });

  it("propagates a failure to its own caller without poisoning the queue", async () => {
    const failing = withVenueLock(1, async () => {
      throw new Error("supabase down");
    });
    const next = withVenueLock(1, async () => "ran anyway");

    await expect(failing).rejects.toThrow("supabase down");
    await expect(next).resolves.toBe("ran anyway");
  });

  it("forgets a venue once its queue drains", async () => {
    await withVenueLock(99, async () => undefined);
    await tick();
    expect(pendingVenueLocks()).toBe(0);
  });
});
