import type { PrismaClient } from "@prisma/client";
import type Stripe from "stripe";

type CompensateParams = {
  prisma: PrismaClient;
  stripe: Stripe;
  businessId: string;
  userId: string;
  stripeSubscriptionItemId: string | null;
  decrementWebsiteCount: boolean;
  markFailed: boolean;
  correlationId?: string;
};

export async function compensateWebsiteOnboardFailure(
  params: CompensateParams,
): Promise<void> {
  const {
    prisma,
    stripe,
    businessId,
    userId,
    stripeSubscriptionItemId,
    decrementWebsiteCount,
    markFailed,
    correlationId,
  } = params;

  const logPrefix = `[Compensate] correlationId=${correlationId ?? "none"} businessId=${businessId}`;

  if (stripeSubscriptionItemId) {
    try {
      await stripe.subscriptionItems.del(stripeSubscriptionItemId);
      console.log(`${logPrefix} Stripe subscription item deleted`);
    } catch (err) {
      console.error(`${logPrefix} Failed to delete Stripe subscription item:`, err);
    }
  }

  try {
    await prisma.websiteSubscription.deleteMany({
      where: { businessId },
    });
  } catch (err) {
    console.error(`${logPrefix} Failed to delete websiteSubscription:`, err);
  }

  if (decrementWebsiteCount) {
    try {
      const subscription = await prisma.subscription.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      if (subscription && (subscription.websiteCount ?? 0) > 0) {
        await prisma.subscription.update({
          where: { id: subscription.id },
          data: { websiteCount: { decrement: 1 } },
        });
        console.log(`${logPrefix} websiteCount decremented`);
      }
    } catch (err) {
      console.error(`${logPrefix} Failed to decrement websiteCount:`, err);
    }
  }

  if (markFailed) {
    try {
      await prisma.business.update({
        where: { id: businessId },
        data: { websiteStatus: "failed" },
      });
      console.log(`${logPrefix} business marked failed`);
    } catch {
      // business may have been merged/deleted
    }
  }
}
