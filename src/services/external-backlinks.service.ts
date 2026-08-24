import { prisma } from "../config/db.config";
import {
  fetchBacklinksFromDataForSEO,
  fetchBacklinkSummaryFromDataForSEO,
  fetchReferringDomainsFromDataForSEO,
  fetchAnchorTextFromDataForSEO,
  fetchDomainRankFromDataForSEO,
  type DataForSEOBacklink,
  type DataForSEOBacklinkSummary,
  type DataForSEOReferringDomain,
  type DataForSEOAnchorText,
} from "../utils/dataforseo-backlinks.utils";
import {
  isSourceAvailabilityError,
  type SourceAvailabilityError,
} from "../utils/source-availability.errors";

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url.startsWith("http") ? url : `https://${url}`);
    return urlObj.hostname.replace("www.", "");
  } catch (error) {
    const cleaned = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
    const domain = cleaned.split("/")[0];
    return domain || url; // Fallback to original URL if split fails
  }
}

/**
 * Determine anchor type based on anchor text
 */
function determineAnchorType(anchorText: string): string {
  if (!anchorText) return "generic";
  const lower = anchorText.toLowerCase();
  if (lower.includes("click here") || lower.includes("read more")) {
    return "generic";
  }
  if (lower.includes("www.") || lower.includes("http")) {
    return "branded";
  }
  return "exact";
}

/**
 * Determine link type from DataForSEO flags
 */
function determineLinkType(backlink: DataForSEOBacklink): string {
  if (backlink.sponsored) return "sponsored";
  if (backlink.ugc) return "ugc";
  if (backlink.dofollow) return "dofollow";
  if (backlink.nofollow) return "nofollow";
  return "dofollow"; // Default
}

function isBacklinksUnavailableError(
  error: unknown
): error is SourceAvailabilityError {
  return (
    isSourceAvailabilityError(error) &&
    error.code === "DATAFORSEO_BACKLINKS_UNAVAILABLE"
  );
}

/**
 * Service for managing external backlinks from DataForSEO
 */
