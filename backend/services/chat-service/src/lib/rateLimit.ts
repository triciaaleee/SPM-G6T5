/**
 * A small in-memory sliding-window limiter, keyed by user id. Kept in-process
 * on purpose: this project runs a single chat-service instance (same stance as
 * venue-service's withVenueLock), and a chat message is not worth a Redis.
 */
export interface RateLimiter {
  /** Records one attempt for `key` and says whether it is within the limit. */
  hit(key: string): { allowed: boolean; retryAfterSeconds: number };
  /** How many keys are currently tracked (so the idle-key sweep can be tested). */
  size(): number;
  /** Forgets every key (tests). */
  reset(): void;
}

/** Above this many tracked keys, idle ones are dropped so the map can't grow without bound. */
const SWEEP_THRESHOLD = 1000;

export function createRateLimiter(options: {
  max: () => number;
  windowMs: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const attempts = new Map<string, number[]>();

  return {
    hit(key) {
      const t = now();
      if (attempts.size > SWEEP_THRESHOLD) {
        for (const [k, times] of attempts) {
          if (times.every((at) => t - at >= options.windowMs)) attempts.delete(k);
        }
      }

      const existing = attempts.get(key);
      const recent = existing ? existing.filter((at) => t - at < options.windowMs) : [];

      if (recent.length >= options.max()) {
        const retryAfterMs = options.windowMs - (t - recent[0]);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }

      recent.push(t);
      attempts.set(key, recent);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    size() {
      return attempts.size;
    },
    reset() {
      attempts.clear();
    },
  };
}
