import { OnboardingStatus } from "@prisma/client";
import type { Response } from "express";
import { ZodError } from "zod";
import { prisma } from "../config/db.config";
import { PER_SITE_TRIALS_ENABLED } from "../config/feature-flags";
import { inngest } from "../inngest/client";
import { executeLLM } from "../llm/index.llm";
import type { AuthenticatedRequest } from "../middleware/require-backend-auth";
import { EmailService } from "../services/email.service";
import {
    handleValidationError,
    sendError,
    sendSuccess,
} from "../utils/response.utils";
import {
    ONBOARDING,
    ONBOARDING_WITH_WEBSITE,
} from "../validators/user.validations";

const emailService = new EmailService();
const COMPLETED_ONBOARDING_DESTINATION = "/dashboard/home" as const;

const DASHBOARD_WEBSITE_STATUSES = new Set(["trial", "active", "expired"]);
const DASHBOARD_ONBOARDING_STATUS_VALUES: OnboardingStatus[] = [
  OnboardingStatus.queued,
  OnboardingStatus.running,
  OnboardingStatus.awaiting_confirmation,
  OnboardingStatus.completed,
  OnboardingStatus.failed,
];
const DASHBOARD_ONBOARDING_STATUSES = new Set<OnboardingStatus>(
  DASHBOARD_ONBOARDING_STATUS_VALUES,
);

export async function getOnboardingEntryGuardStatus(
  req: AuthenticatedRequest,
  res: Response,
) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const [user, businesses, completedV2, unfinishedV2] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { onboarding: true } }),
      prisma.business.findMany({
        where: {
          userId,
          OR: [
            { isActive: true },
            { onboardingStatus: { in: DASHBOARD_ONBOARDING_STATUS_VALUES } },
          ],
        },
        select: {
          businessWebsiteUrl: true,
          isActive: true,
          onboardingStatus: true,
          websiteStatus: true,
        },
      }),
      prisma.quickScrapeBusiness.findFirst({
        where: {
          userId,
          onboardingV2Flow: "trial_primary",
          OR: [{ onboardingV2Status: "completed" }, { onboardingV2CompletedAt: { not: null } }],
        },
        select: { id: true },
      }),
      prisma.quickScrapeBusiness.findFirst({
        where: {
          userId,
          onboardingV2Flow: "trial_primary",
          onboardingV2LastSeenAt: { not: null },
          onboardingV2Status: { in: ["in_progress", "preview_ready", "awaiting_payment"] },
        },
        select: { id: true },
        orderBy: [{ onboardingV2LastSeenAt: "desc" }, { updatedAt: "desc" }],
      }),
    ]);

    const acceptedBusiness = businesses.some((business) =>
      Boolean(business.businessWebsiteUrl?.trim()) &&
      business.onboardingStatus != null &&
      DASHBOARD_ONBOARDING_STATUSES.has(business.onboardingStatus),
    );
    const dashboardAccess = businesses.some((business) => {
      if (!business.businessWebsiteUrl?.trim()) return false;
      if (business.onboardingStatus && DASHBOARD_ONBOARDING_STATUSES.has(business.onboardingStatus)) return true;
      return business.isActive &&
        (business.websiteStatus == null || DASHBOARD_WEBSITE_STATUSES.has(business.websiteStatus));
    });
    const shouldRedirect = unfinishedV2
      ? false
      : Boolean(
          user?.onboarding || completedV2 || acceptedBusiness || dashboardAccess,
        );
    return sendSuccess(res, {
      shouldRedirect,
      redirectTo: shouldRedirect ? COMPLETED_ONBOARDING_DESTINATION : null,
    });
  } catch (error) {
    return sendError(res, "Request could not be completed", 500);
  }
}

type OnboardingState = "queued" | "processing" | "completed" | "trial" | "failed" | "expired" | "none";

