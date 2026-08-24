import { prisma } from "../config/db.config";

/**
 * Enhanced keyword tracking service for managing keyword usage and similarity
 */
export class KeywordTrackingService {
  /**
   * Check if a keyword is similar to existing used keywords
   * @param newKeyword - The new keyword to check
   * @param userId - User ID to scope the search
   * @param threshold - Similarity threshold (0-1, default 0.7)
   * @returns Promise<boolean> - true if similar keyword exists
   */
  static async checkKeywordSimilarity(
    newKeyword: string,
    userId: string,
    threshold: number = 0.7,
    businessId?: string // 🆕 Optional: Filter by business
  ): Promise<boolean> {
    try {
      let isPrimary = false;
      let targetBusinessId = businessId;

      if (businessId) {
        // Check if this is the primary business
        const business = await prisma.business.findFirst({
          where: {
            id: businessId,
            userId: userId,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (business) {
          isPrimary = business.isPrimary;
          targetBusinessId = business.id;
        }
      } else {
        // If no businessId, get primary business
        const primaryBusiness = await prisma.business.findFirst({
          where: {
            userId: userId,
            isPrimary: true,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (primaryBusiness) {
          isPrimary = true;
          targetBusinessId = primaryBusiness.id;
        }
      }

      // Build where clause
      const whereClause: any = {
        userId,
        isUsed: true,
        deletedAt: null,
      };

      if (targetBusinessId) {
        if (isPrimary) {
          // Primary business: include its keywords + legacy keywords (null businessId)
          whereClause.OR = [
            { businessId: targetBusinessId },
            { businessId: null }, // Legacy keywords
          ];
        } else {
          // Non-primary business: only show its own keywords (no legacy)
          whereClause.businessId = targetBusinessId;
        }
      } else {
        // No business found, only show legacy keywords
        whereClause.businessId = null;
      }

      // Get all used keywords for the user (and business if specified)
      const usedKeywords = await prisma.plan.findMany({
        where: whereClause,
        select: {
          keyword: true,
        },
      });

      if (usedKeywords.length === 0) {
        return false; // No used keywords, so no similarity
      }

      // Check similarity using multiple methods
      for (const usedKeyword of usedKeywords) {
        const similarity = this.calculateSimilarity(
          newKeyword,
          usedKeyword.keyword
        );
        if (similarity >= threshold) {
          return true;
        }
      }

      return false;
    } catch (error) {
      console.error("Error checking keyword similarity:", error);
      return false; // Default to allowing the keyword if there's an error
    }
  }

  /**
   * Calculate similarity between two keywords using multiple algorithms
   * @param keyword1 - First keyword
   * @param keyword2 - Second keyword
   * @returns Similarity score between 0 and 1
   */
  static calculateSimilarity(keyword1: string, keyword2: string): number {
    const k1 = keyword1.toLowerCase().trim();
    const k2 = keyword2.toLowerCase().trim();

    // Exact match
    if (k1 === k2) return 1.0;

    // Jaccard similarity (word-based)
    const words1 = new Set(k1.split(/\s+/));
    const words2 = new Set(k2.split(/\s+/));
    const intersection = new Set([...words1].filter((x) => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    const jaccardSimilarity = intersection.size / union.size;

    // Levenshtein distance similarity (character-based)
    const levenshteinDistance = this.levenshteinDistance(k1, k2);
    const maxLength = Math.max(k1.length, k2.length);
    const levenshteinSimilarity =
      maxLength === 0 ? 1 : (maxLength - levenshteinDistance) / maxLength;

    // Substring similarity
    const substringSimilarity = this.calculateSubstringSimilarity(k1, k2);

    // Weighted combination of different similarity measures
    const combinedSimilarity =
      jaccardSimilarity * 0.4 +
      levenshteinSimilarity * 0.3 +
      substringSimilarity * 0.3;

    return Math.min(combinedSimilarity, 1.0);
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private static levenshteinDistance(str1: string, str2: string): number {
    // Create a 2D array with proper initialization
    const matrix: number[][] = [];

    // Initialize the matrix
    for (let j = 0; j <= str2.length; j++) {
      matrix[j] = [];
      for (let i = 0; i <= str1.length; i++) {
        matrix[j]![i] = 0;
      }
    }

    // Fill the first row
    for (let i = 0; i <= str1.length; i++) {
      matrix[0]![i] = i;
    }

    // Fill the first column
    for (let j = 0; j <= str2.length; j++) {
      matrix[j]![0] = j;
    }

    // Fill the rest of the matrix
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j]![i] = Math.min(
          matrix[j]![i - 1]! + 1, // deletion
          matrix[j - 1]![i]! + 1, // insertion
          matrix[j - 1]![i - 1]! + indicator // substitution
        );
      }
    }

    return matrix[str2.length]![str1.length]!;
  }

  /**
   * Calculate substring similarity
   */
  private static calculateSubstringSimilarity(
    str1: string,
    str2: string
  ): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    // Check if shorter string is a substring of longer string
    if (longer.includes(shorter)) {
      return shorter.length / longer.length;
    }

    // Check for common substrings
    let maxCommonLength = 0;
    for (let i = 0; i < shorter.length; i++) {
      for (let j = i + 1; j <= shorter.length; j++) {
        const substring = shorter.substring(i, j);
        if (longer.includes(substring) && substring.length > maxCommonLength) {
          maxCommonLength = substring.length;
        }
      }
    }

    return maxCommonLength / longer.length;
  }

  /**
   * Mark a keyword as used
   * @param keywordId - ID of the keyword to mark as used
   * @param blogId - ID of the blog that used the keyword
   */
  static async markKeywordAsUsed(
    keywordId: string,
    blogId: string
  ): Promise<void> {
    try {
      const result = await prisma.plan.updateMany({
        where: { 
          id: keywordId,
          deletedAt: null,
        },
        data: {
          isUsed: true,
          usedAt: new Date(),
          blogId: blogId,
        },
      });

      if (result.count === 0) {
        console.warn(`[KeywordTracking] No Plan found with id: ${keywordId} - skipping mark as used`);
      }
    } catch (error) {
      console.error("Error marking keyword as used:", error);
      throw error;
    }
  }

  /**
   * Get unused keywords for a user
   * @param userId - User ID
   * @param limit - Maximum number of keywords to return
   * @returns Promise<Plan[]> - Array of unused keywords
   */
  static async getUnusedKeywords(
    userId: string,
    limit: number = 50,
    businessId?: string // 🆕 Optional: Filter by business
  ): Promise<any[]> {
    try {
      let isPrimary = false;
      let targetBusinessId = businessId;

      if (businessId) {
        // Check if this is the primary business
        const business = await prisma.business.findFirst({
          where: {
            id: businessId,
            userId: userId,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (business) {
          isPrimary = business.isPrimary;
          targetBusinessId = business.id;
        }
      } else {
        // If no businessId, get primary business
        const primaryBusiness = await prisma.business.findFirst({
          where: {
            userId: userId,
            isPrimary: true,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (primaryBusiness) {
          isPrimary = true;
          targetBusinessId = primaryBusiness.id;
        }
      }

      // Build where clause
      const whereClause: any = {
        userId,
        isUsed: false,
        deletedAt: null,
      };

      if (targetBusinessId) {
        if (isPrimary) {
          // Primary business: include its keywords + legacy keywords (null businessId)
          whereClause.OR = [
            { businessId: targetBusinessId },
            { businessId: null }, // Legacy keywords
          ];
        } else {
          // Non-primary business: only show its own keywords (no legacy)
          whereClause.businessId = targetBusinessId;
        }
      } else {
        // No business found, only show legacy keywords
        whereClause.businessId = null;
      }

      return await prisma.plan.findMany({
        where: whereClause,
        orderBy: {
          publishDate: "asc",
        },
        take: limit,
      });
    } catch (error) {
      console.error("Error getting unused keywords:", error);
      throw error;
    }
  }

  /**
   * Get used keywords for a user
   * @param userId - User ID
   * @param limit - Maximum number of keywords to return
   * @returns Promise<Plan[]> - Array of used keywords
   */
  static async getUsedKeywords(
    userId: string,
    limit: number = 50,
    businessId?: string // 🆕 Optional: Filter by business
  ): Promise<any[]> {
    try {
      let isPrimary = false;
      let targetBusinessId = businessId;

      if (businessId) {
        // Check if this is the primary business
        const business = await prisma.business.findFirst({
          where: {
            id: businessId,
            userId: userId,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (business) {
          isPrimary = business.isPrimary;
          targetBusinessId = business.id;
        }
      } else {
        // If no businessId, get primary business
        const primaryBusiness = await prisma.business.findFirst({
          where: {
            userId: userId,
            isPrimary: true,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (primaryBusiness) {
          isPrimary = true;
          targetBusinessId = primaryBusiness.id;
        }
      }

      // Build where clause
      const whereClause: any = {
        userId,
        isUsed: true,
        deletedAt: null,
      };

      if (targetBusinessId) {
        if (isPrimary) {
          // Primary business: include its keywords + legacy keywords (null businessId)
          whereClause.OR = [
            { businessId: targetBusinessId },
            { businessId: null }, // Legacy keywords
          ];
        } else {
          // Non-primary business: only show its own keywords (no legacy)
          whereClause.businessId = targetBusinessId;
        }
      } else {
        // No business found, only show legacy keywords
        whereClause.businessId = null;
      }

      return await prisma.plan.findMany({
        where: whereClause,
        orderBy: {
          usedAt: "desc",
        },
        take: limit,
      });
    } catch (error) {
      console.error("Error getting used keywords:", error);
      throw error;
    }
  }

  /**
   * Filter out similar keywords from a list
   * @param keywords - Array of keywords to filter
   * @param userId - User ID to check against existing keywords
   * @param threshold - Similarity threshold
   * @returns Promise<string[]> - Array of unique keywords
   */
  static async filterSimilarKeywords(
    keywords: string[],
    userId: string,
    threshold: number = 0.7,
    businessId?: string // 🆕 Optional: Filter by business
  ): Promise<string[]> {
    const uniqueKeywords: string[] = [];

    for (const keyword of keywords) {
      const isSimilar = await this.checkKeywordSimilarity(
        keyword,
        userId,
        threshold,
        businessId
      );
      if (!isSimilar) {
        uniqueKeywords.push(keyword);
      }
    }

    return uniqueKeywords;
  }

  /**
   * Get keyword analytics for a user
   * @param userId - User ID
   * @returns Promise<object> - Keyword analytics
   */
  static async getKeywordAnalytics(
    userId: string,
    businessId?: string // 🆕 Optional: Filter by business
  ): Promise<{
    totalKeywords: number;
    usedKeywords: number;
    unusedKeywords: number;
    usageRate: number;
    recentUsedKeywords: any[];
    upcomingKeywords: any[];
  }> {
    try {
      let isPrimary = false;
      let targetBusinessId = businessId;

      if (businessId) {
        // Check if this is the primary business
        const business = await prisma.business.findFirst({
          where: {
            id: businessId,
            userId: userId,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (business) {
          isPrimary = business.isPrimary;
          targetBusinessId = business.id;
        }
      } else {
        // If no businessId, get primary business
        const primaryBusiness = await prisma.business.findFirst({
          where: {
            userId: userId,
            isPrimary: true,
            isActive: true,
          },
          select: { id: true, isPrimary: true },
        });

        if (primaryBusiness) {
          isPrimary = true;
          targetBusinessId = primaryBusiness.id;
        }
      }

      // Build where clauses
      const baseWhere: any = { userId, deletedAt: null };
      const usedWhere: any = { userId, isUsed: true, deletedAt: null };
      const unusedWhere: any = { userId, isUsed: false, deletedAt: null };

      if (targetBusinessId) {
        if (isPrimary) {
          // Primary business: include its keywords + legacy keywords (null businessId)
          baseWhere.OR = [
            { businessId: targetBusinessId },
            { businessId: null }, // Legacy keywords
          ];
          usedWhere.OR = [
            { businessId: targetBusinessId },
            { businessId: null }, // Legacy keywords
          ];
          unusedWhere.OR = [
            { businessId: targetBusinessId },
            { businessId: null }, // Legacy keywords
          ];
        } else {
          // Non-primary business: only show its own keywords (no legacy)
          baseWhere.businessId = targetBusinessId;
          usedWhere.businessId = targetBusinessId;
          unusedWhere.businessId = targetBusinessId;
        }
      } else {
        // No business found, only show legacy keywords
        baseWhere.businessId = null;
        usedWhere.businessId = null;
        unusedWhere.businessId = null;
      }

      const [
        totalKeywords,
        usedKeywords,
        unusedKeywords,
        recentUsed,
        upcoming,
      ] = await Promise.all([
        prisma.plan.count({
          where: baseWhere,
        }),
        prisma.plan.count({
          where: usedWhere,
        }),
        prisma.plan.count({
          where: unusedWhere,
        }),
        prisma.plan.findMany({
          where: usedWhere,
          orderBy: { usedAt: "desc" },
          take: 10,
        }),
        prisma.plan.findMany({
          where: unusedWhere,
          orderBy: { publishDate: "asc" },
          take: 10,
        }),
      ]);

      const usageRate =
        totalKeywords > 0 ? (usedKeywords / totalKeywords) * 100 : 0;

      return {
        totalKeywords,
        usedKeywords,
        unusedKeywords,
        usageRate: Math.round(usageRate * 100) / 100,
        recentUsedKeywords: recentUsed,
        upcomingKeywords: upcoming,
      };
    } catch (error) {
      console.error("Error getting keyword analytics:", error);
      throw error;
    }
  }

  /**
   * Categorize a keyword based on its content
   * @param keyword - The keyword to categorize
   * @returns Object with category and intent
   */
  static categorizeKeyword(keyword: string): {
    category: string;
    intent: string;
  } {
    const lowerKeyword = keyword.toLowerCase();

    // Category detection
    let category = "general";
    if (
      lowerKeyword.includes("how to") ||
      lowerKeyword.includes("what is") ||
      lowerKeyword.includes("guide")
    ) {
      category = "informational";
    } else if (
      lowerKeyword.includes("best") ||
      lowerKeyword.includes("top") ||
      lowerKeyword.includes("review")
    ) {
      category = "commercial";
    } else if (
      lowerKeyword.includes("near me") ||
      lowerKeyword.includes("in ") ||
      lowerKeyword.includes("local")
    ) {
      category = "local";
    } else if (
      lowerKeyword.includes("buy") ||
      lowerKeyword.includes("price") ||
      lowerKeyword.includes("cost")
    ) {
      category = "transactional";
    }

    // Intent detection
    let intent = "informational";
    if (
      lowerKeyword.includes("buy") ||
      lowerKeyword.includes("purchase") ||
      lowerKeyword.includes("order")
    ) {
      intent = "transactional";
    } else if (
      lowerKeyword.includes("near me") ||
      lowerKeyword.includes("location") ||
      lowerKeyword.includes("address")
    ) {
      intent = "navigational";
    } else if (
      lowerKeyword.includes("best") ||
      lowerKeyword.includes("compare") ||
      lowerKeyword.includes("vs")
    ) {
      intent = "commercial";
    }

    return { category, intent };
  }
}
