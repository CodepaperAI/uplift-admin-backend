import { createHash } from "node:crypto";
import {
  invalidateTenantCache,
  readTenantCache,
  writeTenantCache,
} from "./tenant-response-cache";

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

const TTL_SECONDS = 10 * 60;
const CACHE_NAMESPACE = "superadmin-revenue-summary-v1";
const PLATFORM_CACHE_SCOPE = "platform-superadmin";

function namespaceFor(cacheKey: string): string {
  const suffix = createHash("sha256").update(cacheKey).digest("hex").slice(0, 24);
  return `${CACHE_NAMESPACE}:${suffix}`;
}

export async function invalidateSuperadminRevenueCache(): Promise<void> {
  await invalidateTenantCache(PLATFORM_CACHE_SCOPE);
}

export async function getRevenueSummaryWithCache(
  cacheKey: string,
  compute: () => Promise<RevenueSummaryPayload>,
): Promise<RevenueSummaryPayload> {
  const cached = await readTenantCache<RevenueSummaryPayload>({
    namespace: namespaceFor(cacheKey),
    userId: PLATFORM_CACHE_SCOPE,
  });
  if (cached) return cached;

  const payload = await compute();
  await writeTenantCache({
    namespace: namespaceFor(cacheKey),
    userId: PLATFORM_CACHE_SCOPE,
    value: payload,
    ttlSeconds: TTL_SECONDS,
  });
  return payload;
}