export class ExternalBacklinksService {
  /**
   * Sync all backlink data for a business
   */
  async syncBacklinksForBusiness(
    businessId: string,
    targetDomain: string
  ): Promise<{
    success: boolean;
    backlinksCount: number;
    referringDomainsCount: number;
    anchorsCount: number;
    summary?: any;
    error?: string;
  }> {
    try {
      console.log(
        `🔄 Starting backlink sync for business ${businessId}, target: ${targetDomain}`
      );

      // Update summary status to syncing
      await prisma.externalBacklinkSummary.upsert({
        where: { businessId },
        create: {
          businessId,
          syncStatus: "syncing",
        },
        update: {
          syncStatus: "syncing",
          syncError: null,
        },
      });

      // Extract clean domain
      const cleanDomain = extractDomain(targetDomain);
      const targetUrl = targetDomain.startsWith("http")
        ? targetDomain
        : `https://${targetDomain}`;

      let summary: DataForSEOBacklinkSummary | null = null;
      try {
        summary = await fetchBacklinkSummaryFromDataForSEO(targetUrl);
      } catch (error) {
        if (isBacklinksUnavailableError(error)) {
          const unavailableMessage = error.userMessage;

          await prisma.externalBacklinkSummary.update({
            where: { businessId },
            data: {
              syncStatus: "unavailable",
              syncError: unavailableMessage,
              lastSyncedAt: new Date(),
            },
          });

          return {
            success: false,
            backlinksCount: 0,
            referringDomainsCount: 0,
            anchorsCount: 0,
            error: unavailableMessage,
          };
        }

        console.error("Error fetching summary:", error);
      }

      await new Promise(resolve => setTimeout(resolve, 1000)); // 1 sec delay

      let backlinks: DataForSEOBacklink[] = [];
      try {
        backlinks = await fetchBacklinksFromDataForSEO(targetUrl, 1000);
      } catch (error) {
        if (isBacklinksUnavailableError(error)) {
          const unavailableMessage = error.userMessage;

          await prisma.externalBacklinkSummary.update({
            where: { businessId },
            data: {
              syncStatus: "unavailable",
              syncError: unavailableMessage,
              lastSyncedAt: new Date(),
            },
          });

          return {
            success: false,
            backlinksCount: 0,
            referringDomainsCount: 0,
            anchorsCount: 0,
            error: unavailableMessage,
          };
        }

        console.error("Error fetching backlinks:", error);
      }

      await new Promise(resolve => setTimeout(resolve, 1000)); // 1 sec delay

      let referringDomains: DataForSEOReferringDomain[] = [];
      try {
        referringDomains = await fetchReferringDomainsFromDataForSEO(targetUrl, 100);
      } catch (error) {
        if (isBacklinksUnavailableError(error)) {
          const unavailableMessage = error.userMessage;

          await prisma.externalBacklinkSummary.update({
            where: { businessId },
            data: {
              syncStatus: "unavailable",
              syncError: unavailableMessage,
              lastSyncedAt: new Date(),
            },
          });

          return {
            success: false,
            backlinksCount: 0,
            referringDomainsCount: 0,
            anchorsCount: 0,
            error: unavailableMessage,
          };
        }

        console.error("Error fetching referring domains:", error);
      }

      await new Promise(resolve => setTimeout(resolve, 1000)); // 1 sec delay

      let anchorTexts: DataForSEOAnchorText[] = [];
      try {
        anchorTexts = await fetchAnchorTextFromDataForSEO(targetUrl, 100);
      } catch (error) {
        if (isBacklinksUnavailableError(error)) {
          const unavailableMessage = error.userMessage;

          await prisma.externalBacklinkSummary.update({
            where: { businessId },
            data: {
              syncStatus: "unavailable",
              syncError: unavailableMessage,
              lastSyncedAt: new Date(),
            },
          });

          return {
            success: false,
            backlinksCount: 0,
            referringDomainsCount: 0,
            anchorsCount: 0,
            error: unavailableMessage,
          };
        }

        console.error("Error fetching anchor texts:", error);
      }

      // Upsert backlinks
      const backlinksCount = await this.upsertBacklinks(
        businessId,
        backlinks,
        targetUrl,
        cleanDomain
      );

      // Upsert referring domains
      const referringDomainsCount = await this.upsertReferringDomains(
        businessId,
        referringDomains
      );

      // Upsert anchor texts
      const anchorsCount = await this.upsertAnchorTexts(
        businessId,
        anchorTexts
      );

      // Update summary
      if (summary) {
        await this.updateSummary(businessId, summary, backlinks);
      }

      // Mark lost backlinks
      // Separate IDs and URLs for proper comparison
      const activeBacklinkIdSet = new Set(
        backlinks
          .map(b => b.backlink_rank?.toString())
          .filter(Boolean) as string[]
      );

      const activeSourceUrlSet = new Set(
        backlinks
          .map(b => b.url_from)
          .filter(Boolean) as string[]
      );

      await this.markLostBacklinks(businessId, {
        backlinkIds: Array.from(activeBacklinkIdSet),
        sourceUrls: Array.from(activeSourceUrlSet),
      });

      // Calculate growth metrics
      await this.calculateGrowthMetrics(businessId);

      // Update summary status to completed
      await prisma.externalBacklinkSummary.update({
        where: { businessId },
        data: {
          syncStatus: "completed",
          lastSyncedAt: new Date(),
          syncError: null,
        },
      });

      console.log(
        `✅ Backlink sync completed for business ${businessId}: ${backlinksCount} backlinks, ${referringDomainsCount} domains, ${anchorsCount} anchors`
      );

      return {
        success: true,
        backlinksCount,
        referringDomainsCount,
        anchorsCount,
        summary,
      };
    } catch (error: any) {
      console.error(
        `❌ Error syncing backlinks for business ${businessId}:`,
        error
      );

      // Update summary status to failed
      await prisma.externalBacklinkSummary
        .update({
          where: { businessId },
          data: {
            syncStatus: "failed",
            syncError: error.message || "Unknown error",
          },
        })
        .catch(() => {
          // Ignore if summary doesn't exist
        });

      return {
        success: false,
        backlinksCount: 0,
        referringDomainsCount: 0,
        anchorsCount: 0,
        error: error.message || "Unknown error",
      };
    }
  }

