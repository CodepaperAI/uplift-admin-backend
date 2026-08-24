import { prisma } from "../config/db.config";

export class TrialAnalyticsService {
  static async trackOnboardingStarted(userId: string) {
    try {
      await prisma.trialAnalytics.upsert({
        where: { userId },
        create: {
          userId,
          onboardingStartedAt: new Date(),
        },
        update: {},
      });
      console.log(`✅ Tracked onboarding started for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track onboarding started:`, error);
    }
  }

  static async trackQuickScrapeCompleted(userId: string) {
    try {
      await prisma.trialAnalytics.upsert({
        where: { userId },
        create: {
          userId,
          quickScrapeCompletedAt: new Date(),
        },
        update: {
          quickScrapeCompletedAt: new Date(),
        },
      });
      console.log(`✅ Tracked quick scrape completed for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track quick scrape:`, error);
    }
  }

  static async trackServicesSelected(userId: string) {
    try {
      await prisma.trialAnalytics.upsert({
        where: { userId },
        create: {
          userId,
          servicesSelectedAt: new Date(),
        },
        update: {
          servicesSelectedAt: new Date(),
        },
      });
      console.log(`✅ Tracked services selected for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track services selected:`, error);
    }
  }

  static async trackTrialEnrolled(userId: string, abTestVariant?: string, abTestGroup?: string) {
    try {
      await prisma.trialAnalytics.upsert({
        where: { userId },
        create: {
          userId,
          trialEnrolledAt: new Date(),
          abTestVariant,
          abTestGroup,
        },
        update: {
          trialEnrolledAt: new Date(),
          abTestVariant,
          abTestGroup,
        },
      });
      console.log(`✅ Tracked trial enrolled for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track trial enrolled:`, error);
    }
  }

  static async trackOnboardingCompleted(userId: string) {
    try {
      await prisma.trialAnalytics.upsert({
        where: { userId },
        create: {
          userId,
          onboardingCompletedAt: new Date(),
        },
        update: {
          onboardingCompletedAt: new Date(),
        },
      });
      console.log(`✅ Tracked onboarding completed for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track onboarding completed:`, error);
    }
  }

  static async trackLogin(userId: string) {
    try {
      const analytics = await prisma.trialAnalytics.findUnique({
        where: { userId },
      });

      await prisma.trialAnalytics.upsert({
        where: { userId },
        create: {
          userId,
          firstLoginAt: new Date(),
          lastLoginAt: new Date(),
          totalLogins: 1,
        },
        update: {
          lastLoginAt: new Date(),
          totalLogins: (analytics?.totalLogins || 0) + 1,
          firstLoginAt: analytics?.firstLoginAt || new Date(),
        },
      });
    } catch (error) {
      console.error(`❌ Failed to track login:`, error);
    }
  }

