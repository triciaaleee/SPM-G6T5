import { describe, expect, it } from "vitest";
import { createRateLimiter } from "../lib/rateLimit.js";

function limiter(max = 3, windowMs = 1000, start = 0) {
  let t = start;
  const l = createRateLimiter({ max: () => max, windowMs, now: () => t });
  return { l, advance: (ms: number) => (t += ms) };
}

describe("createRateLimiter", () => {
  it("allows up to max hits then blocks", () => {
    const { l } = limiter(3);
    expect([1, 2, 3].map(() => l.hit("a").allowed)).toEqual([true, true, true]);
    expect(l.hit("a").allowed).toBe(false);
  });

  it("tracks keys independently", () => {
    const { l } = limiter(1);
    expect(l.hit("a").allowed).toBe(true);
    expect(l.hit("b").allowed).toBe(true);
    expect(l.hit("a").allowed).toBe(false);
  });

  it("frees a slot exactly when the oldest hit leaves the window", () => {
    const { l, advance } = limiter(2, 1000);
    l.hit("a");
    advance(400);
    l.hit("a");
    advance(599);
    expect(l.hit("a").allowed).toBe(false);
    advance(1);
    expect(l.hit("a").allowed).toBe(true);
  });

  it("reports whole seconds to wait, at least 1", () => {
    const { l, advance } = limiter(1, 10_000, 100_000);
    l.hit("a");
    advance(2_500);
    expect(l.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 8 });
    advance(7_400);
    expect(l.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("does not count blocked attempts against the window", () => {
    const { l, advance } = limiter(1, 1000);
    l.hit("a");
    advance(500);
    l.hit("a");
    l.hit("a");
    advance(500);
    expect(l.hit("a").allowed).toBe(true);
  });

  it("re-reads max on every hit", () => {
    let max = 1;
    const l = createRateLimiter({ max: () => max, windowMs: 1000, now: () => 0 });
    l.hit("a");
    expect(l.hit("a").allowed).toBe(false);
    max = 2;
    expect(l.hit("a").allowed).toBe(true);
  });

  it("reset forgets everything", () => {
    const { l } = limiter(1);
    l.hit("a");
    l.reset();
    expect(l.hit("a").allowed).toBe(true);
  });

  it("sweeps idle keys once more than 1000 are tracked", () => {
    const { l, advance } = limiter(1, 1000);
    for (let i = 0; i < 1001; i++) l.hit(`k${i}`);
    expect(l.size()).toBe(1001);
    advance(1000);
    expect(l.hit("fresh").allowed).toBe(true);
    expect(l.size()).toBe(1);
  });

  it("does not sweep at exactly 1000 tracked keys", () => {
    const { l, advance } = limiter(1, 1000);
    for (let i = 0; i < 1000; i++) l.hit(`k${i}`);
    advance(1000);
    l.hit("fresh");
    expect(l.size()).toBe(1001);
  });

  it("keeps a key with any hit still inside the window when sweeping", () => {
    const { l, advance } = limiter(2, 1000);
    for (let i = 0; i < 1001; i++) l.hit(`k${i}`);
    advance(600);
    l.hit("k0");
    advance(400);
    l.hit("x");
    expect(l.size()).toBe(2);
  });

  it("does not sweep keys that are all still inside the window", () => {
    const { l, advance } = limiter(1, 1000);
    for (let i = 0; i < 1001; i++) l.hit(`k${i}`);
    advance(999);
    l.hit("x");
    expect(l.size()).toBe(1002);
  });
});
