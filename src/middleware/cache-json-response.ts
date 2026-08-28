import type { NextFunction, Request, Response } from "express";
import { readTenantCache, writeTenantCache } from "./../utils/tenant-response-cache";

const PLATFORM_CACHE_SCOPE = "platform-superadmin";
const MAX_VALUE_BYTES = 6 * 1024 * 1024;

/**
 * Caches a successful JSON response for a read-only, caller-independent route.
 *
 * The superadmin analytics endpoints were entirely uncached, and several read a
 * whole table to produce a small document — `metrics/overview` pulls thirty days
 * of LLM usage events with their JSON metadata plus the whole
 * website-subscription table, and the panel calls it twice on every load of
 * Customer Analysis to read one count out of the result.
 *
 * Done here rather than inside each handler because it is the same behaviour
 * every time, and one mechanism with tests beats the same twenty lines pasted
 * into seven handlers, each free to get the key subtly wrong.
 *
 * **Only for routes whose response depends on the URL and nothing else.** The
 * key is the path and query string, with no caller in it, so a route that
 * varies its answer by who is asking must not use this — it would serve one
 * superadmin's view to another. Every route it is applied to is asserted
 * caller-independent at the call site, which is why this is opt-in per route
 * rather than mounted on the router.
 *
 * Rules that keep it honest:
 * - Only a 200 is stored. An error, a 403 or an empty-because-something-failed
 *   response must not be pinned for the TTL.
 * - `X-Cache` says `hit` or `miss`, so a slow load can be attributed without
 *   reading logs.
 * - A cache fault is not a request fault: `tenant-response-cache` swallows Redis
 *   errors and returns null, so this degrades to computing every time.
 */
export function cacheJsonResponse(input: {
  /** Stable short name; part of the Redis namespace. */
  name: string;
  ttlSeconds: number;
}) {
  return async function cacheJsonResponseMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (req.method !== "GET") {
      next();
      return;
    }
    // `req.originalUrl` carries the mount path and the query string, which is
    // exactly what identifies the answer. Two requests differing only in
    // parameter order are different keys — harmless, and cheaper than trying to
    // canonicalise a query string.
    const namespace = `superadmin-json-${input.name}-v1:${req.originalUrl}`;
    const cached = await readTenantCache<unknown>({
      namespace,
      userId: PLATFORM_CACHE_SCOPE,
    });
    if (cached !== null) {
      res.setHeader("X-Cache", "hit");
      res.json(cached);
      return;
    }

    res.setHeader("X-Cache", "miss");
    const sendJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode === 200) {
        // Fire-and-forget: the response must not wait on the cache write, and a
        // failed write leaves the response authoritative.
        void writeTenantCache({
          namespace,
          userId: PLATFORM_CACHE_SCOPE,
          value: body,
          ttlSeconds: input.ttlSeconds,
          maxValueBytes: MAX_VALUE_BYTES,
        });
      }
      return sendJson(body);
    }) as typeof res.json;
    next();
  };
}