export function websiteOnboardingState(onboardingStatus?: string | null, websiteStatus?: string | null): OnboardingState {
  if (onboardingStatus === "queued") return "queued";
  if (onboardingStatus === "running") return "processing";
  if (onboardingStatus === "failed") return "failed";
  if (onboardingStatus === "completed") return websiteStatus === "trial" ? "trial" : "completed";
  const mapping: Record<string, OnboardingState> = {
    pending: "queued",
    processing: "processing",
    active: "completed",
    trial: "trial",
    trialing: "trial",
    failed: "failed",
    expired: "expired",
    canceled: "failed",
    cancelled: "failed",
    converted: "completed",
  };
  return mapping[websiteStatus ?? ""] ?? "none";
}

export async function getUserOnboardingStatus(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) return sendError(res, "Unauthorized", 401);
    const businesses = await prisma.business.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        businessName: true,
        businessWebsiteUrl: true,
        websiteStatus: true,
        onboardingStatus: true,
        onboardingLastError: true,
        keywordGenerationStatus: true,
      },
      orderBy: { createdAt: "desc" },
    });
    const websites = businesses.map((business) => ({
      businessId: business.id,
      businessName: business.businessName || "",
      websiteUrl: business.businessWebsiteUrl || "",
      state: websiteOnboardingState(business.onboardingStatus, business.websiteStatus),
      onboardingStatus: business.onboardingStatus,
      onboardingLastError: business.onboardingLastError,
      keywordGenerationStatus: business.keywordGenerationStatus,
    }));
    return sendSuccess(res, {
      hasActiveWebsite: websites.some(({ state }) => state === "completed" || state === "trial"),
      websites,
      pendingCount: websites.filter(({ state }) => state === "queued" || state === "processing").length,
      failedCount: websites.filter(({ state }) => state === "failed").length,
      trialCount: websites.filter(({ state }) => state === "trial").length,
      expiredCount: websites.filter(({ state }) => state === "expired").length,
    });
  } catch (error) {
    return sendError(res, "Request could not be completed", 500);
  }
}

export async function OnboardingCompleted(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return sendError(res, "Unauthorized access", 401);
    }

    await prisma.user.update({
      where: { id: userId },
      data: { onboarding: true },
    });

    return sendSuccess(res, null, "Onboarding completed successfully");
  } catch (error) {
    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to complete onboarding", 500, error);
  }
}

