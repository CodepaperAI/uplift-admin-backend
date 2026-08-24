const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const cache = new Map<string, { data: unknown; expiresAt: number }>();

export function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T, ttlMs: number = DEFAULT_TTL_MS): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/**
 * Wrap an async function with caching. Returns cached result if available,
 * otherwise calls compute() and caches the result.
 */
export async function withCache<T>(
  key: string,
  compute: () => Promise<T>,
  options?: { ttlMs?: number; forceRefresh?: boolean },
): Promise<T> {
  if (!options?.forceRefresh) {
    const cached = getCached<T>(key);
    if (cached !== null) {
      console.log(`📦 DataForSEO cache hit: ${key}`);
      return cached;
    }
  }

  const result = await compute();
  setCache(key, result, options?.ttlMs);
  return result;
}
