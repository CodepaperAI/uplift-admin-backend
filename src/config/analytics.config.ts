import { BetaAnalyticsDataClient } from "@google-analytics/data";

/**
 * Analytics Config
 * ----------------------------------------------------------------------------
 * Configuration for Google Analytics 4 integration (Phase 4 AEO).
 *
 * Two deployment models are supported:
 *
 * 1. Global service account (ops default)
 *    - Set GOOGLE_SERVICE_ACCOUNT_JSON to the JSON key's contents.
 *    - Customers grant this service-account email Viewer access to their
 *      GA4 property.
 *    - Per-business configuration stores only the ga4PropertyId.
 *
 * 2. Per-business service account (advanced)
 *    - Customer provides their own service account JSON stored in
 *      BusinessAnalyticsConfig.serviceAccountRef. Used verbatim to build
 *      an AnalyticsDataClient for that business only.
 *
 * The service layer calls `getAnalyticsClient(serviceAccountRef?)`. If a
 * reference is provided it takes precedence; otherwise we fall back to
 * the global client.
 */

export const GA4_GLOBAL_SERVICE_ACCOUNT_JSON =
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";

let globalClient: BetaAnalyticsDataClient | null = null;

/**
 * Return a ready-to-use AnalyticsDataClient.
 * Prefers the per-business serviceAccountRef (raw JSON string) when passed.
 * Falls back to the global client built from GOOGLE_SERVICE_ACCOUNT_JSON.
 *
 * Returns null if no credentials are configured — callers handle this as
 * "GA4 not connected yet" rather than throwing.
 */
export function getAnalyticsClient(
  serviceAccountRef?: string | null,
): BetaAnalyticsDataClient | null {
  if (serviceAccountRef) {
    try {
      const credentials = JSON.parse(serviceAccountRef);
      return new BetaAnalyticsDataClient({ credentials });
    } catch (err) {
      console.error(
        "[analytics.config] failed to parse per-business service account:",
        (err as Error).message,
      );
      return null;
    }
  }

  if (!GA4_GLOBAL_SERVICE_ACCOUNT_JSON) {
    return null;
  }

  if (!globalClient) {
    try {
      const credentials = JSON.parse(GA4_GLOBAL_SERVICE_ACCOUNT_JSON);
      globalClient = new BetaAnalyticsDataClient({ credentials });
    } catch (err) {
      console.error(
        "[analytics.config] failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:",
        (err as Error).message,
      );
      return null;
    }
  }
  return globalClient;
}

/**
 * AI-engine traffic sources to isolate in GA4 reports.
 *
 * Matches GA4's `sessionSource` dimension. Keep this list tight — adding
 * e.g. "bing.com" would pollute the signal (most Bing traffic is organic
 * search, not Copilot). "perplexity.ai" includes all subdomains via GA4's
 * wildcard-less `matches` filter.
 */
export const AI_ENGINE_SOURCE_PATTERN =
  "(chatgpt|perplexity|gemini\\.google|claude\\.ai|copilot\\.microsoft|you\\.com|phind\\.com)";

export const AI_ENGINE_DOMAINS = [
  "chatgpt.com",
  "chat.openai.com",
  "perplexity.ai",
  "www.perplexity.ai",
  "gemini.google.com",
  "claude.ai",
  "copilot.microsoft.com",
  "you.com",
  "phind.com",
] as const;
