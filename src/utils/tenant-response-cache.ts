import { createHash } from "node:crypto";
import { createClient } from "redis";

const CACHE_PREFIX = "uplift:v1";
const MIN_TTL_SECONDS = 15;
const MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
const REVISION_TTL_SECONDS = MAX_TTL_SECONDS + 24 * 60 * 60;
const MAX_VALUE_BYTES = 1024 * 1024;
/**
 * A ceiling a caller may raise for a payload it knows is large.
 *
 * Valkey is happy with multi-megabyte values and it sits inside the VPC, so the
 * transfer is not the constraint. The reason for a limit at all is to catch a
 * caller accidentally caching something unbounded.
 */
const MAX_CONFIGURABLE_VALUE_BYTES = 8 * 1024 * 1024;
const REDIS_CONNECT_TIMEOUT_MS = 2_000;
const REDIS_CONNECT_MAX_RETRIES = 1;

type CacheRedisClient = {
  isReady: boolean;
  connect(): Promise<unknown>;
  destroy(): void;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  ping(): Promise<string>;
  set(key: string, value: string, options: { EX: number; NX?: boolean }): Promise<unknown>;
  ttl(key: string): Promise<number>;
};

const FIXED_WINDOW_RATE_LIMIT_SCRIPT = `
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then
  redis.call("SET", KEYS[1], "1", "EX", ARGV[1])
  return {1, tonumber(ARGV[1])}
end
local count = redis.call("INCR", KEYS[1])
return {count, ttl}
`;

let client: CacheRedisClient | null = null;
let connection: Promise<CacheRedisClient | null> | null = null;
let lastErrorLogAt = 0;

export function redisUrlRequiresTls(input: {
  hostname: string;
  passwordPresent: boolean;
  nodeEnv?: string;
  appEnv?: string;
  deployEnv?: string;
}): boolean {
  if (input.nodeEnv !== "production") return false;
  if (input.hostname === "localhost" || input.hostname === "127.0.0.1") {
    return false;
  }

  const deploymentEnvironment = (input.appEnv || input.deployEnv || "")
    .trim()
    .toLowerCase();
  const authenticatedDockerDevelopmentRedis =
    deploymentEnvironment === "development" &&
    input.hostname === "redis" &&
    input.passwordPresent;

  return !authenticatedDockerDevelopmentRedis;
}

function logRedisError(message: string, error?: unknown) {
  const now = Date.now();
  if (now - lastErrorLogAt < 60_000) return;
  lastErrorLogAt = now;
  console.error(`[redis-cache] ${message}`, error instanceof Error ? error.message : "");
}

/**
 * Never rate-limited, unlike the connection errors above.
 *
 * A skipped write is not a transient fault — it means this namespace has grown
 * past its ceiling and is now recomputed from PostgreSQL on *every* request,
 * with the endpoint still returning correct data and simply becoming slow. That
 * is the failure mode nobody notices, so it gets a line every time it happens.
 */
function logOversizedValue(namespace: string, bytes: number, limit: number) {
  console.error(
    JSON.stringify({
      level: "error",
      service: "tenant-response-cache",
      event: "cache_write_skipped_oversized",
      namespace,
      bytes,
      limit,
      impact: "namespace is uncached; every request recomputes it",
    }),
  );
}

function configuredRedisUrl(): string | null {
  const raw = process.env.REDIS_URL?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      logRedisError("REDIS_URL must use redis:// or rediss://");
      return null;
    }
    if (
      parsed.protocol !== "rediss:" &&
      redisUrlRequiresTls({
        hostname: parsed.hostname,
        passwordPresent: parsed.password.length > 0,
        nodeEnv: process.env.NODE_ENV,
        appEnv: process.env.APP_ENV,
        deployEnv: process.env.DEPLOY_ENV,
      })
    ) {
      logRedisError("Non-local production Redis must use TLS (rediss://)");
      return null;
    }
    return raw;
  } catch {
    logRedisError("REDIS_URL is invalid");
    return null;
  }
}

async function getClient(): Promise<CacheRedisClient | null> {
  const url = configuredRedisUrl();
  if (!url) return null;
  if (client?.isReady) return client;
  if (connection) return connection;

  connection = (async () => {
    const candidate = createClient({
      url,
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        // Cache reads and invalidations must never hold an authoritative API
        // response open indefinitely. A later request will create a fresh
        // client and retry, so one short reconnect is enough here.
        reconnectStrategy: (retries) =>
          retries >= REDIS_CONNECT_MAX_RETRIES
            ? false
            : Math.min(100 * 2 ** retries, 3_000),
      },
    });
    candidate.on("error", (error) => logRedisError("Client error", error));
    try {
      await candidate.connect();
      client = candidate;
      return candidate;
    } catch (error) {
      logRedisError("Connection failed; continuing without cache", error);
      try {
        candidate.destroy();
      } catch {
        // The cache is optional; a failed cleanup must not affect requests.
      }
      return null;
    } finally {
      connection = null;
    }
  })();
  return connection;
}

