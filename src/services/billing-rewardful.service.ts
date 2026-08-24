import { prisma } from "../config/db.config";

export async function recordRewardfulConversionPreparedForUser(input: {
  conversionEmail?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  userId: string;
}) {
  const attribution = await prisma.rewardfulAttribution.findUnique({
    where: { userId: input.userId },
    select: { userId: true },
  });
  if (!attribution) return null;

  return prisma.rewardfulAttribution.update({
    where: { userId: input.userId },
    data: {
      ...(input.conversionEmail
        ? { conversionEmail: input.conversionEmail }
        : {}),
      ...(input.stripeCustomerId
        ? { stripeCustomerId: input.stripeCustomerId }
        : {}),
      ...(input.stripeSubscriptionId
        ? { stripeSubscriptionId: input.stripeSubscriptionId }
        : {}),
      conversionTrackedAt: new Date(),
      lastSeenAt: new Date(),
    },
  });
}