  static async trackDashboardVisit(userId: string) {
    try {
      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          dashboardVisits: {
            increment: 1,
          },
        },
      });
    } catch (error) {
      console.error(`❌ Failed to track dashboard visit:`, error);
    }
  }

  static async trackBlogViewed(userId: string) {
    try {
      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          blogsViewed: {
            increment: 1,
          },
        },
      });
    } catch (error) {
      console.error(`❌ Failed to track blog viewed:`, error);
    }
  }

  static async trackKeywordsViewed(userId: string) {
    try {
      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          keywordsViewed: {
            increment: 1,
          },
        },
      });
    } catch (error) {
      console.error(`❌ Failed to track keywords viewed:`, error);
    }
  }

  static async trackFirstBlogGenerated(userId: string) {
    try {
      const analytics = await prisma.trialAnalytics.findUnique({
        where: { userId },
      });

      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          firstBlogGeneratedAt: analytics?.firstBlogGeneratedAt || new Date(),
          totalBlogsGenerated: {
            increment: 1,
          },
        },
      });
      console.log(`✅ Tracked first blog generated for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track first blog generated:`, error);
    }
  }

  static async trackKeywordsGenerated(userId: string, count: number) {
    try {
      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          totalKeywordsGenerated: count,
        },
      });
      console.log(`✅ Tracked ${count} keywords generated for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track keywords generated:`, error);
    }
  }

  static async trackUpgradeCTAClicked(userId: string) {
    try {
      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          upgradeCTAClicked: {
            increment: 1,
          },
        },
      });
    } catch (error) {
      console.error(`❌ Failed to track upgrade CTA clicked:`, error);
    }
  }

  static async trackPricingPageVisited(userId: string) {
    try {
      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          pricingPageVisited: {
            increment: 1,
          },
        },
      });
    } catch (error) {
      console.error(`❌ Failed to track pricing page visited:`, error);
    }
  }

  static async trackCheckoutStarted(userId: string) {
    try {
      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          checkoutStarted: true,
        },
      });
      console.log(`✅ Tracked checkout started for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track checkout started:`, error);
    }
  }

  static async trackConversion(userId: string) {
    try {
      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          converted: true,
          convertedAt: new Date(),
          checkoutCompletedAt: new Date(),
          trialOutcome: "converted",
        },
      });
      console.log(`✅ Tracked conversion for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track conversion:`, error);
    }
  }

  static async trackTrialExpired(userId: string) {
    try {
      await prisma.trialAnalytics.update({
        where: { userId },
        data: {
          trialEndedAt: new Date(),
          trialOutcome: "expired",
        },
      });
      console.log(`✅ Tracked trial expired for user ${userId}`);
    } catch (error) {
      console.error(`❌ Failed to track trial expired:`, error);
    }
  }

  static async trackEmailSent(
    userId: string,
    emailType: "welcome" | "firstBlog" | "blogGenerated" | "topKeywords" | "expiring" | "expired",
  ) {
    try {
      const updateData: Record<string, boolean> = {};

      switch (emailType) {
        case "welcome":
          updateData.welcomeEmailSent = true;
          break;
        case "firstBlog":
          updateData.firstBlogEmailSent = true;
          break;
        case "blogGenerated":
        case "topKeywords":
          break;
        case "expiring":
          updateData.expiringEmailSent = true;
          break;
        case "expired":
          updateData.expiredEmailSent = true;
          break;
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.trialAnalytics.update({
          where: { userId },
          data: updateData,
        });
      }
    } catch (error) {
      console.error(`❌ Failed to track email sent:`, error);
    }
  }

  static async getTrialAnalytics(userId: string) {
    try {
      return await prisma.trialAnalytics.findUnique({
        where: { userId },
      });
    } catch (error) {
      console.error(`❌ Failed to get trial analytics:`, error);
      return null;
    }
  }

  static async getAllTrialAnalytics() {
    try {
      return await prisma.trialAnalytics.findMany({
        orderBy: {
          createdAt: "desc",
        },
      });
    } catch (error) {
      console.error(`❌ Failed to get all trial analytics:`, error);
      return [];
    }
  }

  static async getConversionMetrics() {
    try {
      const total = await prisma.trialAnalytics.count();
      const converted = await prisma.trialAnalytics.count({
        where: { converted: true },
      });
      const expired = await prisma.trialAnalytics.count({
        where: { trialOutcome: "expired" },
      });
      const active = await prisma.trialAnalytics.count({
        where: {
          trialEnrolledAt: { not: null },
          trialEndedAt: null,
        },
      });

      const conversionRate = total > 0 ? (converted / total) * 100 : 0;

      return {
        total,
        converted,
        expired,
        active,
        conversionRate: Math.round(conversionRate * 100) / 100,
      };
    } catch (error) {
      console.error(`❌ Failed to get conversion metrics:`, error);
      return null;
    }
  }

  static async getABTestResults(testGroup: string) {
    try {
      const variants = await prisma.trialAnalytics.groupBy({
        by: ["abTestVariant"],
        where: {
          abTestGroup: testGroup,
          abTestVariant: { not: null },
        },
        _count: {
          userId: true,
        },
        _sum: {
          upgradeCTAClicked: true,
        },
      });

      const conversions = await prisma.trialAnalytics.groupBy({
        by: ["abTestVariant"],
        where: {
          abTestGroup: testGroup,
          abTestVariant: { not: null },
          converted: true,
        },
        _count: {
          userId: true,
        },
      });

      return variants.map((variant) => {
        const conversionCount =
          conversions.find((c) => c.abTestVariant === variant.abTestVariant)?._count.userId || 0;
        const conversionRate = variant._count.userId > 0
          ? (conversionCount / variant._count.userId) * 100
          : 0;

        return {
          variant: variant.abTestVariant,
          totalUsers: variant._count.userId,
          conversions: conversionCount,
          conversionRate: Math.round(conversionRate * 100) / 100,
          avgCTAClicks: variant._sum.upgradeCTAClicked || 0,
        };
      });
    } catch (error) {
      console.error(`❌ Failed to get A/B test results:`, error);
      return [];
    }
  }
}