export async function checkTenantCacheReadiness(): Promise<boolean> {
  try {
    const redis = await getClient();
    if (!redis) return false;
    return (await redis.ping()) === "PONG";
  } catch (error) {
    logRedisError("Readiness check failed", error);
    return false;
  }
}

function scopeHash(userId: string, businessId?: string | null): string {
  return createHash("sha256")
    .update(`${userId}\0${businessId ?? "account"}`)
    .digest("hex")
    .slice(0, 32);
}

function revisionKey(scope: string) {
  return `${CACHE_PREFIX}:revision:${scope}`;
}

function valueKey(namespace: string, scope: string, revision: string) {
  return `${CACHE_PREFIX}:${namespace}:${scope}:r${revision}`;
}

async function currentRevision(redis: CacheRedisClient, scope: string): Promise<string> {
  return (await redis.get(revisionKey(scope))) ?? "0";
}

export async function readTenantCache<T>(input: {
  namespace: string;
  userId: string;
  businessId?: string | null;
}): Promise<T | null> {
  try {
    const redis = await getClient();
    if (!redis) return null;
    const scope = scopeHash(input.userId, input.businessId);
    const revision = await currentRevision(redis, scope);
    const raw = await redis.get(valueKey(input.namespace, scope, revision));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (error) {
    logRedisError("Read failed; continuing from PostgreSQL", error);
    return null;
  }
}

export async function writeTenantCache<T>(input: {
  namespace: string;
  userId: string;
  businessId?: string | null;
  value: T;
  ttlSeconds: number;
  maxValueBytes?: number;
}): Promise<void> {
  try {
    const redis = await getClient();
    if (!redis) return;
    const serialized = JSON.stringify(input.value);
    const limit = Math.min(
      MAX_CONFIGURABLE_VALUE_BYTES,
      Math.max(MAX_VALUE_BYTES, input.maxValueBytes ?? MAX_VALUE_BYTES),
    );
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > limit) {
      logOversizedValue(input.namespace, bytes, limit);
      return;
    }
    const ttl = Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, input.ttlSeconds));
    const scope = scopeHash(input.userId, input.businessId);
    const revision = await currentRevision(redis, scope);
    await redis.set(valueKey(input.namespace, scope, revision), serialized, {
      EX: ttl + Math.floor(Math.random() * Math.max(1, Math.floor(ttl * 0.1))),
    });
  } catch (error) {
    logRedisError("Write failed; response remains authoritative from PostgreSQL", error);
  }
}

export async function invalidateTenantCache(
  userId: string,
  businessId?: string | null,
): Promise<void> {
  try {
    const redis = await getClient();
    if (!redis) return;
    const key = revisionKey(scopeHash(userId, businessId));
    await redis.incr(key);
    // Revisions only need to outlive the longest possible cached value. An
    // expiry prevents deleted tenants/businesses from leaving permanent keys,
    // while the extra day ensures an old r0 value cannot become visible again.
    await redis.expire(key, REVISION_TTL_SECONDS);
  } catch (error) {
    logRedisError("Invalidation failed", error);
  }
}

const localRateLimits = new Map<string, { count: number; resetAt: number }>();

export async function consumeSensitiveRateLimit(input: {
  namespace: string;
  discriminator: string;
  limit: number;
  windowSeconds: number;
}): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const discriminator = createHash("sha256")
    .update(input.discriminator)
    .digest("hex")
    .slice(0, 32);
  const key = `${CACHE_PREFIX}:rate:${input.namespace}:${discriminator}`;
  const redis = await getClient();
  if (redis) {
    try {
      // One Redis operation owns both the increment and expiry. The previous
      // SET-NX/INCR sequence could race exactly as a key expired: INCR then
      // recreated it without a TTL, permanently locking that auth bucket.
      // Treat a legacy non-expiring key as corrupt and start a fresh window.
      const result = await redis.eval(FIXED_WINDOW_RATE_LIMIT_SCRIPT, {
        keys: [key],
        arguments: [String(input.windowSeconds)],
      });
      if (!Array.isArray(result) || result.length < 2) {
        throw new Error("Unexpected Redis rate-limit result");
      }
      const count = Number(result[0]);
      const ttl = Math.max(1, Number(result[1]));
      if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
        throw new Error("Invalid Redis rate-limit result");
      }
      return {
        allowed: count <= input.limit,
        remaining: Math.max(0, input.limit - count),
        retryAfterSeconds: ttl,
      };
    } catch (error) {
      logRedisError("Rate-limit store failed", error);
    }
  }

  const failClosed =
    process.env.NODE_ENV === "production" &&
    process.env.REDIS_SECURITY_FAIL_CLOSED !== "false";
  if (failClosed) {
    logRedisError(
      "Security rate-limit store unavailable; rejecting request until Redis recovers",
    );
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 5,
    };
  }

  const now = Date.now();
  const existing = localRateLimits.get(key);
  const entry = !existing || existing.resetAt <= now
    ? { count: 1, resetAt: now + input.windowSeconds * 1000 }
    : { ...existing, count: existing.count + 1 };
  localRateLimits.set(key, entry);
  return {
    allowed: entry.count <= input.limit,
    remaining: Math.max(0, input.limit - entry.count),
    retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
  };
}
