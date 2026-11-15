/**
 * Failed-login throttle, in memory.
 *
 * Counts failures per key (email, and separately the client address)
 * in a sliding window; once a key reaches the limit, sign-in for it is
 * refused until the window has passed. In memory is enough for a
 * single-process personal deployment: a restart resets the counters,
 * which costs an attacker a restart they cannot trigger. A success
 * clears the email's counter.
 */

export interface Throttle {
  /** Seconds to wait, or 0 when an attempt is allowed. */
  retryAfter(key: string, now?: number): number;
  fail(key: string, now?: number): void;
  clear(key: string): void;
}

export const createThrottle = (options: {
  limit: number;
  windowMs: number;
}): Throttle => {
  const failures = new Map<string, number[]>();

  const recent = (key: string, now: number) => {
    const kept = (failures.get(key) ?? []).filter(
      (at) => now - at < options.windowMs
    );
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  };

  return {
    retryAfter(key, now = Date.now()) {
      const list = recent(key, now);
      if (list.length < options.limit) return 0;
      return Math.max(1, Math.ceil((list[0] + options.windowMs - now) / 1000));
    },
    fail(key, now = Date.now()) {
      const list = recent(key, now);
      list.push(now);
      failures.set(key, list);
      // Bounded memory under a spray of random emails.
      if (failures.size > 10_000) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
    },
    clear(key) {
      failures.delete(key);
    },
  };
};

/** 10 failures per email or per address within 15 minutes. */
export const loginThrottle = createThrottle({ limit: 10, windowMs: 15 * 60 * 1000 });
