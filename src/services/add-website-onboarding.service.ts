import { prisma } from "../config/db.config";
import { queueWebsiteOnboardingEvent } from "../controllers/website.controller";

export async function ensureAddWebsiteOnboardingQueued(input: {
  businessId: string;
  stripeSubscriptionId: string;
}) {
  const business = await prisma.business.findFirst({
    where: {
      id: input.businessId,
      removalStatus: "active",
      websiteSubscription: {
        is: { stripeSubscriptionId: input.stripeSubscriptionId },
      },
    },
    select: {
      id: true,
      userId: true,
      businessWebsiteUrl: true,
      onboardingStatus: true,
    },
  });
  if (!business) {
    throw new Error("Website billing binding was not found");
  }
  if (
    ["queued", "running", "awaiting_confirmation", "completed"].includes(
      business.onboardingStatus,
    )
  ) {
    return { alreadyQueued: true, queued: false };
  }

  await queueWebsiteOnboardingEvent({
    userId: business.userId,
    businessId: business.id,
    websiteUrl: business.businessWebsiteUrl,
  });
  return { alreadyQueued: false, queued: true };
}