  /**
   * Update or create backlink records
   */
  private async upsertBacklinks(
    businessId: string,
    backlinks: DataForSEOBacklink[],
    targetUrl: string,
    targetDomain: string
  ): Promise<number> {
    let createdCount = 0;
    let updatedCount = 0;

    for (const backlink of backlinks) {
      if (!backlink.url_from || !backlink.url_to) {
        continue; // Skip invalid backlinks
      }

      const sourceDomain = extractDomain(backlink.domain_from || backlink.url_from);
      const anchorText = backlink.anchor || null;
      const linkType = determineLinkType(backlink);
      const anchorType = anchorText ? determineAnchorType(anchorText) : null;

      // Parse dates
      const firstSeen = backlink.first_seen
        ? new Date(backlink.first_seen)
        : null;
      const lastSeen = backlink.last_seen
        ? new Date(backlink.last_seen)
        : null;

      // Check if backlink already exists
      const existing = await prisma.externalBacklink.findUnique({
        where: {
          businessId_sourceUrl_targetUrl: {
            businessId,
            sourceUrl: backlink.url_from,
            targetUrl: backlink.url_to || targetUrl,
          },
        },
      });

      if (existing) {
        // Update existing
        await prisma.externalBacklink.update({
          where: { id: existing.id },
          data: {
            sourceDomain,
            sourceDomainRank: backlink.domain_from_rank || null,
            sourceDomainType: backlink.domain_from_type || null,
            anchorText,
            anchorType,
            linkType,
            domainAuthority: backlink.domain_from_authority || null,
            pageAuthority: backlink.page_from_authority || null,
            spamScore: backlink.backlink_spam_score || backlink.rank_spam_score || null,
            trustScore: backlink.trust_score || null,
            citationFlow: backlink.citation_flow || null,
            trustFlow: backlink.trust_flow || null,
            lastSeen: lastSeen || new Date(),
            lastSyncedAt: new Date(),
            isLost: false,
            status: existing.status === "lost" ? "active" : existing.status,
          },
        });
        updatedCount++;
      } else {
        // Create new
        await prisma.externalBacklink.create({
          data: {
            businessId,
            targetUrl: backlink.url_to || targetUrl,
            targetDomain,
            sourceUrl: backlink.url_from,
            sourceDomain,
            sourceDomainRank: backlink.domain_from_rank || null,
            sourceDomainType: backlink.domain_from_type || null,
            anchorText,
            anchorType,
            linkType,
            domainAuthority: backlink.domain_from_authority || null,
            pageAuthority: backlink.page_from_authority || null,
            spamScore: backlink.backlink_spam_score || backlink.rank_spam_score || null,
            trustScore: backlink.trust_score || null,
            citationFlow: backlink.citation_flow || null,
            trustFlow: backlink.trust_flow || null,
            backlinkId: backlink.backlink_rank?.toString() || null,
            firstSeen: firstSeen || new Date(),
            lastSeen: lastSeen || new Date(),
            status: "new",
            lastSyncedAt: new Date(),
          },
        });
        createdCount++;
      }
    }

    console.log(
      `📝 Processed ${backlinks.length} backlinks: ${createdCount} created, ${updatedCount} updated`
    );

    return backlinks.length;
  }

