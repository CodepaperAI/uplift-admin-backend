import { createPrismaClient } from "../config/prisma-client.factory";
import { PrismaClient } from "@prisma/client";

const prisma = createPrismaClient();

type AgencySeedConfig = {
  name: string;
  slug: string;
  domains: string[];
  ownershipType: "uplift_direct" | "agency_managed";
};

const AGENCY_SEEDS: AgencySeedConfig[] = [
  {
    name: "Uplift Direct",
    slug: "uplift-direct",
    domains: [
      "upliftai.co",
      "www.upliftai.co",
      "localhost:3000",
      "localhost:3001",
    ],
    ownershipType: "uplift_direct",
  },
  {
    name: "xMedia Agency",
    slug: "xmedia",
    domains: [
      "xmedia.upliftai.co",
      "www.xmedia.upliftai.co",
    ],
    ownershipType: "agency_managed",
  },
];

async function seedAgencies(): Promise<void> {
  console.log("Starting agency seed...");

  for (const config of AGENCY_SEEDS) {
    const existing = await prisma.agency.findUnique({
      where: { slug: config.slug },
    });

    if (existing) {
      console.log(`Agency "${config.name}" (slug: ${config.slug}) already exists, skipping creation.`);
    } else {
      await prisma.agency.create({
        data: {
          name: config.name,
          slug: config.slug,
          isActive: true,
        },
      });
      console.log(`Created agency "${config.name}" (slug: ${config.slug}).`);
    }

    const agency = await prisma.agency.findUnique({
      where: { slug: config.slug },
    });

    if (!agency) {
      console.error(`Failed to find agency "${config.name}" after creation attempt.`);
      continue;
    }

    for (const domain of config.domains) {
      const existingDomain = await prisma.agencyDomain.findUnique({
        where: { domain },
      });

      if (existingDomain) {
        if (existingDomain.agencyId !== agency.id) {
          console.warn(`Domain "${domain}" belongs to a different agency (${existingDomain.agencyId}), skipping.`);
        } else {
          console.log(`Domain "${domain}" already mapped to "${config.name}", skipping.`);
        }
        continue;
      }

      await prisma.agencyDomain.create({
        data: {
          agencyId: agency.id,
          domain,
          isPrimary: domain === config.domains[0],
        },
      });
      console.log(`Mapped domain "${domain}" to agency "${config.name}".`);
    }

    await prisma.agencyRevenueShareRule.upsert({
      where: {
        id: `${agency.id}-default-rule`,
      },
      create: {
        id: `${agency.id}-default-rule`,
        agencyId: agency.id,
        platformSharePercent: 60,
        agencySharePercent: 40,
        isActive: true,
      },
      update: {},
    });
    console.log(`Ensured default 60/40 revenue share rule for "${config.name}".`);
  }

  console.log("Agency seed completed.");
}

async function backfillBusinessesToUpliftDirect(): Promise<void> {
  console.log("Starting business backfill to Uplift Direct...");

  const upliftDirect = await prisma.agency.findUnique({
    where: { slug: "uplift-direct" },
  });

  if (!upliftDirect) {
    console.error("Uplift Direct agency not found. Run seed first.");
    return;
  }

  const unassignedCount = await prisma.business.count({
    where: { agencyId: null },
  });

  if (unassignedCount === 0) {
    console.log("No unassigned businesses found. Backfill already complete.");
    return;
  }

  console.log(`Found ${unassignedCount} businesses without an agency assignment.`);

  const result = await prisma.business.updateMany({
    where: { agencyId: null },
    data: {
      agencyId: upliftDirect.id,
      ownershipType: "uplift_direct",
    },
  });

  console.log(`Backfilled ${result.count} businesses to Uplift Direct.`);
}

async function backfillWebsiteSubscriptionsFromBusinesses(): Promise<void> {
  console.log("Starting website subscription agency backfill...");

  const websiteSubscriptions = await prisma.websiteSubscription.findMany({
    where: {
      OR: [
        { agencyId: null },
        {
          business: {
            agencyId: { not: null },
          },
        },
      ],
    },
    include: {
      business: {
        select: {
          agencyId: true,
        },
      },
    },
  });

  let updated = 0;

  for (const websiteSubscription of websiteSubscriptions) {
    const businessAgencyId = websiteSubscription.business.agencyId;
    if (!businessAgencyId || websiteSubscription.agencyId === businessAgencyId) {
      continue;
    }

    await prisma.websiteSubscription.update({
      where: { id: websiteSubscription.id },
      data: {
        agencyId: businessAgencyId,
      },
    });
    updated++;
  }

  console.log(`Backfilled ${updated} website subscriptions from business agency assignments.`);
}

async function reportAgencyAssignmentMismatches(): Promise<void> {
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

  console.log(
    `Website subscription mismatch scan completed: ${mismatches.length} potential mismatches remaining.`,
  );
}

async function main(): Promise<void> {
  try {
    await seedAgencies();
    await backfillBusinessesToUpliftDirect();
    await backfillWebsiteSubscriptionsFromBusinesses();
    await reportAgencyAssignmentMismatches();
    console.log("Seed and backfill completed successfully.");
  } catch (error: unknown) {
    console.error("Seed/backfill failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
