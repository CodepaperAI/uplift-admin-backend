import fetch from "node-fetch";
import { getAuthHeader } from "./dataforseo.utils";
import { readDataForSeoResponse } from "./dataforseo-response";
import { SourceAvailabilityError } from "./source-availability.errors";

const DATAFORSEO_API_URL = "https://api.dataforseo.com/v3";

const DATAFORSEO_BACKLINKS_UNAVAILABLE_USER_MESSAGE =
  "DataForSEO backlinks access is not active for this workspace right now. Enable the Backlinks subscription in DataForSEO to resume syncing.";

function isBacklinksSubscriptionUnavailable(message?: string | null): boolean {
  const normalized = message?.toLowerCase() ?? "";
  if (!normalized) return false;

  return (
    normalized.includes("access denied") &&
    (normalized.includes("backlinks-subscription") ||
      normalized.includes("activate your subscription"))
  );
}

function throwIfBacklinksSubscriptionUnavailable(
  message: string | null | undefined,
  statusCode?: number
): void {
  if (!isBacklinksSubscriptionUnavailable(message)) {
    return;
  }

  throw new SourceAvailabilityError({
    source: "dataforseo-backlinks",
    code: "DATAFORSEO_BACKLINKS_UNAVAILABLE",
    message:
      message ||
      "DataForSEO backlinks subscription is not active for this account",
    userMessage: DATAFORSEO_BACKLINKS_UNAVAILABLE_USER_MESSAGE,
    retryable: false,
    statusCode,
  });
}

/**
 * DataForSEO Backlink data structure
 */
export interface DataForSEOBacklink {
  target?: string;
  url_from?: string;
  domain_from?: string;
  url_to?: string;
  domain_to?: string;
  domain_from_rank?: number;
  domain_from_type?: string;
  rank?: number;
  dofollow?: boolean;
  nofollow?: boolean;
  sponsored?: boolean;
  ugc?: boolean;
  anchor?: string;
  page_from_rank?: number;
  first_seen?: string;
  last_seen?: string;
  backlink_spam_score?: number;
  rank_spam_score?: number;
  domain_from_authority?: number;
  page_from_authority?: number;
  backlink_rank?: number;
  trust_score?: number;
  citation_flow?: number;
  trust_flow?: number;
}

/**
 * DataForSEO Backlink Summary structure
 */
export interface DataForSEOBacklinkSummary {
  target?: string;
  backlinks?: number;
  referring_domains?: number;
  referring_ips?: number;
  referring_subnets?: number;
  referring_main_domains?: number;
  referring_networks?: number;
  broken_backlinks?: number;
  broken_pages?: number;
  referring_domains_nofollow?: number;
  referring_main_domains_nofollow?: number;
  referring_networks_nofollow?: number;
  referring_subnets_nofollow?: number;
  referring_pages?: number;
  referring_pages_nofollow?: number;
  referring_ips_nofollow?: number;
  deindexed_backlinks?: number;
  deindexed_pages?: number;
}

/**
 * DataForSEO Referring Domain structure
 */
export interface DataForSEOReferringDomain {
  target?: string;
  domain?: string;
  rank?: number;
  backlinks?: number;
  dofollow_backlinks?: number;
  nofollow_backlinks?: number;
  referring_domains?: number;
  referring_main_domains?: number;
  referring_ips?: number;
  first_seen?: string;
  last_seen?: string;
  domain_authority?: number;
  spam_score?: number;
  trust_score?: number;
  citation_flow?: number;
  trust_flow?: number;
}

/**
 * DataForSEO Anchor Text structure
 */
export interface DataForSEOAnchorText {
  anchor?: string;
  rank?: number;
  backlinks?: number;
  referring_domains?: number;
  referring_main_domains?: number;
  referring_ips?: number;
  referring_networks?: number;
  first_seen?: string;
  last_seen?: string;
  anchor_type?: string;
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
    return urlObj.hostname.replace("www.", "");
  } catch (error) {
    // If URL parsing fails, try to extract domain manually
    const cleaned = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
    const domain = cleaned.split("/")[0];
    return domain || url; // Fallback to original URL if split fails
  }
}

/**
 * Fetch backlinks for a target domain/URL from DataForSEO
 * @param target Domain or URL to analyze
 * @param limit Maximum number of backlinks to fetch (default: 1000)
 * @param filters Optional filters
 */