  /**
   * Update or create referring domain records
   */
  private async upsertReferringDomains(
    businessId: string,
    domains: DataForSEOReferringDomain[]
  ): Promise<number> {
    let count = 0;

    for (const domain of domains) {
      if (!domain.domain) {
        continue;
      }

      const firstSeen = domain.first_seen ? new Date(domain.first_seen) : null;
      const lastSeen = domain.last_seen ? new Date(domain.last_seen) : null;

      await prisma.externalReferringDomain.upsert({
        where: {
          businessId_domain: {
            businessId,
            domain: domain.domain,
          },
        },
        create: {
          businessId,
          domain: domain.domain,
          domainAuthority: domain.domain_authority || null,
          domainRank: domain.rank || null,
          totalBacklinks: domain.backlinks || 0,
          dofollowBacklinks: domain.dofollow_backlinks || 0,
          nofollowBacklinks: domain.nofollow_backlinks || 0,
          spamScore: domain.spam_score || null,
          trustScore: domain.trust_score || null,
          citationFlow: domain.citation_flow || null,
          trustFlow: domain.trust_flow || null,
          firstSeen: firstSeen || new Date(),
          lastSeen: lastSeen || new Date(),
          domainId: domain.domain, // Use domain as ID for now
        },
        update: {
          domainAuthority: domain.domain_authority || null,
          domainRank: domain.rank || null,
          totalBacklinks: domain.backlinks || 0,
          dofollowBacklinks: domain.dofollow_backlinks || 0,
          nofollowBacklinks: domain.nofollow_backlinks || 0,
          spamScore: domain.spam_score || null,
          trustScore: domain.trust_score || null,
          citationFlow: domain.citation_flow || null,
          trustFlow: domain.trust_flow || null,
          lastSeen: lastSeen || new Date(),
        },
      });

      count++;
    }

    return count;
  }

  /**
   * Update or create anchor text records
   */
  private async upsertAnchorTexts(
    businessId: string,
    anchors: DataForSEOAnchorText[]
  ): Promise<number> {
    let count = 0;

    for (const anchor of anchors) {
      if (!anchor.anchor) {
        continue;
      }

      await prisma.externalBacklinkAnchor.upsert({
        where: {
          businessId_anchorText: {
            businessId,
            anchorText: anchor.anchor,
          },
        },
        create: {
          businessId,
          anchorText: anchor.anchor,
          anchorType: anchor.anchor_type || determineAnchorType(anchor.anchor),
          occurrenceCount: anchor.backlinks || 0,
          referringDomainsCount: anchor.referring_domains || 0,
        },
        update: {
          occurrenceCount: anchor.backlinks || 0,
          referringDomainsCount: anchor.referring_domains || 0,
        },
      });

      count++;
    }

    return count;
  }

