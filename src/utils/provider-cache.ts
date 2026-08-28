import {
  readCommandProviderCache,
  writeCommandProviderCache,
} from "./command-cache";

/**
 * Stale-while-revalidate for third-party reads that take seconds.
 *
 * A plain TTL cache still makes somebody wait. The Command overview's Stripe
 * work costs ~3.8 s, so with a five-minute TTL one page load in every five
 * minutes paid it in full — twelve times better than the sixty-second response
 * cache it sat behind, and still a nearly four-second page for whoever arrives
 * first. The complaint being answered here was "it opens five or six seconds
 * later", so "usually fast" is not the goal.
 *
 * Two clocks instead of one:
 *
 * - a **soft** age, after which the value is still served but a refresh starts
 *   behind the response;
 * - a **hard** TTL, after which the entry is gone and the next caller has to
 *   wait for the provider.
 *
 * So the slow path is reached only on the very first call after a deploy, or
 * after a hard-TTL stretch with no traffic at all. Every other caller gets a
 * value that is at most one soft period old.
 *
 * The refresh is single-flighted in process, which is what stops a stampede:
 * without it every request arriving during a three-second refresh would start
 * its own, and the provider would get hammered exactly when it is slowest.
 *
 * A failed refresh is deliberately quiet — it leaves the last good value in
 * place until the hard TTL, which is the behaviour worth having when a provider
 * has a bad minute. It is logged once so a persistent failure is visible rather
 * than merely stale.
 */
type Envelope<T> = {
  /** Marks our own shape, so a foreign or older entry is ignored, not trusted. */
  v: 1;
  value: T;
  /** Epoch ms after which this is still served but should be refreshed. */
  softUntil: number;
};

function isEnvelope<T>(candidate: unknown): candidate is Envelope<T> {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as { v?: unknown }).v === 1 &&
    typeof (candidate as { softUntil?: unknown }).softUntil === "number" &&
    "value" in candidate
  );
}

/**
 * Coalescing only — deliberately not the caching kind.
 *
 * `createSingleFlightMemo` holds a *settled* value for its TTL, which is right
 * where it is used (a large dataset the panel pages through) and wrong here:
 * Redis already holds the value, and the only thing this needs to prevent is two
 * simultaneous fetches of the same key. Holding settled promises would also
 * suppress the next refresh — a cold fetch would leave its resolved promise in
 * the map, and the stale-revalidate a minute later would await that instead of
 * going to the provider, so the value would go stale and stay stale. The tests
 * for this file caught exactly that.
 *
 * So: entries live only while the work is in flight, and are removed the moment
 * it settles, either way.
 */
const inFlight = new Map<string, Promise<unknown>>();

function coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const started = run();
  inFlight.set(key, started);
  const clear = () => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  };
  started.then(clear, clear);
  return started;
}

let lastRefreshErrorLogAt = 0;

function logRefreshFailure(namespace: string, error: unknown): void {
  const now = Date.now();
  if (now - lastRefreshErrorLogAt < 60_000) return;
  lastRefreshErrorLogAt = now;
  console.error(
    JSON.stringify({
      level: "error",
      service: "provider-cache",
      event: "background_refresh_failed",
      namespace,
      message: error instanceof Error ? error.message : String(error),
      impact: "serving the last good value until its hard TTL expires",
    }),
  );
}

export async function readThroughProviderCache<T>(input: {
  namespace: string;
  /** Seconds before the value is served stale and refreshed behind the response. */
  softTtlSeconds: number;
  /** Seconds before the value is dropped and a caller must wait. */
  hardTtlSeconds: number;
  /** Fetches from the provider. Must throw rather than return a partial value. */
  compute: () => Promise<T>;
  /** Rejects an entry whose shape no longer matches, so it is refetched. */
  validate?: (value: unknown) => boolean;
  now?: () => number;
}): Promise<T> {
  const clock = input.now ?? (() => Date.now());
  const cached = await readCommandProviderCache<unknown>(input.namespace);

  const write = async (value: T): Promise<void> => {
    const envelope: Envelope<T> = {
      v: 1,
      value,
      softUntil: clock() + input.softTtlSeconds * 1000,
    };
    await writeCommandProviderCache(
      input.namespace,
      envelope,
      input.hardTtlSeconds,
    );
  };

  const fetchAndStore = async (): Promise<T> => {
    const value = await input.compute();
    await write(value);
    return value;
  };

  if (
    isEnvelope<T>(cached) &&
    (input.validate === undefined || input.validate(cached.value))
  ) {
    if (cached.softUntil <= clock()) {
      // Behind the response, once, however many callers arrive during it.
      void coalesce(input.namespace, fetchAndStore).catch((error: unknown) =>
        logRefreshFailure(input.namespace, error),
      );
    }
    return cached.value;
  }

  // Nothing usable cached: the only path that waits on the provider. Shares the
  // same in-flight entry, so concurrent cold callers make one provider call and
  // a refresh already running is awaited rather than duplicated.
  return coalesce(input.namespace, fetchAndStore);
}
