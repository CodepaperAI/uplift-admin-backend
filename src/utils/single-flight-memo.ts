/**
 * An in-process, short-lived memo that collapses concurrent identical work.
 *
 * The problem this exists for: the admin panel builds its user corpus by paging
 * through `metrics/users`, and every one of those pages recomputes the *same*
 * dataset — every user, three nested relations, an onboarding breakdown each —
 * before slicing out its own hundred rows. The pages after the first are
 * requested concurrently, so three requests for three different slices of one
 * identical dataset arrive at once and each builds it from scratch.
 *
 * Storing the in-flight promise, not just the settled value, is what fixes that:
 * the second and third callers await the first caller's work instead of starting
 * their own. The short TTL then covers the rest of the walk and a reader
 * switching between the panel pages that share the corpus.
 *
 * Deliberately in-process rather than in Redis. The value is large — megabytes of
 * objects — and would cost more to serialise, ship and parse than to rebuild;
 * and single-flight is only expressible where the promise lives. Redis remains
 * the right place for finished response payloads, which is what the endpoints
 * that return small documents use.
 *
 * A failed computation is evicted immediately, so one error cannot be served for
 * the rest of the TTL.
 */
type Entry<T> = { expiresAt: number; value: Promise<T> };

export type SingleFlightMemo<T> = {
  get(key: string, compute: () => Promise<T>): Promise<T>;
  /** Cached and in-flight entry count. For assertions and diagnostics. */
  size(): number;
  clear(): void;
};

export function createSingleFlightMemo<T>(options: {
  ttlMs: number;
  /**
   * How many distinct keys may be held at once.
   *
   * Each key is a filter combination, and the values are large. Without a cap, a
   * caller varying the search term would accumulate a dataset per term for the
   * whole TTL. On overflow the oldest expiry is dropped, which is the entry
   * closest to being useless anyway.
   */
  maxEntries: number;
  now?: () => number;
}): SingleFlightMemo<T> {
  const entries = new Map<string, Entry<T>>();
  const clock = options.now ?? (() => Date.now());

  function evictExpired(at: number): void {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
  }

  function evictOldestIfFull(): void {
    while (entries.size >= Math.max(1, options.maxEntries)) {
      let oldestKey: string | null = null;
      let oldestExpiry = Number.POSITIVE_INFINITY;
      for (const [key, entry] of entries) {
        if (entry.expiresAt < oldestExpiry) {
          oldestExpiry = entry.expiresAt;
          oldestKey = key;
        }
      }
      if (oldestKey === null) return;
      entries.delete(oldestKey);
    }
  }

  return {
    get(key, compute) {
      const at = clock();
      evictExpired(at);
      const existing = entries.get(key);
      if (existing) return existing.value;

      evictOldestIfFull();
      const value = compute();
      entries.set(key, { expiresAt: at + options.ttlMs, value });
      // Do not let a rejection be served for the rest of the TTL, and do not
      // let this handler itself become an unhandled rejection: the caller still
      // awaits `value` and still sees the error.
      void value.catch(() => {
        const current = entries.get(key);
        if (current?.value === value) entries.delete(key);
      });
      return value;
    },
    size() {
      evictExpired(clock());
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}
