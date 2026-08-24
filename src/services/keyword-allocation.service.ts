import { prisma } from "../config/db.config";

/**
 * Service for managing platform-wide keyword allocation
 * Prevents keyword cannibalization across businesses on the platform
 */
export class KeywordAllocationService {
  /**
   * Normalize keyword for comparison (lowercase, trim, remove extra spaces)
   */
  private normalizeKeyword(keyword: string): string {
    return keyword.toLowerCase().trim().replace(/\s+/g, " ");
  }

  /**
   * Extract industry ID from business type
   */
  extractIndustryId(businessType: string): string {
    const typeLower = businessType.toLowerCase();
    
    // Common industry mappings
    if (typeLower.includes("restaurant") || typeLower.includes("food") || typeLower.includes("catering")) {
      return "restaurant";
    }
    if (typeLower.includes("plumbing")) {
      return "plumbing";
    }
    if (typeLower.includes("web") || typeLower.includes("development") || typeLower.includes("software")) {
      return "web-development";
    }
    if (typeLower.includes("event") || typeLower.includes("venue")) {
      return "event-planning";
    }
    if (typeLower.includes("dental") || typeLower.includes("dentist")) {
      return "dental";
    }
    if (typeLower.includes("law") || typeLower.includes("legal") || typeLower.includes("attorney")) {
      return "legal";
    }
    if (typeLower.includes("construction") || typeLower.includes("contractor")) {
      return "construction";
    }
    
    // Default: use first word of business type
    return typeLower.split(/[\s,]+/)[0] || "general";
  }

  /**
   * Get location scope from business location
   */
  getLocationScope(city?: string | null, country?: string | null): string {
    if (city) {
      return city.toLowerCase().trim();
    }
    if (country) {
      return country.toLowerCase().trim();
    }
    return "global";
  }

  /**
   * Check if a keyword is available for allocation
   */
  async isKeywordAvailable(
    keyword: string,
    businessId: string,
    locationScope: string,
    industryId: string
  ): Promise<{ available: boolean; reason?: string; allocatedTo?: string }> {
    const normalizedKey = this.normalizeKeyword(keyword);

    const existing = await prisma.platformKeywordAllocation.findUnique({
      where: {
        normalizedKey_locationScope: {
          normalizedKey,
          locationScope,
        },
      },
      include: {
        business: {
          select: {
            id: true,
            businessName: true,
          },
        },
      },
    });

    if (!existing) {
      return { available: true };
    }

    // Check if expired
    if (existing.expiresAt && existing.expiresAt < new Date()) {
      return { available: true };
    }

    // Check if status is active
    if (existing.status !== "active") {
      return { available: true };
    }

    // If it's the same business, it's available (they can reallocate)
    if (existing.businessId === businessId) {
      return { available: true };
    }

    return {
      available: false,
      reason: `Keyword already allocated to ${existing.business.businessName}`,
      allocatedTo: existing.businessId,
    };
  }

  /**
   * Allocate a keyword to a business
   */
  async allocateKeyword(
    keyword: string,
    businessId: string,
    userId: string,
    businessType: string,
    locationScope: string,
    searchVolume?: number,
    difficulty?: number,
    priority: number = 1,
    expiresAt?: Date
  ): Promise<{ success: boolean; allocationId?: string; error?: string }> {
    try {
      const normalizedKey = this.normalizeKeyword(keyword);
      const industryId = this.extractIndustryId(businessType);

      // Check availability first
      const availability = await this.isKeywordAvailable(
        keyword,
        businessId,
        locationScope,
        industryId
      );

      if (!availability.available) {
        return {
          success: false,
          error: availability.reason || "Keyword not available",
        };
      }

      // Create or update allocation
      const allocation = await prisma.platformKeywordAllocation.upsert({
        where: {
          normalizedKey_locationScope: {
            normalizedKey,
            locationScope,
          },
        },
        update: {
          businessId,
          userId,
          priority,
          searchVolume,
          difficulty,
          expiresAt,
          status: "active",
          updatedAt: new Date(),
        },
        create: {
          keyword,
          normalizedKey,
          industryId,
          locationScope,
          businessId,
          userId,
          priority,
          searchVolume,
          difficulty,
          expiresAt,
          status: "active",
        },
      });

      return {
        success: true,
        allocationId: allocation.id,
      };
    } catch (error: any) {
      console.error("Error allocating keyword:", error);
      return {
        success: false,
        error: error.message || "Failed to allocate keyword",
      };
    }
  }

