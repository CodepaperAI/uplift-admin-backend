import { prisma } from "../config/db.config";
import { inngest } from "../inngest/client";
import {
  markInitialSocialTopicPlanFailed,
  markInitialSocialTopicPlanQueued,
} from "./social-topic-initialization.service";

export type BillingSocialInitializationResult = {
  businessId: string;
  status: "queued" | "ready" | "failed";
  message: string | null;
};

async function dispatchForBusiness(
  userId: string,
  businessId: string,
): Promise<BillingSocialInitializationResult> {
  try {
    const existing = await prisma.socialAutomationSettings.findUnique({
      where: { businessId },
      select: { initialPlanGeneratedAt: true },
    });
    if (existing?.initialPlanGeneratedAt) {
      return { businessId, status: "ready", message: null };
    }

    await markInitialSocialTopicPlanQueued(prisma, businessId);
    const queued = await inngest.send({
      name: "social/topics.plan.requested",
      data: { userId, businessId, source: "INITIAL" },
    });
    if (!queued.ids?.length) throw new Error("Social planning was not queued");
    return { businessId, status: "queued", message: null };
  } catch (error) {
    await markInitialSocialTopicPlanFailed(prisma, businessId, error).catch(
      (markError) => {
        console.error(
          "[billing] could not record social planning failure for " + businessId,
          markError,
        );
      },
    );
    console.error(
      "[billing] initial social planning failed for " + businessId,
      error,
    );
    return {
      businessId,
      status: "failed",
      message: "Social planning will retry in the background.",
    };
  }
}

export async function dispatchInitialSocialPlanningForEligibleWebsites(
  userId: string,
): Promise<BillingSocialInitializationResult[]> {
  const businesses = await prisma.business.findMany({
    where: {
      userId,
      isActive: true,
      websiteStatus: "active",
      OR: [
        { onboardingStatus: "completed" },
        { websiteAnalysis: { isNot: null } },
      ],
      websiteSubscription: {
        is: {
          planTier: "SEO_SOCIAL",
          status: { in: ["active", "trialing"] },
        },
      },
    },
    select: { id: true },
  });

  return Promise.all(
    businesses.map((business) => dispatchForBusiness(userId, business.id)),
  );
}
