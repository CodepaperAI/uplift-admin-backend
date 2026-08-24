import { createPrismaClient } from "../config/prisma-client.factory";
import { PrismaClient } from "@prisma/client";

const token = process.argv[2]?.trim();
if (!token) throw new Error("Usage: diagnose-rewardful-link.ts <affiliate-token>");

const prisma = createPrismaClient();

try {
  const [matches, attributionCount, webhookCount, latestWebhook] = await Promise.all([
    prisma.rewardfulAttribution.findMany({
      where: {
        OR: [
          { via: { equals: token, mode: "insensitive" } },
          { affiliateToken: { equals: token, mode: "insensitive" } },
          { landingUrl: { contains: `via=${token}`, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        referralId: true,
        via: true,
        affiliateId: true,
        affiliateToken: true,
        affiliateName: true,
        campaignId: true,
        campaignName: true,
        landingUrl: true,
        capturedAt: true,
        lastSeenAt: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        conversionTrackedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.rewardfulAttribution.count(),
    prisma.rewardfulWebhookEvent.count(),
    prisma.rewardfulWebhookEvent.findFirst({
      select: {
        eventType: true,
        processingStatus: true,
        receivedAt: true,
        processedAt: true,
      },
      orderBy: { receivedAt: "desc" },
    }),
  ]);

  const referralIds = matches
    .map((match) => match.referralId)
    .filter((value): value is string => Boolean(value));
  const affiliateIds = matches
    .map((match) => match.affiliateId)
    .filter((value): value is string => Boolean(value));
  const matchingWebhooks = await prisma.rewardfulWebhookEvent.findMany({
    where: {
      OR: [
        ...(referralIds.length ? [{ referralId: { in: referralIds } }] : []),
        ...(affiliateIds.length ? [{ affiliateId: { in: affiliateIds } }] : []),
      ],
    },
    select: {
      eventType: true,
      referralId: true,
      affiliateId: true,
      processingStatus: true,
      processingError: true,
      receivedAt: true,
      processedAt: true,
    },
    orderBy: { receivedAt: "desc" },
    take: 20,
  });

  console.log(
    JSON.stringify(
      {
        token,
        matchingAttributions: matches.length,
        matches,
        matchingWebhooks,
        systemTotals: { attributionCount, webhookCount, latestWebhook },
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}