export async function completeOnboardingWithWebsite(
  req: AuthenticatedRequest,
  res: Response
) {
  try {
    const userId = req.authUserId;
    if (!userId) {
      return sendError(res, "Unauthorized", 401);
    }

    const body = req.body;
    const payload = ONBOARDING_WITH_WEBSITE.parse(body);

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        Subscription: true,
      },
    });

    if (!user) {
      return sendError(res, "User not found", 404);
    }

    // Check for active subscription OR trial (required for onboarding)
    // Can be disabled via SKIP_SUBSCRIPTION_CHECK=true in .env for testing
    const skipSubscriptionCheck = process.env.SKIP_SUBSCRIPTION_CHECK === "true";
    
    if (!skipSubscriptionCheck) {
      const subscription = user.Subscription;
      const hasActiveSubscription = subscription && (subscription.status === "active" || subscription.status === "trialing");
      const hasActiveTrial = user.trialStatus === "active" && user.trialEndDate && user.trialEndDate > new Date();

      let hasWebsiteLevelAccess = false;
      if (!hasActiveSubscription && !hasActiveTrial) {
        const now = new Date();
        const businesses = await prisma.business.findMany({
          where: { userId, isActive: true },
          include: { websiteSubscription: true },
        });
        hasWebsiteLevelAccess = businesses.some((b) => {
          const ws = b.websiteSubscription;
          return ws && (ws.status === "active" || (ws.trialStatus === "trialing" && ws.trialEndDate && ws.trialEndDate > now));
        });
      }

      if (!hasActiveSubscription && !hasActiveTrial && !hasWebsiteLevelAccess) {
        return res.status(402).json({
          success: false,
          error: "SUBSCRIPTION_OR_TRIAL_REQUIRED",
          message: "An active subscription or trial is required to add a website. Please subscribe or start a trial to continue.",
        });
      }
    }

    // Check if user already has businesses
    const existingBusinesses = await prisma.business.findMany({
      where: { userId },
    });

    // Allow multiple websites, but check if this specific URL already exists
    // Exception: Allow if the existing business is from quick scrape (trial status)
    const existingBusinessWithUrl = existingBusinesses.find(
      (b) => b.businessWebsiteUrl === payload.websiteUrl && b.websiteStatus !== "trial"
    );

    if (existingBusinessWithUrl) {
      return sendError(res, "This website already exists for this user", 400);
    }

    // Preserve any trial business so we can move its WebsiteSubscription to the
    // analyzed business instead of deleting the entitlement row first.
    const trialBusiness = existingBusinesses.find(
      (b) => b.businessWebsiteUrl === payload.websiteUrl && b.websiteStatus === "trial"
    );

    // Execute LLM to scrape and extract all data
    // This will create the business with all extracted information
    // NOTE: Keywords and competitors are extracted by LLM only (no DataForSEO validation for faster onboarding)
    // Rankings are still fetched from DataForSEO for accuracy
    let persistedBusinessId: string | null = null;
    try {
      console.log(
        `🔄 Starting LLM analysis for user ${userId}, website: ${payload.websiteUrl}`
      );
      const llmResult = await executeLLM({
        websiteUrl: payload.websiteUrl,
        userId,
        preferredBusinessId: trialBusiness?.id ?? null,
        correlationId:
          "correlationId" in req &&
          typeof (req as { correlationId?: unknown }).correlationId === "string"
            ? (req as { correlationId: string }).correlationId
            : undefined,
        onboardingFlow: trialBusiness ? "trial_primary" : undefined,
      });
      console.log(`✅ LLM analysis completed for user ${userId}`);
      persistedBusinessId = llmResult.businessId;
    } catch (llmError: any) {
      console.error(
        `❌ LLM analysis failed for user ${userId}:`,
        llmError
      );
      return sendError(
        res,
        "Failed to analyze website. Please try again or contact support if the issue persists.",
        500,
        llmError
      );
    }

    // Verify business was created successfully
    const business = persistedBusinessId
      ? await prisma.business.findUnique({
          where: { id: persistedBusinessId },
        })
      : null;

    if (!business) {
      console.error(
        `❌ Business was not created after LLM analysis for user ${userId}`
      );
      return sendError(
        res,
        "Failed to create business profile. Please try again or contact support.",
        500
      );
    }

    const accountTrialEnd =
      user.trialEndDate ?? user.Subscription?.currentPeriodEnd ?? null;
    const hasActiveTrial =
      PER_SITE_TRIALS_ENABLED &&
      (user.Subscription?.status === "trialing" || user.trialStatus === "active") &&
      (!accountTrialEnd || accountTrialEnd > new Date());

    if (trialBusiness && trialBusiness.id !== business.id) {
      const trialWebsiteSubscription =
        await prisma.websiteSubscription.findUnique({
          where: { businessId: trialBusiness.id },
        });
      const existingWebsiteSubscription =
        await prisma.websiteSubscription.findUnique({
          where: { businessId: business.id },
        });

      if (trialWebsiteSubscription && !existingWebsiteSubscription) {
        await prisma.websiteSubscription.update({
          where: { id: trialWebsiteSubscription.id },
          data: { businessId: business.id },
        });
      }

      await prisma.business.delete({
        where: { id: trialBusiness.id },
      });
    }

    if (PER_SITE_TRIALS_ENABLED && hasActiveTrial) {
      const trialStartDate =
        user.trialStartDate ?? user.Subscription?.startDate ?? new Date();
      const trialEndDate =
        accountTrialEnd ??
        (() => {
          const fallback = new Date();
          fallback.setDate(fallback.getDate() + 7);
          return fallback;
        })();

      await prisma.websiteSubscription.upsert({
        where: { businessId: business.id },
        create: {
          businessId: business.id,
          status: "trialing",
          trialStartDate,
          trialEndDate,
          trialStatus: "trialing",
        },
        update: {
          status: "trialing",
          trialStartDate,
          trialEndDate,
          trialStatus: "trialing",
          currentPeriodStart: null,
          currentPeriodEnd: null,
        },
      });
    }

    const businessWebsiteSubscription = await prisma.websiteSubscription.findUnique({
      where: { businessId: business.id },
      select: {
        status: true,
        trialStatus: true,
        trialEndDate: true,
      },
    });
    const now = new Date();
    const hasActiveWebsiteTrial = Boolean(
      businessWebsiteSubscription &&
        businessWebsiteSubscription.trialStatus === "trialing" &&
        (!businessWebsiteSubscription.trialEndDate ||
          businessWebsiteSubscription.trialEndDate > now),
    );
    const hasPaidWebsiteSubscription = Boolean(
      businessWebsiteSubscription &&
        businessWebsiteSubscription.status === "active" &&
        businessWebsiteSubscription.trialStatus !== "trialing" &&
        businessWebsiteSubscription.trialStatus !== "expired",
    );
    const targetWebsiteStatus = hasActiveWebsiteTrial
      ? "trial"
      : hasPaidWebsiteSubscription
        ? "active"
        : "pending";

    // Mark as primary if this is the first website
    const isFirstWebsite = existingBusinesses.length === 0;
    
    // Ensure website is active and has the correct entitlement-driven status.
    await prisma.business.update({
      where: { id: business.id },
      data: {
        isPrimary: isFirstWebsite,
        isActive: hasActiveWebsiteTrial || hasPaidWebsiteSubscription,
        websiteStatus: targetWebsiteStatus,
      },
    });

    console.log(
      `✅ Business created successfully for user ${userId}: ${business.id}`
    );

    // 🆕 Trigger sitemap discovery in the background (non-blocking)
    try {
      await inngest.send({
        name: "sitemap/discover",
        data: {
          userId: userId,
          websiteUrl: payload.websiteUrl,
          businessId: business.id,
        },
      });
      console.log(
        `✅ Sitemap discovery triggered in background for user ${userId}, business ${business.id}`
      );
    } catch (sitemapError) {
      // Don't fail onboarding if sitemap task fails to start
      console.error(
        "⚠️ Failed to trigger sitemap discovery task:",
        sitemapError
      );
    }

    // Mark onboarding as complete only if this is the first website
    if (isFirstWebsite) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          onboarding: true,
        },
      });

      // Send welcome email and onboarding complete email for first website
      try {
        await emailService.sendWelcomeEmail({
          userName: user.name || "there",
          userEmail: user.email,
        });

        await emailService.sendOnboardingCompleteEmail({
          userName: user.name || "there",
          userEmail: user.email,
          businessName: business.businessName || "Your Business",
          websiteUrl: business.businessWebsiteUrl || payload.websiteUrl,
        });
      } catch (emailError) {
        console.error("⚠️ Failed to send welcome/onboarding emails:", emailError);
      }
    }

    try {
      if (business) {
        await prisma.business.update({
          where: { id: business.id },
          data: {
            keywordGenerationStatus: "pending",
            keywordGenerationStartedAt: null,
            keywordGenerationCompletedAt: null,
          },
        });

        await inngest.send({
          name: "keywords/generate",
          data: {
            userId: userId,
            businessId: business.id,
          },
        });

        console.log(
          `✅ Onboarding complete. Keyword generation started for user ${userId}, business ${business.id}`
        );
        console.log(
          `ℹ️ First blog will be generated automatically after keywords are ready for business ${business.id}`
        );
      } else {
        console.warn(
          `⚠️ Business not found for user ${userId}, skipping keyword generation`
        );
      }
    } catch (keywordError) {
      // Don't fail onboarding if keyword generation fails to start
      console.error(
        "❌ Failed to start keyword generation after onboarding:",
        keywordError
      );
      // Continue with successful onboarding response
    }

    return sendSuccess(
      res,
      { websiteUrl: payload.websiteUrl },
      "Onboarding completed successfully. All business information has been extracted and saved. Keyword plan generation has been started."
    );
  } catch (error) {
    console.error("Onboarding error:", error);

    if (error instanceof ZodError) {
      return handleValidationError(res, error);
    }

    return sendError(res, "Failed to complete onboarding", 500, error);
  }
}
