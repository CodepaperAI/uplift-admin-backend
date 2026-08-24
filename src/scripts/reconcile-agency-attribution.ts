import { createPrismaClient } from "../config/prisma-client.factory";
import { PrismaClient } from "@prisma/client";

const prisma = createPrismaClient();
const shouldFix = process.argv.includes("--fix");

async function main(): Promise<void> {
  const businessesWithoutAgency = await prisma.business.count({
    where: { agencyId: null },
  });

  const subscriptionsWithoutAgency = await prisma.websiteSubscription.count({
    where: {
      business: {
        agencyId: { not: null },
      },
      agencyId: null,
    },
  });

  const subscriptions = await prisma.websiteSubscription.findMany({
    include: {
      business: {
        select: {
          agencyId: true,
        },
      },
    },
  });

  const mismatches = subscriptions.filter(
    (subscription) =>
      subscription.business.agencyId !== null &&
      subscription.agencyId !== subscription.business.agencyId,
  );

  console.log("Agency attribution reconciliation");
  console.log(`- businesses without agency: ${businessesWithoutAgency}`);
  console.log(`- website subscriptions without agency: ${subscriptionsWithoutAgency}`);
  console.log(`- business/subscription agency mismatches: ${mismatches.length}`);

  if (!shouldFix) {
    return;
  }

  let fixed = 0;

  for (const subscription of mismatches) {
    if (!subscription.business.agencyId) continue;

    await prisma.websiteSubscription.update({
      where: { id: subscription.id },
      data: {
        agencyId: subscription.business.agencyId,
      },
    });
    fixed++;
  }

  const unassignedSubscriptions = subscriptions.filter(
    (subscription) =>
      subscription.agencyId === null && subscription.business.agencyId !== null,
  );

  for (const subscription of unassignedSubscriptions) {
    if (!subscription.business.agencyId) continue;

    await prisma.websiteSubscription.update({
      where: { id: subscription.id },
      data: {
        agencyId: subscription.business.agencyId,
      },
    });
    fixed++;
  }

  console.log(`- fixed website subscription records: ${fixed}`);
}

main()
  .catch((error) => {
    console.error("Agency attribution reconciliation failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