export async function fetchBacklinksFromDataForSEO(
  target: string,
  limit: number = 1000,
  filters?: {
    domain_from?: string;
    domain_from_rank?: number;
    dofollow?: boolean;
    anchor?: string;
  }
): Promise<DataForSEOBacklink[]> {
  try {
    if (!getAuthHeader()) {
      console.warn("⚠️ DataForSEO credentials not configured for backlinks");
      return [];
    }

    console.log(`🔗 Fetching backlinks from DataForSEO for: ${target}`);

    const requestPayload: any = {
      target: target,
      limit: limit,
    };

    // Add filters if provided
    if (filters) {
      if (filters.domain_from) {
        requestPayload.filters = [
          { field: "domain_from", operator: "=", value: filters.domain_from },
        ];
      }
      if (filters.domain_from_rank !== undefined) {
        if (!requestPayload.filters) requestPayload.filters = [];
        requestPayload.filters.push({
          field: "domain_from_rank",
          operator: ">=",
          value: filters.domain_from_rank,
        });
      }
      if (filters.dofollow !== undefined) {
        if (!requestPayload.filters) requestPayload.filters = [];
        requestPayload.filters.push({
          field: "dofollow",
          operator: "=",
          value: filters.dofollow,
        });
      }
      if (filters.anchor) {
        if (!requestPayload.filters) requestPayload.filters = [];
        requestPayload.filters.push({
          field: "anchor",
          operator: "=",
          value: filters.anchor,
        });
      }
    }

    const response = await fetch(
      `${DATAFORSEO_API_URL}/backlinks/backlinks/live`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throwIfBacklinksSubscriptionUnavailable(errorText, response.status);
      console.error(
        `❌ DataForSEO Backlinks API error: ${response.status} - ${errorText}`
      );
      throw new Error(
        `DataForSEO Backlinks API error: ${response.status} - ${errorText}`
      );
    }

    const data = await readDataForSeoResponse(response);
    const taskResult = data.tasks?.[0];

    if (!taskResult || taskResult.status_code !== 20000) {
      throwIfBacklinksSubscriptionUnavailable(
        taskResult?.status_message,
        taskResult?.status_code
      );
      console.error(`❌ DataForSEO Backlinks API error:`, taskResult);
      throw new Error(
        `DataForSEO API error: ${taskResult?.status_message || "Unknown error"}`
      );
    }

    const backlinks: DataForSEOBacklink[] = taskResult.result || [];

    console.log(
      `✅ Fetched ${backlinks.length} backlinks from DataForSEO for ${target}`
    );

    return backlinks;
  } catch (error: any) {
    console.error("❌ Error fetching backlinks from DataForSEO:", error);
    throw error;
  }
}

/**
 * Fetch backlink summary statistics from DataForSEO
 * @param target Domain or URL to analyze
 */
export async function fetchBacklinkSummaryFromDataForSEO(
  target: string
): Promise<DataForSEOBacklinkSummary | null> {
  try {
    if (!getAuthHeader()) {
      console.warn("⚠️ DataForSEO credentials not configured for backlinks");
      return null;
    }

    console.log(`📊 Fetching backlink summary from DataForSEO for: ${target}`);

    const requestPayload = {
      target: target,
    };

    const response = await fetch(
      `${DATAFORSEO_API_URL}/backlinks/summary/live`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throwIfBacklinksSubscriptionUnavailable(errorText, response.status);
      console.error(
        `❌ DataForSEO Backlink Summary API error: ${response.status} - ${errorText}`
      );
      throw new Error(
        `DataForSEO Backlink Summary API error: ${response.status} - ${errorText}`
      );
    }

    const data = await readDataForSeoResponse(response);
    const taskResult = data.tasks?.[0];

    if (!taskResult || taskResult.status_code !== 20000) {
      throwIfBacklinksSubscriptionUnavailable(
        taskResult?.status_message,
        taskResult?.status_code
      );
      console.error(`❌ DataForSEO Backlink Summary API error:`, taskResult);
      return null;
    }

    const summary: DataForSEOBacklinkSummary = taskResult.result?.[0] || null;

    console.log(`✅ Fetched backlink summary from DataForSEO for ${target}`);

    return summary;
  } catch (error: any) {
    console.error("❌ Error fetching backlink summary from DataForSEO:", error);
    return null;
  }
}

/**
 * Fetch referring domains from DataForSEO
 * @param target Domain or URL to analyze
 * @param limit Maximum number of domains to fetch (default: 100)
 */
