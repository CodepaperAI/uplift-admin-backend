import { prisma } from "../config/db.config";

function inferOnboardingFlow(input: {
  isPrimary: boolean;
  websiteStatus: string | null;
}): "trial_primary" | "website_secondary" {
  if (input.isPrimary && input.websiteStatus === "trial") {
    return "trial_primary";
  }

  return "website_secondary";
}

function inferOnboardingStatus(input: {
  websiteStatus: string | null;
  hasWebsiteAnalysis: boolean;
}): "idle" | "failed" | "completed" {
  if (input.hasWebsiteAnalysis) {
    return "completed";
  }

  if (
    input.websiteStatus === "pending" ||
    input.websiteStatus === "failed" ||
    input.websiteStatus === "trial"
  ) {
    return "failed";
  }

  return "idle";
}

async function main() {
  const businesses = await prisma.business.findMany({
    select: {
      id: true,
      isPrimary: true,
      websiteStatus: true,
      updatedAt: true,
      onboardingFlow: true,
      onboardingStatus: true,
      onboardingCompletedAt: true,
      websiteAnalysis: {
        select: {
          id: true,
          createdAt: true,
        },
      },
    },
  });

  let updated = 0;

  for (const business of businesses) {
    const nextFlow =
      business.onboardingFlow ??
      inferOnboardingFlow({
        isPrimary: business.isPrimary,
        websiteStatus: business.websiteStatus,
      });
    const nextStatus = inferOnboardingStatus({
      websiteStatus: business.websiteStatus,
      hasWebsiteAnalysis: business.websiteAnalysis != null,
    });
    const nextCompletedAt =
      business.websiteAnalysis?.createdAt ??
      business.onboardingCompletedAt ??
      (nextStatus === "completed" ? business.updatedAt : null);
    const nextLastError =
      nextStatus === "failed" && business.websiteAnalysis == null
        ? {
            code: "legacy_backfill_requires_retry",
            stage: "backfill_business_onboarding_state",
            message:
              "Legacy onboarding record is incomplete and should be retried.",
          }
        : undefined;

    const needsUpdate =
      business.onboardingFlow !== nextFlow ||
      business.onboardingStatus !== nextStatus ||
      business.onboardingCompletedAt?.toISOString() !==
        nextCompletedAt?.toISOString();

    if (!needsUpdate && nextLastError === undefined) {
      continue;
    }

    await prisma.business.update({
      where: { id: business.id },
      data: {
        onboardingFlow: nextFlow,
        onboardingStatus: nextStatus,
        onboardingCompletedAt: nextCompletedAt,
        onboardingLastError:
          nextLastError === undefined
            ? undefined
            : (nextLastError as unknown as object),
      },
    });

    updated += 1;
  }

  console.log(
    JSON.stringify(
      {
        scanned: businesses.length,
        updated,
      },
      null,
      2,
    ),
  );
}

await main()
  .catch((error) => {
    console.error("[backfill-business-onboarding-state] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