  /**
   * Find alternative keywords for a taken keyword
   */
  async findAlternatives(
    keyword: string,
    industryId: string,
    limit: number = 10
  ): Promise<Array<{ keyword: string; similarityScore: number }>> {
    const normalizedKey = this.normalizeKeyword(keyword);

    // Check if alternatives exist in database
    const alternatives = await prisma.keywordAlternative.findMany({
      where: {
        primaryKeyword: normalizedKey,
        industryId,
      },
      orderBy: {
        similarityScore: "desc",
      },
      take: limit,
    });

    if (alternatives.length > 0) {
      return alternatives.map((alt) => ({
        keyword: alt.alternativeKeyword,
        similarityScore: alt.similarityScore,
      }));
    }

    // If no alternatives in DB, return empty (can be enhanced with LLM or DataForSEO)
    return [];
  }

  /**
   * Get all keywords allocated to a business
   */
  async getBusinessKeywords(businessId: string): Promise<string[]> {
    const allocations = await prisma.platformKeywordAllocation.findMany({
      where: {
        businessId,
        status: "active",
      },
      select: {
        keyword: true,
      },
    });

    return allocations.map((a) => a.keyword);
  }

  /**
   * Get platform businesses in the same location/industry
   */
  async getPlatformBusinessesInScope(
    locationScope: string,
    industryId: string,
    excludeBusinessId: string
  ): Promise<Array<{ id: string; businessName: string; domain: string }>> {
    const allocations = await prisma.platformKeywordAllocation.findMany({
      where: {
        locationScope,
        industryId,
        businessId: { not: excludeBusinessId },
        status: "active",
      },
      include: {
        business: {
          select: {
            id: true,
            businessName: true,
            businessWebsiteUrl: true,
          },
        },
      },
      distinct: ["businessId"],
    });

    return allocations.map((a) => {
      const raw = a.business.businessWebsiteUrl ?? "";
      const domain = raw
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .split("/")[0];
      return {
        id: a.business.id,
        businessName: a.business.businessName,
        domain: domain ?? "",
      };
    });
  }

  /**
   * Release a keyword allocation (mark as released)
   */
  async releaseKeyword(
    keyword: string,
    businessId: string,
    locationScope: string
  ): Promise<boolean> {
    try {
      const normalizedKey = this.normalizeKeyword(keyword);

      await prisma.platformKeywordAllocation.updateMany({
        where: {
          normalizedKey,
          locationScope,
          businessId,
          status: "active",
        },
        data: {
          status: "released",
          updatedAt: new Date(),
        },
      });

      return true;
    } catch (error) {
      console.error("Error releasing keyword:", error);
      return false;
    }
  }

  /**
   * Batch check keyword availability
   */
  async checkMultipleKeywords(
    keywords: string[],
    businessId: string,
    locationScope: string,
    industryId: string
  ): Promise<Map<string, { available: boolean; reason?: string }>> {
    const results = new Map<string, { available: boolean; reason?: string }>();

    // Check all keywords in parallel
    const checks = keywords.map(async (keyword) => {
      const availability = await this.isKeywordAvailable(
        keyword,
        businessId,
        locationScope,
        industryId
      );
      return { keyword, ...availability };
    });

    const checked = await Promise.all(checks);

    for (const result of checked) {
      results.set(result.keyword, {
        available: result.available,
        reason: result.reason,
      });
    }

    return results;
  }
}