export async function fetchReferringDomainsFromDataForSEO(
  target: string,
  limit: number = 100
): Promise<DataForSEOReferringDomain[]> {
  try {
    if (!getAuthHeader()) {
      console.warn("⚠️ DataForSEO credentials not configured for backlinks");
      return [];
    }

    console.log(
      `🌐 Fetching referring domains from DataForSEO for: ${target}`
    );

    const requestPayload = {
      target: target,
      limit: limit,
    };

    const response = await fetch(
      `${DATAFORSEO_API_URL}/backlinks/referring_domains/live`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throwIfBacklinksSubscriptionUnavailable(errorText, response.status);
      console.error(
        `❌ DataForSEO Referring Domains API error: ${response.status} - ${errorText}`
      );
      throw new Error(
        `DataForSEO Referring Domains API error: ${response.status} - ${errorText}`
      );
    }

    const data = await readDataForSeoResponse(response);
    const taskResult = data.tasks?.[0];

    if (!taskResult || taskResult.status_code !== 20000) {
      throwIfBacklinksSubscriptionUnavailable(
        taskResult?.status_message,
        taskResult?.status_code
      );
      console.error(`❌ DataForSEO Referring Domains API error:`, taskResult);
      throw new Error(
        `DataForSEO API error: ${taskResult?.status_message || "Unknown error"}`
      );
    }

    const domains: DataForSEOReferringDomain[] = taskResult.result || [];

    console.log(
      `✅ Fetched ${domains.length} referring domains from DataForSEO for ${target}`
    );

    return domains;
  } catch (error: any) {
    console.error(
      "❌ Error fetching referring domains from DataForSEO:",
      error
    );
    throw error;
  }
}

/**
 * Fetch anchor text distribution from DataForSEO
 * @param target Domain or URL to analyze
 * @param limit Maximum number of anchors to fetch (default: 100)
 */
export async function fetchAnchorTextFromDataForSEO(
  target: string,
  limit: number = 100
): Promise<DataForSEOAnchorText[]> {
  try {
    if (!getAuthHeader()) {
      console.warn("⚠️ DataForSEO credentials not configured for backlinks");
      return [];
    }

    console.log(
      `🔤 Fetching anchor text from DataForSEO for: ${target}`
    );

    const requestPayload = {
      target: target,
      limit: limit,
    };

    const response = await fetch(
      `${DATAFORSEO_API_URL}/backlinks/anchor_text/live`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throwIfBacklinksSubscriptionUnavailable(errorText, response.status);
      console.error(
        `❌ DataForSEO Anchor Text API error: ${response.status} - ${errorText}`
      );
      throw new Error(
        `DataForSEO Anchor Text API error: ${response.status} - ${errorText}`
      );
    }

    const data = await readDataForSeoResponse(response);
    const taskResult = data.tasks?.[0];

    if (!taskResult || taskResult.status_code !== 20000) {
      throwIfBacklinksSubscriptionUnavailable(
        taskResult?.status_message,
        taskResult?.status_code
      );
      console.error(`❌ DataForSEO Anchor Text API error:`, taskResult);
      throw new Error(
        `DataForSEO API error: ${taskResult?.status_message || "Unknown error"}`
      );
    }

    const anchors: DataForSEOAnchorText[] = taskResult.result || [];

    console.log(
      `✅ Fetched ${anchors.length} anchor texts from DataForSEO for ${target}`
    );

    return anchors;
  } catch (error: any) {
    console.error("❌ Error fetching anchor text from DataForSEO:", error);
    throw error;
  }
}

/**
 * Get domain rank and authority metrics from DataForSEO
 * @param target Domain to analyze
 */
export async function fetchDomainRankFromDataForSEO(
  target: string
): Promise<{
  rank?: number;
  domain_rank?: number;
  domain_authority?: number;
  spam_score?: number;
  trust_score?: number;
  citation_flow?: number;
  trust_flow?: number;
} | null> {
  try {
    if (!getAuthHeader()) {
      return null; // Silent fail if not configured
    }

    const requestPayload = {
      target: target,
    };

    const response = await fetch(
      `${DATAFORSEO_API_URL}/backlinks/domain_rank/live`,
      {
        method: "POST",
        headers: {
          Authorization: getAuthHeader(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify([requestPayload]),
      }
    );

    if (!response.ok) {
      // Only log if it's not a 404 (endpoint not available in plan)
      if (response.status !== 404) {
        const errorText = await response.text();
        console.error(
          `❌ DataForSEO Domain Rank API error: ${response.status} - ${errorText}`
        );
      }
      // Silent fail for 404 (endpoint not available in plan)
      return null;
    }

    const data = await readDataForSeoResponse(response);
    const taskResult = data.tasks?.[0];

    if (!taskResult || taskResult.status_code !== 20000) {
      // Only log if it's not a "not found" error (40400)
      if (taskResult?.status_code !== 40400) {
        console.error(`❌ DataForSEO Domain Rank API error:`, taskResult);
      }
      // Silent fail for 40400 (endpoint not available)
      return null;
    }

    const result = taskResult.result?.[0] || null;
    return result;
  } catch (error: any) {
    // Silent fail - domain rank is optional
    return null;
  }
}
