import { createHash } from "node:crypto";
import {
  invalidateTenantCache,
  readTenantCache,
  writeTenantCache,
} from "./tenant-response-cache";
import {
  readThroughProviderCache,
  type ProviderCacheStore,
} from "./provider-cache";

export type RevenueSummaryPayload = {
  payingWebsiteSubscriptions: number;
  countsByStripePriceId: Record<string, number>;
  mrrEstimatedUsd: number | null;
  monthlyCollected: {
    selectedMonth: string;
    timezone: "UTC";
    headline: "net";
    byCurrency: Record<
      string,
      {
        grossCents: number;
        refundsCents: number;
        disputesCents: number;
        netCents: number;
        chargeCount: number;
        refundCount: number;
        disputeCount: number;
      }
    >;
    trend: Array<{
      month: string;
      byCurrency: Record<
        string,
        {
          grossCents: number;
          refundsCents: number;
          disputesCents: number;
          netCents: number;
          chargeCount: number;
          refundCount: number;
          disputeCount: number;
        }
      >;
    }>;
  } | null;
};

/**
 * Soft age: past this the value is still served and a refresh runs behind the
 * response. The figures below come from three paginated Stripe walks — charges,
 * refunds and disputes, per month of the trend — which measured ~1.4 s on
 * production, and Customer Analysis waited on it once every ten minutes.
 */
const SOFT_TTL_SECONDS = 10 * 60;

/**
 * Hard age: how long a value stays servable, and so how much traffic-free time
 * it takes before someone has to wait for Stripe again. Money figures on a
 * dashboard tolerate being an hour old far better than a page that stalls.
 */
const HARD_TTL_SECONDS = 60 * 60;
const CACHE_NAMESPACE = "superadmin-revenue-summary-v1";
const PLATFORM_CACHE_SCOPE = "platform-superadmin";

function namespaceFor(cacheKey: string): string {
  const suffix = createHash("sha256").update(cacheKey).digest("hex").slice(0, 24);
  return `${CACHE_NAMESPACE}:${suffix}`;
}

export async function invalidateSuperadminRevenueCache(): Promise<void> {
  await invalidateTenantCache(PLATFORM_CACHE_SCOPE);
}

const store: ProviderCacheStore = {
  read: (namespace) =>
    readTenantCache<unknown>({ namespace, userId: PLATFORM_CACHE_SCOPE }),
  write: (namespace, value, ttlSeconds) =>
    writeTenantCache({
      namespace,
      userId: PLATFORM_CACHE_SCOPE,
      value,
      ttlSeconds,
    }),
};

export async function getRevenueSummaryWithCache(
  cacheKey: string,
  compute: () => Promise<RevenueSummaryPayload>,
): Promise<RevenueSummaryPayload> {
  return readThroughProviderCache<RevenueSummaryPayload>({
    namespace: namespaceFor(cacheKey),
    softTtlSeconds: SOFT_TTL_SECONDS,
    hardTtlSeconds: HARD_TTL_SECONDS,
    // A stored payload must at least still be an object with the money block
    // this returns, or it is refetched rather than trusted.
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      "payingWebsiteSubscriptions" in (value as Record<string, unknown>),
    store,
    compute,
  });
}