  /**
   * Update backlink summary
   */
  private async updateSummary(
    businessId: string,
    summary: DataForSEOBacklinkSummary,
    backlinks: DataForSEOBacklink[]
  ): Promise<void> {
    // Calculate averages from backlinks
    const domainAuths = backlinks
      .map((b) => b.domain_from_authority)
      .filter((v): v is number => v !== undefined && v !== null);
    const pageAuths = backlinks
      .map((b) => b.page_from_authority)
      .filter((v): v is number => v !== undefined && v !== null);
    const spamScores = backlinks
      .map((b) => b.backlink_spam_score || b.rank_spam_score)
      .filter((v): v is number => v !== undefined && v !== null);

    const avgDomainAuthority =
      domainAuths.length > 0
        ? domainAuths.reduce((a, b) => a + b, 0) / domainAuths.length
        : null;
    const avgPageAuthority =
      pageAuths.length > 0
        ? pageAuths.reduce((a, b) => a + b, 0) / pageAuths.length
        : null;
    const avgSpamScore =
      spamScores.length > 0
        ? spamScores.reduce((a, b) => a + b, 0) / spamScores.length
        : null;

    // Count link types
    const dofollowCount = backlinks.filter((b) => b.dofollow).length;
    const nofollowCount = backlinks.filter((b) => b.nofollow).length;
    const sponsoredCount = backlinks.filter((b) => b.sponsored).length;
    const ugcCount = backlinks.filter((b) => b.ugc).length;

    await prisma.externalBacklinkSummary.upsert({
      where: { businessId },
      create: {
        businessId,
        totalBacklinks: summary.backlinks || backlinks.length,
        totalReferringDomains: summary.referring_domains || 0,
        totalReferringIps: summary.referring_ips || 0,
        dofollowBacklinks: dofollowCount,
        nofollowBacklinks: nofollowCount,
        sponsoredBacklinks: sponsoredCount,
        ugcBacklinks: ugcCount,
        averageDomainAuthority: avgDomainAuthority,
        averagePageAuthority: avgPageAuthority,
        averageSpamScore: avgSpamScore,
        lastSyncedAt: new Date(),
      },
      update: {
        totalBacklinks: summary.backlinks || backlinks.length,
        totalReferringDomains: summary.referring_domains || 0,
        totalReferringIps: summary.referring_ips || 0,
        dofollowBacklinks: dofollowCount,
        nofollowBacklinks: nofollowCount,
        sponsoredBacklinks: sponsoredCount,
        ugcBacklinks: ugcCount,
        averageDomainAuthority: avgDomainAuthority,
        averagePageAuthority: avgPageAuthority,
        averageSpamScore: avgSpamScore,
        lastSyncedAt: new Date(),
      },
    });
  }

  /**
   * Detect lost backlinks (present in DB but not in API response)
   */
  private async markLostBacklinks(
    businessId: string,
    activeData: { backlinkIds: string[]; sourceUrls: string[] }
  ): Promise<number> {
    // Find backlinks that weren't seen in this sync
    const lostBacklinks = await prisma.externalBacklink.findMany({
      where: {
        businessId,
        isLost: false,
        status: "active",
        AND: [
          {
            OR: [
              { backlinkId: null },
              { backlinkId: { notIn: activeData.backlinkIds } }
            ]
          },
          { sourceUrl: { notIn: activeData.sourceUrls } }
        ],
      },
    });

    if (lostBacklinks.length > 0) {
      await prisma.externalBacklink.updateMany({
        where: {
          id: {
            in: lostBacklinks.map((b) => b.id),
          },
        },
        data: {
          isLost: true,
          status: "lost",
          lostAt: new Date(),
        },
      });

      console.log(`⚠️ Marked ${lostBacklinks.length} backlinks as lost`);
    }

    return lostBacklinks.length;
  }

  /**
   * Calculate growth metrics
   */
  private async calculateGrowthMetrics(businessId: string): Promise<void> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Count new backlinks this month
    const newBacklinks = await prisma.externalBacklink.count({
      where: {
        businessId,
        createdAt: {
          gte: startOfMonth,
        },
        status: {
          not: "lost",
        },
      },
    });

    // Count lost backlinks this month
    const lostBacklinks = await prisma.externalBacklink.count({
      where: {
        businessId,
        lostAt: {
          gte: startOfMonth,
        },
        isLost: true,
      },
    });

    // Get total backlinks
    const totalBacklinks = await prisma.externalBacklink.count({
      where: {
        businessId,
        isLost: false,
      },
    });

    // Calculate growth rate
    const previousTotal = totalBacklinks - newBacklinks + lostBacklinks;
    const growthRate =
      previousTotal > 0
        ? ((newBacklinks - lostBacklinks) / previousTotal) * 100
        : 0;

    // Update summary
    await prisma.externalBacklinkSummary.update({
      where: { businessId },
      data: {
        newBacklinksThisMonth: newBacklinks,
        lostBacklinksThisMonth: lostBacklinks,
        growthRate,
      },
    });
  }
}
