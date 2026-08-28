import {
  invalidateTenantCache,
  readTenantCache,
  writeTenantCache,
} from "./tenant-response-cache";

const COMMAND_SCOPE = "platform-command-panel";

/**
 * A second scope, for data we did not compute.
 *
 * `invalidateCommandCache` bumps a revision that drops every entry in
 * COMMAND_SCOPE at once — the right behaviour for anything derived from our own
 * tables, because a rep edit or a cost entry can change almost any figure in the
 * panel.
 *
 * It is the wrong behaviour for what we read out of Stripe. A Stripe price, a
 * product name, a coupon on a subscription: none of them change because someone
 * renamed a service here, and re-fetching them costs seconds of sequential HTTP
 * to api.stripe.com. Sharing one scope meant a call webhook — which fires
 * whenever a sales call is recorded — silently threw away the most expensive
 * thing the panel caches. Provider data expires on its own clock instead.
 */
const PROVIDER_SCOPE = "platform-command-provider-catalog";

/**
 * The Command overview ships the whole subscriber roster in one payload, which
 * is the point — every page in the panel then shares a single cache entry rather
 * than warming one each. That payload is the largest thing here and it grows
 * with the customer base, so it gets headroom above the shared 1 MB default.
 *
 * Crossing this limit does not corrupt anything: the response stays correct and
 * the endpoint simply stops being cached. What it does is turn a 200 ms page
 * into a multi-second one silently, which is why the write path now logs every
 * skip instead of once a minute.
 */
const COMMAND_MAX_VALUE_BYTES = 6 * 1024 * 1024;

export async function readCommandCache<T>(namespace: string): Promise<T | null> {
  return readTenantCache<T>({ namespace, userId: COMMAND_SCOPE });
}

export async function writeCommandCache<T>(
  namespace: string,
  value: T,
  ttlSeconds = 120,
): Promise<void> {
  await writeTenantCache({
    namespace,
    userId: COMMAND_SCOPE,
    value,
    ttlSeconds,
    maxValueBytes: COMMAND_MAX_VALUE_BYTES,
  });
}

/** Read a cached third-party payload. Unaffected by `invalidateCommandCache`. */
export async function readCommandProviderCache<T>(
  namespace: string,
): Promise<T | null> {
  return readTenantCache<T>({ namespace, userId: PROVIDER_SCOPE });
}

/** Write a cached third-party payload. Expires only by TTL. */
export async function writeCommandProviderCache<T>(
  namespace: string,
  value: T,
  ttlSeconds: number,
): Promise<void> {
  await writeTenantCache({
    namespace,
    userId: PROVIDER_SCOPE,
    value,
    ttlSeconds,
    maxValueBytes: COMMAND_MAX_VALUE_BYTES,
  });
}

export async function invalidateCommandCache(): Promise<void> {
  await invalidateTenantCache(COMMAND_SCOPE);
}

/**
 * Drops the provider catalog deliberately — for a reconciliation run, where the
 * point is to go and look again.
 */
export async function invalidateCommandProviderCache(): Promise<void> {
  await invalidateTenantCache(PROVIDER_SCOPE);
}
